/**
 * control.ts — HTTP control server for headless/automated interaction.
 *
 * Runs on CONTROL_PORT (default 7777) when CONTROL=1 env is set.
 * Exposes imperative actions: tab navigation, message sending, perf dumps,
 * key injection, and DOM queries for automated testing.
 *
 * Usage:
 *   CONTROL=1 bun run dev              # start with control server
 *   curl localhost:7777/status          # get app state
 *   curl localhost:7777/tab/3           # switch to Sessions tab
 *   curl -X POST localhost:7777/send -d '{"message":"hello"}'
 *   curl -X POST localhost:7777/key -d '{"name":"tab"}'
 *   curl localhost:7777/focus           # get focus tree
 *   curl localhost:7777/perf            # dump perf report
 *
 * The bridge is set by AppInner via control.setBridge({...}).
 *
 * SAFETY: Key injection is blocked for keys that would mutate state
 * on dangerous tabs (Config, Sessions) unless safe=false is passed.
 *
 * BIND: Binds 127.0.0.1 by default so a laptop on a hostile LAN / café
 * wifi doesn't expose /send or /key to the network. Override with
 * CONTROL_BIND for intentional cross-host use (VM host testing the
 * guest's TUI); anything other than loopback surfaces a warning banner
 * on startup so the exposure is never silent.
 */

import * as perf from "../utils/perf"
import { TABS, TAB_MAX, CHAT_TAB } from "../app/tabs"

const PORT = Number(process.env.CONTROL_PORT) || 7777
const BIND = process.env.CONTROL_BIND || "127.0.0.1"
export const enabled = process.env.CONTROL === "1"

// Hostnames that keep the control server reachable only from this machine.
// `localhost` resolves to loopback on every sane system; anything else
// (including 0.0.0.0, ::, and explicit external IPs) is treated as exposed.
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host)
}

export type Warning = {
  host: string
  port: number
  message: string
}

// Computes the exposure warning for an arbitrary (enabled, bind, port)
// triple so tests can exercise the decision without re-importing the
// module under different env. `warning()` uses the process env values
// captured at module load.
export function warningFor(on: boolean, bind: string, port: number): Warning | null {
  if (!on) return null
  if (isLoopback(bind)) return null
  return {
    host: bind,
    port,
    message: `CONTROL server bound to ${bind}:${port} — reachable from the network. Set CONTROL_BIND=127.0.0.1 to restrict to loopback.`,
  }
}

export function warning(): Warning | null {
  return warningFor(enabled, BIND, PORT)
}

const TAB_NAMES: readonly string[] = TABS.map(t => t.name)

type Bridge = {
  tab: () => number
  setTab: (n: number) => void
  send: (msg: string) => Promise<void>
  ready: () => boolean
  streaming: () => boolean
  messages: () => number
  session: () => string
  input: () => string
  setInput: (v: string) => void
  focusRegion: () => "input" | "content"
  setFocusRegion: (r: "input" | "content") => void
  renderer: () => unknown // OpenTUI renderer instance
  logs: (n?: number) => string
  plugin: (id: string, on: boolean) => Promise<boolean>
  push: (ev: { type: string; payload?: unknown }) => void
}

let bridge: Bridge | null = null
let pendingTab: number | null = null
let pendingSend = false

export function setBridge(b: Bridge) {
  bridge = b
}

function currentTab(): number {
  if (pendingTab !== null) return pendingTab
  return bridge?.tab() ?? 0
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })

