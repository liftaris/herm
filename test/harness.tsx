// Test harness — MockGateway + mount() wrapper around OpenTUI's testRender.
//
// Usage:
//   const t = await mount()
//   t.gw.emit("event", { type: "message.delta", payload: { text: "hi" } })
//   await t.settle()
//   expect(t.frame()).toContain("hi")
//   t.keys.pressArrow("right", { meta: true })
//   t.destroy()

import { EventEmitter } from "events"
import { act, type ReactNode } from "react"
import { createRoot } from "@opentui/react"
import { createTestRenderer, type MockInput, type MockMouse, type TestRenderer } from "@opentui/core/testing"
import { App } from "../src/app"
import type { Gateway } from "../src/context/gateway"
import { GatewayProvider } from "../src/context/gateway"
import { ThemeProvider } from "../src/theme"
import { KeysProvider } from "../src/keys"
import { DialogProvider } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { CommandProvider } from "../src/ui/command"
import { PluginProvider } from "../src/plugins/runtime"
import { BackgroundProvider } from "../src/app/background"
import type { HermPlugin } from "../src/plugins/types"
import type { GatewayEvent } from "../src/context/wire"

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>
type Mode = "compat" | "audit" | "strict"
type MockOpts = { mode?: Mode }
type RuleOpts = {
  match?: (params: Record<string, unknown>) => boolean
  min?: number
  max?: number
}
type Rule = { method: string; calls: number; min: number; max: number }

const preset: Record<string, Handler> = {
  "session.resume": p => ({ session_id: p.session_id ?? "test-sid", messages: [], info: { desktop_contract: 4 } }),
  "session.list": () => ({ sessions: [] }),
  "session.active_list": () => ({ sessions: [] }),
  "session.activate": p => ({ session_id: p.session_id ?? "test-sid", messages: [], status: "idle", info: { desktop_contract: 4 } }),
  "agents.list": () => ({ processes: [] }),
  "delegation.status": () => ({ active: [], paused: false, max_spawn_depth: 2, max_concurrent_children: 3 }),
  "complete.path": () => ({ items: [] }),
  "complete.slash": () => ({ items: [] }),
  "paste.collapse": p => ({
    placeholder: `[Pasted text #1: ${String(p.text).split("\n").length} lines → /tmp/p.txt]`,
    path: "/tmp/p.txt",
  }),
  "cli.exec": () => ({ blocked: false, code: 0, output: "✓" }),
  "session.title": p => ({ title: p.title ?? "" }),
  "session.undo": () => ({ removed: 2 }),
  "session.close": () => ({ closed: true }),
  "session.interrupt": () => ({ interrupted: true }),
  "session.history": () => ({ count: 0, messages: [] }),
  "session.save": () => ({ file: "/tmp/conv.json" }),
  "session.usage": () => ({}),
  "prompt.submit": () => ({ accepted: true }),
  "approval.respond": () => ({ accepted: true }),
  "clarify.respond": () => ({ accepted: true }),
  "secret.respond": () => ({ accepted: true }),
  "sudo.respond": () => ({ accepted: true }),
  "terminal.read.respond": () => ({ accepted: true }),
  "cron.manage": () => ({ jobs: [] }),
  "toolsets.list": () => ({ toolsets: [] }),
  "tools.configure": () => ({ changed: [], enabled_toolsets: [], unknown: [] }),
  "rollback.list": () => ({ enabled: true, checkpoints: [] }),
  "rollback.diff": () => ({ stat: "", diff: "" }),
  "rollback.restore": () => ({ success: true }),
  "skills.manage": p => p.action === "search" ? { results: [] }
    : p.action === "inspect" ? { info: {} }
    : p.action === "install" ? { ok: true }
    : { skills: {} },
}

/** Scriptable in-memory Gateway. No subprocess. */
export class MockGateway extends EventEmitter implements Gateway {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  private handlers = new Map<string, Handler>()
  private buf: GatewayEvent[] = []
  private logs: string[] = []
  private issues: Error[] = []
  private rules: Rule[] = []
  private mode: Mode
  private sub = false
  private sid = ""
  ok = false

