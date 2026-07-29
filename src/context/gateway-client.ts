// Stdio JSON-RPC 2.0 client for tui_gateway. Spawns the gateway as a child
// process and speaks newline-delimited JSON on stdin/stdout.

import { EventEmitter } from "events"
import { homedir } from "os"
import { resolve, delimiter } from "path"
import { existsSync } from "fs"
import { knownGatewayEvent, type GatewayEvent } from "./wire"
import { backend } from "./backend-contract"
import { encode } from "../utils/unicode"

const LOG_MAX = 200
const LOG_PREVIEW = 240
const STARTUP_MS = 15_000
const REQUEST_MS = 120_000
const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3
const decoder = new TextDecoder()

export type GatewayEventSource = "stdio" | "websocket" | "control" | "internal"

type Diag = {
  count: number
  index: number
  line: (count: number) => string
}

/** Locate the hermes-agent source tree (gateway + hermes_cli live here).
 *  Default: ~/.hermes/hermes-agent (where `hermes update` installs it).
 *  Fallback: /usr/local/lib/hermes-agent (FHS layout for root Linux installs).
 *  Override with HERMES_AGENT_ROOT for dev clones / exotic layouts. */
export function hermesAgentRoot(): string {
  if (process.env.HERMES_AGENT_ROOT) return process.env.HERMES_AGENT_ROOT
  const home = process.env.HOME || homedir()
  const homePath = `${home}/.hermes/hermes-agent`
  if (existsSync(homePath)) return homePath
  const fhs = "/usr/local/lib/hermes-agent"
  if (existsSync(fhs)) return fhs
  return homePath
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export function gatewayUrl(): string | null {
  return process.env.HERM_GATEWAY_URL?.trim()
    || process.env.HERMES_TUI_GATEWAY_URL?.trim()
    || null
}

export function websocketUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol === "http:") url.protocol = "ws:"
  else if (url.protocol === "https:") url.protocol = "wss:"
  else if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error(`unsupported gateway URL protocol: ${url.protocol}`)
  const prefix = url.pathname.replace(/\/+$/, "")
  if (!prefix.endsWith("/api/ws")) url.pathname = `${prefix}/api/ws`
  return url.toString()
}

function redact(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.username || url.password) {
      url.username = "***"
      url.password = ""
    }
    if (url.search) url.search = "?***"
    return url.toString()
  } catch { return "invalid gateway URL" }
}

export function python(root: string, platform: NodeJS.Platform = process.platform): string {
  const env = process.env.HERMES_PYTHON?.trim()
  if (env) return env

  const venv = process.env.VIRTUAL_ENV?.trim()
  const paths = platform === "win32"
    ? [
        venv && resolve(venv, "Scripts", "python.exe"),
        resolve(root, "venv", "Scripts", "python.exe"),
        resolve(root, ".venv", "Scripts", "python.exe"),
      ]
    : [
        venv && resolve(venv, "bin", "python"),
        venv && resolve(venv, "bin", "python3"),
        resolve(root, "venv", "bin", "python"),
        resolve(root, "venv", "bin", "python3"),
        resolve(root, ".venv", "bin", "python"),
        resolve(root, ".venv", "bin", "python3"),
      ]
  return paths.find(p => p && existsSync(p)) || (platform === "win32" ? "python" : "python3")
}

function asEvent(v: unknown): GatewayEvent | null {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string")
    return v as GatewayEvent
  return null
}

function text(raw: unknown): string | null {
  if (typeof raw === "string") return raw
  if (raw instanceof ArrayBuffer) return decoder.decode(raw)
  if (ArrayBuffer.isView(raw)) return decoder.decode(raw)
  return null
}

function rec(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

function crop(s: string): string {
  return s.length > LOG_PREVIEW ? `${s.slice(0, LOG_PREVIEW)}…` : s
}

function clean(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v
  if (typeof v === "string") return crop(v)
  if (v === undefined) return "[undefined]"
  if (typeof v !== "object") return `[${typeof v}]`
  if (seen.has(v)) return "[circular]"
  if (depth >= 3) return "[depth]"
  seen.add(v)
  if (Array.isArray(v)) {
    const vals = v.slice(0, 6).map(x => clean(x, depth + 1, seen))
    return v.length > vals.length ? [...vals, `…+${v.length - vals.length}`] : vals
  }
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(v).slice(0, 12)) {
    out[key] = /token|secret|password|credential|authorization|api[_-]?key|cookie|private[_-]?key/i.test(key)
      ? "[redacted]"
      : clean(val, depth + 1, seen)
  }
  const extra = Object.keys(v).length - Object.keys(out).length
  if (extra > 0) out["…"] = `+${extra}`
  return out
}