// Keys that can mutate state on specific tabs. Derived from TAB_NAMES at
// module load — hardcoded indexes drift every time a tab is inserted.
// Throws if a named tab is missing so the app refuses to start with a
// broken safety table rather than silently leaving Chat's Enter unguarded.
//
// The top-level tabs are now groups that host multiple sub-tabs (e.g.
// "Config" hosts Config/Skills/Toolsets/Env/Memory). Since control.ts
// only sees the top-level tab, the guarded key set for a group is the
// UNION of every sub-tab's dangerous keys — err on the side of requiring
// safe=false when a sub-tab could mutate. Acceptable: Skills/Memory
// don't mutate on plain return, so only the worst-case sub-tab matters.
const idx = (name: string) => {
  const n = TAB_NAMES.indexOf(name)
  if (n < 0) throw new Error(`control.ts DANGEROUS: tab '${name}' missing from TAB_NAMES`)
  return n
}
const DANGEROUS: Record<number, Set<string>> = {
  [idx("Chat")]:                   new Set(["return"]),                         // Enter sends message
  // Sessions sub-tab: d/delete/return; Context/Analytics sub-tabs: no mutations.
  [idx("Sessions")]:               new Set(["d", "delete", "return"]),
  // Profiles sub-tab: k (kill subagent), d (delete). Cron sub-tab: return, space,
  // d/delete. Kanban sub-tab: d/delete, return (activate/start).
  [idx("Profiles & Automation")]:  new Set(["return", "space", "d", "delete", "k"]),
  // Config sub-tab: space, return, h, l, ]/[, ctrl+s. Env sub-tab:
  // return, space, d/delete. Toolsets/Skills/Memory: space for toggles.
  [idx("Config")]:                 new Set(["space", "return", "h", "l", "]", "[", "ctrl+s", "d", "delete"]),
  // Library sub-tab: return activates, n creates, d/delete removes, s/u share/update.
  // Catalog sub-tab: return installs/uses, d/delete removes via modal.
  // Studio sub-tab: return edits, u submits, ctrl+s saves, ctrl+u saves and uses.
  [idx("Eikon")]:                  new Set(["return", "n", "d", "delete", "s", "u", "ctrl+s", "ctrl+u"]),
}

export function isDangerous(tab: number, keyName: string, ctrl: boolean): boolean {
  const set = DANGEROUS[tab]
  if (!set) return false
  const id = ctrl ? `ctrl+${keyName}` : keyName
  return set.has(id)
}

interface ParsedKey {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  sequence: string
  number: boolean
  raw: string
  eventType: "press" | "release"
  source: "raw" | "kitty"
  repeated?: boolean
}

function makeKey(opts: {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  raw?: string
}): ParsedKey {
  return {
    name: opts.name,
    ctrl: opts.ctrl ?? false,
    meta: opts.meta ?? false,
    shift: opts.shift ?? false,
    option: false,
    sequence: opts.raw ?? opts.name,
    number: false,
    raw: opts.raw ?? opts.name,
    eventType: "press",
    source: "raw",
  }
}

function injectKey(renderer: unknown, key: ParsedKey): boolean {
  const r = renderer as { keyInput?: { processParsedKey?: (k: ParsedKey) => boolean } }
  if (!r?.keyInput?.processParsedKey) return false
  return r.keyInput.processParsedKey(key)
}

interface FocusNode {
  type: string
  focused: boolean
  focusable: boolean
  children: FocusNode[]
  text?: string
}

type AnyNode = {
  constructor?: { name?: string }
  focused?: boolean
  focusable?: boolean
  getChildren?: () => AnyNode[]
  getChildrenCount?: () => number
  _childrenInLayoutOrder?: AnyNode[]
  textContent?: string
  text?: string
  value?: string
  id?: string
  _type?: string
  tagName?: string
}

function getNodeChildren(n: AnyNode): AnyNode[] {
  if (n.getChildren) return n.getChildren()
  if (n._childrenInLayoutOrder) return [...n._childrenInLayoutOrder]
  return []
}

function getNodeType(n: AnyNode): string {
  return n._type || n.tagName || n.constructor?.name || "unknown"
}

function buildFocusTree(node: unknown, depth = 0): FocusNode | null {
  if (!node || typeof node !== "object") return null
  const n = node as AnyNode

  const type = getNodeType(n)
  const focused = n.focused ?? false
  const focusable = n.focusable ?? false
  const children: FocusNode[] = []

  if (depth < 20) {
    for (const child of getNodeChildren(n)) {
      const c = buildFocusTree(child, depth + 1)
      if (c) children.push(c)
    }
  }

  // Skip non-focusable nodes with no focusable descendants
  const hasFocusable = focusable || children.some(c =>
    c.focusable || c.focused || c.children.length > 0
  )
  if (!hasFocusable && !focused && depth > 0) return null

  const text = (n.value || n.textContent || n.text || undefined) as string | undefined

  return { type, focused, focusable, children, text }
}