  constructor(handlers: Record<string, Handler> = {}, opts: MockOpts = {}) {
    super()
    const env = process.env.HERM_MOCK_GATEWAY_MODE
    this.mode = opts.mode ?? (env === "compat" || env === "audit" ? env : "strict")
    // Sane defaults so <App> boots without hanging.
    this.on$("session.create", () => ({ session_id: "test-sid", info: { desktop_contract: 4 } }))
    this.on$("config.get", p => p.key === "full" ? { config: {} } : {})
    this.on$("commands.catalog", () => ({ pairs: [] }))
    for (const [m, h] of Object.entries(handlers)) this.on$(m, h)
  }

  /** Register (or override) an RPC handler. */
  on$(method: string, fn: Handler) { this.handlers.set(method, fn); return this }
  has$(method: string) { return this.handlers.has(method) }

  expect$(method: string, fn: Handler, opts: RuleOpts = {}) {
    const min = opts.min ?? 1
    return this.rule(method, fn, { ...opts, min, max: opts.max ?? min })
  }

  allow$(method: string, fn: Handler, opts: Omit<RuleOpts, "min"> = {}) {
    return this.rule(method, fn, { ...opts, min: 0, max: opts.max ?? 1 })
  }

  assert(final = true) {
    if (this.issues[0]) throw this.issues[0]
    if (!final) return
    const missing = this.rules.find(rule => rule.calls < rule.min)
    if (missing) throw new Error(`MockGateway: ${missing.method} was not called`)
  }

  get ready() { return this.ok }
  setSession(sid: string) { this.sid = sid }

  start() {
    this.ok = true
    this.push({ type: "gateway.ready" })
    this.push({ type: "session.info", payload: { model: "test-model", session_id: "test-sid", tools: {}, skills: {}, desktop_contract: 4 } })
  }

  drain() {
    if (this.sub) return
    this.sub = true
    for (const ev of this.buf.splice(0)) this.emit("event", ev)
  }

  kill() { this.sub = false }

  tail(n = 200) { return this.logs.slice(-n).join("\n") }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const merged = this.sid && params.session_id === undefined ? { session_id: this.sid, ...params } : params
    this.calls.push({ method, params: merged })
    const h = this.handlers.get(method)
    if (h) return await h(merged) as T
    if (this.mode === "compat") return {} as T
    const err = this.issue(`unexpected RPC ${method} ${JSON.stringify(merged)}`)
    if (this.mode === "strict") throw err
    return {} as T
  }

  /** Push an event; buffers until drained, then emits live. */
  push(ev: GatewayEvent) {
    if (ev.type === "gateway.stderr") this.logs.push(ev.payload.line)
    if (this.sub) return void this.emit("event", ev)
    this.buf.push(ev)
  }

  /** Convenience: last call for a method, or undefined. */
  last(method: string) { return [...this.calls].reverse().find(c => c.method === method) }

  private issue(text: string) {
    const err = new Error(`MockGateway: ${text}`)
    this.issues.push(err)
    return err
  }

  private rule(method: string, fn: Handler, opts: Required<Pick<RuleOpts, "min" | "max">> & RuleOpts) {
    if (!Number.isInteger(opts.min) || !Number.isInteger(opts.max) || opts.min < 0 || opts.max < opts.min)
      throw new Error(`MockGateway: invalid bounds for ${method}: ${opts.min}..${opts.max}`)
    const rule = { method, calls: 0, min: opts.min, max: opts.max }
    this.rules.push(rule)
    this.on$(method, params => {
      if (opts.match && !opts.match(params)) throw this.issue(`${method} parameters did not match`)
      rule.calls++
      if (rule.calls > rule.max) throw this.issue(`${method} exceeded ${rule.max} call${rule.max === 1 ? "" : "s"}`)
      return fn(params)
    })
    return this
  }
}

export type Harness = {
  renderer: TestRenderer
  keys: MockInput
  mouse: MockMouse
  gw: MockGateway
  /** Rendered screen as a newline-joined string. */
  frame: () => string
  /** Rendered styled spans preserving fg/bg/attributes. */
  spans: () => unknown
  /** Flush React + render one frame. Await after any state mutation. */
  settle: () => Promise<void>
  resize: (w: number, h: number) => void
  destroy: () => void
  [Symbol.asyncDispose]: () => Promise<void>
}