function payload(ev: GatewayEvent): string {
  const obj = rec(ev)
  if (!obj || !("payload" in obj)) return "(none)"
  try { return crop(JSON.stringify(clean(obj.payload, 0, new WeakSet()))) }
  catch { return "[unserializable]" }
}

function contract(ev: GatewayEvent): string {
  const obj = rec(ev)
  const body = rec(obj?.payload)
  const raw = obj?.contract_version
    ?? obj?.contractVersion
    ?? body?.contract_version
    ?? body?.contractVersion
    ?? rec(body?.contract)?.version
  return raw === undefined || raw === null ? "unknown" : crop(String(raw))
}

// Read lines from a ReadableStream (Bun subprocess stdout/stderr)
async function lines(stream: ReadableStream<Uint8Array>, cb: (line: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n")
      buf = parts.pop() || ""
      for (const line of parts) {
        if (line) cb(line)
      }
    }
    // Flush remaining
    if (buf.trim()) cb(buf)
  } catch {
    // Stream closed
  }
}

export class GatewayClient extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private ws: WebSocket | null = null
  private link: Promise<void> | null = null
  private target: string | null = null
  private id = 0
  private logs: string[] = []
  private unknown = new Map<string, Diag>()
  private pending = new Map<string, Pending>()
  private buf: GatewayEvent[] = []
  private contract = backend.backendContract(null)
  private exit: number | null | undefined
  private ok = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private sub = false

  private root(): string { return hermesAgentRoot() }

  private push(ev: GatewayEvent, source: GatewayEventSource = "internal") {
    this.diagnose(ev, source)
    if (ev.type === "gateway.ready") {
      this.ok = true
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
    }
    if (this.sub) return void this.emit("event", ev)
    this.buf.push(ev)
  }

  private log(line: string): number {
    if (this.logs.push(line) > LOG_MAX) {
      const cut = this.logs.length - LOG_MAX
      this.logs.splice(0, cut)
      for (const d of this.unknown.values()) d.index -= cut
    }
    return this.logs.length - 1
  }

  diagnose(ev: GatewayEvent, source: GatewayEventSource = "control") {
    try {
      if (knownGatewayEvent(ev.type)) return
      const version = contract(ev)
      const key = `${source}\u0000${version}\u0000${ev.type}`
      const old = this.unknown.get(key)
      if (old && old.index >= 0 && old.index < this.logs.length) {
        old.count++
        this.logs[old.index] = old.line(old.count)
        return
      }
      const summary = payload(ev)
      const line = (count: number) => `[event unknown] type=${ev.type} source=${source} contract=${version} count=${count} payload=${summary}`
      this.unknown.set(key, { count: 1, index: this.log(line(1)), line })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      this.log(`[event diagnostic_failed] source=${source} error=${crop(text)}`)
    }
  }

  private observe(raw: unknown) {
    const next = backend.backendContract(raw)
    this.contract = next.reason === "missing" && this.contract.supported ? this.contract : next
  }

  private dispatch(msg: Record<string, unknown>, source: GatewayEventSource = "stdio") {
    const id = msg.id as string | undefined
    const p = id ? this.pending.get(id) : undefined

    if (p) {
      this.pending.delete(id!)
      const res = msg.result
      const info = res && typeof res === "object" && !Array.isArray(res)
        ? (res as { info?: unknown }).info
        : undefined
      if (info) this.observe(info)
      if (msg.error) {
        const err = msg.error as { message?: unknown }
        p.reject(new Error(typeof err?.message === "string" ? err.message : "request failed"))
      } else {
        p.resolve(res)
      }
      return
    }

    if (msg.method === "event") {
      const ev = asEvent(msg.params)
      if (ev) {
        if (ev.type === "session.info") this.observe(ev.payload)
        this.push(ev, source)
      }
    }
  }

  private fail(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private connect(raw: string) {
    const cwd = process.env.HERMES_CWD || process.cwd()
    let url: string
    try { url = websocketUrl(raw) }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[startup] websocket failed: ${message}`)
      this.push({ type: "gateway.stderr", payload: { line: message } })
      if (this.sub) this.emit("exit", null)
      else this.exit = null
      return
    }

    const safe = redact(url)
    let ws: WebSocket
    try { ws = new WebSocket(url) }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(`[startup] websocket failed (${safe}): ${message}`)
      this.push({ type: "gateway.stderr", payload: { line: message } })
      if (this.sub) this.emit("exit", null)
      else this.exit = null
      return
    }

    this.target = raw
    this.ws = ws
    let settled = false
    this.link = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        if (settled) return
        settled = true
        resolve()
      }, { once: true })
      ws.addEventListener("error", () => {
        if (settled) return
        settled = true
        reject(new Error("gateway websocket connection failed"))
        try { ws.close() } catch {}
      }, { once: true })
      ws.addEventListener("close", event => {
        if (settled) return
        settled = true
        reject(new Error(`gateway websocket closed (${event.code}) during connect`))
      }, { once: true })
    })
    this.link.catch(() => {})

    this.timer = setTimeout(() => {
      if (this.ok || this.ws !== ws) return
      this.log(`[startup] timed out (websocket=${safe}, cwd=${cwd})`)
      this.push({ type: "gateway.start_timeout", payload: { cwd, python: "websocket" } })
      this.ws = null
      this.link = null
      this.fail(new Error("gateway websocket startup timeout"))
      try { ws.close() } catch {}
      if (this.sub) this.emit("exit", null)
      else this.exit = null
    }, STARTUP_MS)

    ws.addEventListener("message", event => {
      if (this.ws !== ws) return
      const raw = text(event.data)
      if (!raw) return
      try { this.dispatch(JSON.parse(raw), "websocket") }
      catch {
        const preview = raw.trim().slice(0, LOG_PREVIEW) || "(empty)"
        this.log(`[protocol] malformed websocket: ${preview}`)
        this.push({ type: "gateway.protocol_error", payload: { preview } })
      }
    })
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return
      const line = `websocket transport error (${safe})`
      this.log(`[gateway] ${line}`)
      this.push({ type: "gateway.stderr", payload: { line } })
    })
    ws.addEventListener("close", event => {
      if (this.ws !== ws) return
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      this.ws = null
      this.link = null
      this.fail(new Error(`gateway websocket closed${event.code ? ` (${event.code})` : ""}`))
      if (this.sub) this.emit("exit", event.code)
      else this.exit = event.code
    })
  }

  start() {
    const raw = gatewayUrl()
    const root = this.root()
    const bin = python(root)
    const cwd = process.env.HERMES_CWD || process.cwd()
    const env = { ...process.env } as Record<string, string>
    // Ensure the gateway and agent tools resolve to the user's launch cwd.
    // TERMINAL_CWD is the canonical env var the agent reads for working dir.
    if (!env.TERMINAL_CWD) env.TERMINAL_CWD = cwd
    const pp = env.PYTHONPATH?.trim()
    env.PYTHONPATH = pp ? `${root}${delimiter}${pp}` : root
    env.HERMES_PYTHON_SRC_ROOT = root

    // Reset state
    this.ok = false
    this.buf = []
    this.contract = backend.backendContract(null)
    this.exit = undefined

    let restarted = false
    const previous = this.proc
    if (previous) {
      this.proc = null
      this.fail(new Error("gateway restarted"))
      restarted = true
      try { previous.kill() } catch {}
    }

    const socket = this.ws
    if (socket) {
      this.ws = null
      this.link = null
      this.target = null
      if (!restarted) this.fail(new Error("gateway restarted"))
      try { socket.close() } catch {}
    }

    if (this.timer) clearTimeout(this.timer)
    if (raw) { this.connect(raw); return }
    this.timer = setTimeout(() => {
      if (this.ok) return
      this.log(`[startup] timed out (python=${bin}, cwd=${cwd})`)
      this.push({ type: "gateway.start_timeout", payload: { cwd, python: bin } })
      const proc = this.proc
      if (!proc || proc.exitCode !== null) return
      try { proc.kill() }
      catch (err) {
        this.proc = null
        const failure = new Error(`gateway startup timeout: ${err instanceof Error ? err.message : String(err)}`)
        this.fail(failure)
        if (this.sub) this.emit("exit", null)
        else this.exit = null
      }
    }, STARTUP_MS)

    const proc = (() => {
      try {
        return Bun.spawn([bin, "-u", "-m", "tui_gateway.entry"], {
          cwd,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (err) {
        if (this.timer) { clearTimeout(this.timer); this.timer = null }
        this.proc = null
        const message = err instanceof Error ? err.message : String(err)
        this.log(`[startup] spawn failed: ${message}`)
        this.push({ type: "gateway.stderr", payload: { line: message } })
        if (this.sub) this.emit("exit", null)
        else this.exit = null
        return null
      }
    })()
    if (!proc) return
    this.proc = proc

    // Read stdout lines — Bun returns ReadableStream
    if (proc.stdout) {
      lines(proc.stdout as ReadableStream<Uint8Array>, raw => {
        if (this.proc !== proc) return
        try {
          this.dispatch(JSON.parse(raw), "stdio")
        } catch {
          const preview = raw.trim().slice(0, LOG_PREVIEW) || "(empty)"
          this.log(`[protocol] malformed: ${preview}`)
          this.push({ type: "gateway.protocol_error", payload: { preview } })
        }
      })
    }

    // Read stderr lines
    if (proc.stderr) {
      lines(proc.stderr as ReadableStream<Uint8Array>, raw => {
        if (this.proc !== proc) return
        const line = raw.trim()
        if (!line) return
        this.log(line)
        this.push({ type: "gateway.stderr", payload: { line } })
      })
    }

    // Handle exit — guard against a superseded proc (restart kills the
    // old one, whose exit handler must not touch the new proc's state).
    proc.exited.then(code => {
      if (this.proc !== proc) return
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      this.fail(new Error(`gateway exited${code === null ? "" : ` (${code})`}`))
      if (this.sub) this.emit("exit", code)
      else this.exit = code
    })
  }

  drain() {
    if (this.sub) return
    this.sub = true
    for (const ev of this.buf.splice(0)) this.emit("event", ev)
    if (this.exit !== undefined) {
      const code = this.exit
      this.exit = undefined
      this.emit("exit", code)
    }
  }

  tail(n = 20): string {
    return this.logs.slice(-Math.max(1, n)).join("\n")
  }

  private sid = ""

  /** Set the active session id; auto-injected into subsequent requests. */
  setSession(sid: string) {
    this.sid = sid
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const blocked = backend.contractError(method, this.contract, params)
    if (blocked) return Promise.reject(blocked)
    const raw = gatewayUrl()
    if (raw) return this.remote<T>(raw, method, params)
    if (!this.proc || this.proc.exitCode !== null) this.start()

    const stdin = this.proc?.stdin
    if (!stdin || typeof stdin === "number") return Promise.reject(new Error("gateway not running"))

    const rid = `r${++this.id}`
    const writer = stdin as { write(data: string | Uint8Array): number }
    const merged = this.sid && params.session_id === undefined
      ? { session_id: this.sid, ...params }
      : params

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(rid)) reject(new Error(`timeout: ${method}`))
      }, REQUEST_MS)

      this.pending.set(rid, {
        reject: e => { clearTimeout(timeout); reject(e) },
        resolve: v => { clearTimeout(timeout); resolve(v as T) },
      })

      try {
        const frame = encode({ jsonrpc: "2.0", id: rid, method, params: merged })
        if (frame.issues.length) {
          const detail = frame.issues.map(x => `${x.path}:${x.count}`).join(", ")
          this.log(`[wire] sanitized invalid unicode for ${method}: ${detail}`)
        }
        writer.write(frame.text + "\n")
      } catch (e) {
        clearTimeout(timeout)
        this.pending.delete(rid)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private remote<T>(raw: string, method: string, params: Record<string, unknown>): Promise<T> {
    const blocked = backend.contractError(method, this.contract, params)
    if (blocked) return Promise.reject(blocked)
    try { websocketUrl(raw) }
    catch (err) { return Promise.reject(err instanceof Error ? err : new Error(String(err))) }
    if (this.target !== raw || !this.ws || this.ws.readyState === WS_CLOSING || this.ws.readyState === WS_CLOSED)
      this.start()

    const rid = `r${++this.id}`
    const merged = this.sid && params.session_id === undefined
      ? { session_id: this.sid, ...params }
      : params

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(rid)) reject(new Error(`timeout: ${method}`))
      }, REQUEST_MS)
      this.pending.set(rid, {
        reject: e => { clearTimeout(timeout); reject(e) },
        resolve: value => { clearTimeout(timeout); resolve(value as T) },
      })

      const send = async () => {
        try {
          if (this.ws?.readyState === WS_CONNECTING) await this.link
          if (!this.pending.has(rid)) return
          if (!this.ws || this.ws.readyState !== WS_OPEN) throw new Error(`gateway not connected: ${method}`)
          const frame = encode({ jsonrpc: "2.0", id: rid, method, params: merged })
          if (frame.issues.length) {
            const detail = frame.issues.map(x => `${x.path}:${x.count}`).join(", ")
            this.log(`[wire] sanitized invalid unicode for ${method}: ${detail}`)
          }
          this.ws.send(frame.text)
        } catch (err) {
          clearTimeout(timeout)
          if (this.pending.delete(rid)) reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      void send()
    })
  }

  kill() {
    this.proc?.kill()
    const ws = this.ws
    if (!ws) return
    this.ws = null
    this.link = null
    this.target = null
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.fail(new Error("gateway websocket closed"))
    try { ws.close() } catch {}
  }

  get ready(): boolean {
    return this.ok
  }
}