function findFocused(node: unknown): string | null {
  if (!node || typeof node !== "object") return null
  const n = node as AnyNode
  if (n.focused) return getNodeType(n)
  for (const child of getNodeChildren(n)) {
    const found = findFocused(child)
    if (found) return found
  }
  return null
}

function countNodes(node: unknown): { total: number; focusable: number; focused: number } {
  const result = { total: 0, focusable: 0, focused: 0 }
  function walk(n: unknown) {
    if (!n || typeof n !== "object") return
    const nd = n as AnyNode
    result.total++
    if (nd.focusable) result.focusable++
    if (nd.focused) result.focused++
    for (const child of getNodeChildren(nd)) walk(child)
  }
  walk(node)
  return result
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  if (!bridge) return json({ error: "bridge not ready" }, 503)

  // GET /status — app state snapshot
  if (path === "/status") {
    const m = process.memoryUsage()
    const tab = currentTab()
    // Clear pending tab once React has had time to commit
    pendingTab = null
    return json({
      tab,
      tabName: TAB_NAMES[tab] ?? "unknown",
      ready: bridge.ready(),
      streaming: bridge.streaming(),
      messages: bridge.messages(),
      session: bridge.session(),
      input: bridge.input(),
      focusRegion: bridge.focusRegion(),
      rss: Math.round(m.rss / 1024 / 1024),
      heap: Math.round(m.heapUsed / 1024 / 1024),
    })
  }

  // GET /tab/:n — switch tab via the real key path (tab.next/prev is
  // alt+arrow → meta:true per chord.ts). Falls back to setTab() when
  // the renderer isn't ready yet.
  const tabMatch = path.match(/^\/tab\/(\d+)$/)
  if (tabMatch) {
    const n = Number(tabMatch[1])
    if (n < 0 || n > TAB_MAX) return json({ error: `tab 0-${TAB_MAX}` }, 400)

    const renderer = bridge.renderer()
    if (renderer) {
      const cur = bridge.tab()
      const diff = n - cur
      const key = makeKey({ name: diff > 0 ? "right" : "left", meta: true })
      for (let i = Math.abs(diff); i > 0; i--) injectKey(renderer, key)
    } else {
      bridge.setTab(n)
    }
    pendingTab = n
    return json({ tab: n, tabName: TAB_NAMES[n] })
  }

  // POST /send — send a message
  if (path === "/send" && req.method === "POST") {
    const body = await req.json() as { message?: string }
    if (!body.message) return json({ error: "message required" }, 400)
    if (!bridge.ready()) return json({ error: "not connected" }, 503)
    if (bridge.streaming()) return json({ error: "already streaming" }, 409)
    if (pendingSend) return json({ error: "send already pending" }, 409)
    pendingSend = true
    try {
      await bridge.send(body.message)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502)
    } finally {
      pendingSend = false
    }
    return json({ sent: true, message: body.message })
  }

  // POST /key — inject a key event
  //
  // Body: { name: "tab", ctrl?: bool, shift?: bool, meta?: bool, raw?: string, safe?: bool }
  //
  // safe (default true): blocks keys known to mutate state on current tab.
  // Set safe=false to override (use for intentional mutation testing).
  if (path === "/key" && req.method === "POST") {
    const body = await req.json() as {
      name?: string
      ctrl?: boolean
      shift?: boolean
      meta?: boolean
      raw?: string
      safe?: boolean
    }
    if (!body.name) return json({ error: "name required" }, 400)

    const renderer = bridge.renderer()
    if (!renderer) return json({ error: "renderer not available" }, 503)

    const safe = body.safe !== false // default true
    const tab = currentTab()

    if (safe && isDangerous(tab, body.name, !!body.ctrl)) {
      return json({
        error: "blocked",
        reason: `Key "${body.ctrl ? "ctrl+" : ""}${body.name}" is dangerous on tab ${TAB_NAMES[tab]} (index ${tab}). Pass safe=false to override.`,
        tab,
        tabName: TAB_NAMES[tab],
      }, 403)
    }

    const key = makeKey({
      name: body.name,
      ctrl: body.ctrl,
      shift: body.shift,
      meta: body.meta,
      raw: body.raw ?? (body.name.length === 1 ? body.name : ""),
    })

    const handled = injectKey(renderer, key)
    return json({ injected: true, handled, key: body.name, tab, tabName: TAB_NAMES[tab] })
  }

  // POST /keys — inject a sequence of key events
  //
  // Body: { keys: [{name, ctrl?, ...}, ...], delay?: number, safe?: bool }
  if (path === "/keys" && req.method === "POST") {
    const body = await req.json() as {
      keys?: Array<{ name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; raw?: string }>
      delay?: number
      safe?: boolean
    }
    if (!body.keys?.length) return json({ error: "keys array required" }, 400)

    const renderer = bridge.renderer()
    if (!renderer) return json({ error: "renderer not available" }, 503)

    const safe = body.safe !== false
    const tab = currentTab()
    const delay = body.delay ?? 0
    const results: Array<{ key: string; injected: boolean; handled: boolean; blocked?: boolean }> = []

    for (const k of body.keys) {
      if (safe && isDangerous(currentTab(), k.name, !!k.ctrl)) {
        results.push({ key: k.name, injected: false, handled: false, blocked: true })
        continue
      }
      const key = makeKey({
        name: k.name,
        ctrl: k.ctrl,
        shift: k.shift,
        meta: k.meta,
        raw: k.raw ?? (k.name.length === 1 ? k.name : ""),
      })
      const handled = injectKey(renderer, key)
      results.push({ key: k.name, injected: true, handled })
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
    }

    return json({ results, tab, tabName: TAB_NAMES[tab] })
  }

  // POST /type — inject a string as individual keystrokes
  //
  // Body: { text: "hello", safe?: bool, delay?: ms }
  // delay paces characters for cinematic typing (demo recordings).
  if (path === "/type" && req.method === "POST") {
    const body = await req.json() as { text?: string; safe?: boolean; delay?: number }
    if (!body.text) return json({ error: "text required" }, 400)

    const renderer = bridge.renderer()
    if (!renderer) return json({ error: "renderer not available" }, 503)

    const safe = body.safe !== false
    const tab = currentTab()
    const delay = body.delay ?? 0
    let count = 0

    for (const ch of body.text) {
      if (safe && isDangerous(tab, ch, false)) continue
      const key = makeKey({ name: ch, raw: ch })
      injectKey(renderer, key)
      count++
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
    }

    return json({ typed: count, total: body.text.length, tab, tabName: TAB_NAMES[tab] })
  }

  // POST /input — set composer value in one shot (no per-char keys).
  if (path === "/input" && req.method === "POST") {
    const body = await req.json() as { text?: string }
    bridge.setInput(body.text ?? "")
    return json({ ok: true, text: body.text ?? "" })
  }

  // GET /quit — clean exit so a recording PTY sees EOF. Macrotask so the
  // 200 flushes before the process dies.
  if (path === "/quit") {
    setTimeout(() => process.exit(0), 10)
    return json({ ok: true })
  }

  // GET /focus — focus tree (focusable elements and their state)
  if (path === "/focus") {
    const r = bridge.renderer() as {
      root?: unknown
      currentFocusedRenderable?: AnyNode | null
    } | null
    if (!r?.root) return json({ error: "no renderer root" }, 503)
    const counts = countNodes(r.root)
    const tree = buildFocusTree(r.root)
    const focused = findFocused(r.root)
    const currentFocus = r.currentFocusedRenderable
      ? getNodeType(r.currentFocusedRenderable)
      : null
    return json({ focused, currentFocus, counts, tree })
  }

  // GET /frame — current screen buffer as plain text. `?grep=pat` returns
  // only matching lines. `?json=1` wraps in {frame, match, lines}.
  if (path === "/frame") {
    const r = bridge.renderer() as {
      currentRenderBuffer?: { getRealCharBytes(nl: boolean): Uint8Array }
    } | null
    if (!r?.currentRenderBuffer) return json({ error: "no render buffer" }, 503)
    const frame = new TextDecoder().decode(r.currentRenderBuffer.getRealCharBytes(true))
    const grep = url.searchParams.get("grep")
    const body = grep ? frame.split("\n").filter(l => l.includes(grep)).join("\n") : frame
    if (url.searchParams.get("json") === "1") {
      return json({
        frame: body,
        match: grep ? frame.includes(grep) : undefined,
        lines: frame.split("\n").length,
      })
    }
    return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }

  // GET /logs?n=N — gateway stderr ring buffer (same source as /logs dialog)
  if (path === "/logs") {
    const n = Number(url.searchParams.get("n")) || 200
    return new Response(bridge.logs(n), { headers: { "Content-Type": "text/plain; charset=utf-8" } })
  }

  // POST /plugin/:id — {on: bool}. Flips enablement and (de)activates.
  const pm = path.match(/^\/plugin\/([^/]+)$/)
  if (pm && req.method === "POST") {
    const body = await req.json() as { on?: boolean }
    const ok = await bridge.plugin(pm[1]!, body.on !== false)
    return json({ id: pm[1], on: body.on !== false, ok })
  }

  // POST /push — inject a synthetic GatewayEvent for tests/automation.
  if (path === "/push" && req.method === "POST") {
    const body = await req.json() as { type: string; payload?: unknown }
    if (!body.type) return json({ error: "type required" }, 400)
    bridge.push(body)
    return json({ pushed: body.type })
  }

  // GET /perf — return all profiling data as JSON
  if (path === "/perf") {
    const d = perf.data()
    if (!d) return json({ error: "PERF not enabled" }, 400)
    return json(d)
  }

  // GET /tabs — cycle through all tabs with a delay
  if (path === "/tabs") {
    const ms = Number(url.searchParams.get("delay") || "500")
    for (let i = 0; i <= TAB_MAX; i++) {
      bridge.setTab(i)
      await new Promise(r => setTimeout(r, ms))
    }
    bridge.setTab(CHAT_TAB)
    return json({ cycled: TAB_MAX + 1, delay: ms })
  }

  // GET /mem — memory snapshot
  if (path === "/mem") {
    perf.mem("control:snapshot")
    const m = process.memoryUsage()
    return json({
      rss: Math.round(m.rss / 1024 / 1024),
      heap: Math.round(m.heapUsed / 1024 / 1024),
      heapTotal: Math.round(m.heapTotal / 1024 / 1024),
      external: Math.round(m.external / 1024 / 1024),
    })
  }

  return json({
    error: "not found",
    routes: [
      "GET  /status",
      "GET  /tab/:n",
      "POST /send   {message}",
      "POST /key    {name, ctrl?, shift?, meta?, raw?, safe?}",
      "POST /keys   {keys: [{name, ...}], delay?, safe?}",
      "POST /type   {text, delay?, safe?}",
      "POST /input  {text}",
      "POST /plugin/:id {on}",
      "POST /push   {type, payload?}",
      "GET  /quit",
      "GET  /frame  ?grep=pat&json=1",
      "GET  /logs   ?n=200",
      "GET  /focus",
      "GET  /perf",
      "GET  /tabs",
      "GET  /mem",
    ],
  }, 404)
}

export const internals = { handle }

export function start() {
  if (!enabled) return
  Bun.serve({ port: PORT, hostname: BIND, fetch: handle })
  const w = warning()
  if (w) {
    process.stderr.write(`\x1b[33m[control] WARNING: ${w.message}\x1b[0m\n`)
    return
  }
  process.stderr.write(`\x1b[90m[control] http://${BIND}:${PORT}\x1b[0m\n`)
}