type Opts = {
  width?: number
  height?: number
  gw?: MockGateway
  handlers?: Record<string, Handler>
  launch?: import("../src/app/launch").Launch
  plugins?: ReadonlyArray<HermPlugin>
  keyOverrides?: Record<string, string>
}

const prepare = (gw: MockGateway) => {
  for (const [method, handler] of Object.entries(preset))
    if (!gw.has$(method)) gw.on$(method, handler)
  return gw
}

/** Mount the full <App> under a test renderer with a MockGateway. */
export async function mount(opts: Opts = {}): Promise<Harness> {
  const gw = prepare(opts.gw ?? new MockGateway(opts.handlers))
  return render(<App gateway={gw} launch={opts.launch ?? { mode: "new", splash: false }}
    keyOverrides={opts.keyOverrides} plugins={opts.plugins} />, gw, opts)
}

/** Mount an arbitrary subtree wrapped in all providers (for component tests). */
export async function mountNode(node: ReactNode, opts: Opts = {}): Promise<Harness> {
  const gw = prepare(opts.gw ?? new MockGateway(opts.handlers))
  return render(
    <ThemeProvider>
      <GatewayProvider client={gw}>
        <ToastProvider>
          <KeysProvider>
            <DialogProvider>
              <CommandProvider>
                <PluginProvider plugins={opts.plugins ?? []}>
                  <BackgroundProvider>
                    {node}
                  </BackgroundProvider>
                </PluginProvider>
              </CommandProvider>
            </DialogProvider>
          </KeysProvider>
        </ToastProvider>
      </GatewayProvider>
    </ThemeProvider>,
    gw, opts,
  )
}

async function render(node: ReactNode, gw: MockGateway, opts: Opts): Promise<Harness> {
  let root: ReturnType<typeof createRoot> | null = null
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  env.IS_REACT_ACT_ENVIRONMENT = true
  const setup = await createTestRenderer({
    width: opts.width ?? 160,
    height: opts.height ?? 48,
    // Match index.tsx — we own Ctrl+C routing; the default handler
    // schedules renderer.destroy() on nextTick and the following
    // settle() renders against a freed native ptr (segfault).
    exitOnCtrlC: false,
    // Raw-mode ESC is ambiguous (could prefix an arrow); kitty protocol
    // disambiguates so pressEscape() fires a single clean keypress.
    kittyKeyboard: true,
    onDestroy() {
      root?.unmount()
      root = null
      env.IS_REACT_ACT_ENVIRONMENT = false
    },
  })
  // Match production before root.render() mounts selection-aware scrollboxes.
  setup.renderer.setMaxListeners(64)
  root = createRoot(setup.renderer)
  act(() => { root?.render(node) })

  let dead = false
  const close = () => {
    if (dead) return
    dead = true
    try { act(() => setup.renderer.destroy()) }
    finally { gw.kill() }
  }
  const cleanup = async () => {
    if (dead) return
    dead = true
    try { await act(async () => { setup.renderer.destroy(); await Promise.resolve() }) }
    finally { gw.kill() }
  }

  const settle = async () => {
    try {
      await act(async () => { await Promise.resolve() })
      await act(async () => { await setup.renderOnce() })
      gw.assert(false)
    } catch (err) {
      await cleanup()
      throw err
    }
  }

  // Two passes: mount effects → drain → state updates → second frame.
  await settle()
  await settle()

  const destroy = () => {
    close()
    gw.assert()
  }

  return {
    renderer: setup.renderer,
    keys: setup.mockInput,
    mouse: setup.mockMouse,
    gw,
    frame: setup.captureCharFrame,
    spans: setup.captureSpans,
    settle,
    resize: setup.resize,
    destroy,
    [Symbol.asyncDispose]: async () => { await cleanup(); gw.assert() },
  }
}

/** Settle at least once, then poll until `fn()` is truthy. Throws on timeout
 *  with the last frame. The leading settle makes until() equivalent to
 *  `await t.settle(); expect(fn())` in the common case — a predicate that
 *  happens to already match a stale frame (e.g. popover text colliding
 *  with dialog text) would otherwise return without ever rendering. */
export async function until(t: Harness, fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  await t.settle()
  while (!fn()) {
    if (Date.now() > end) throw new Error(`until() timed out\n${t.frame()}`)
    await t.settle()
    await Bun.sleep(5)
  }
}
