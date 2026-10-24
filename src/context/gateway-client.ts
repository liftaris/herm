import { EventEmitter } from "events"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { attach, type Dial } from "./owner-attach"
import { canonical } from "./canonical"
import { knownGatewayEvent, type GatewayEvent } from "./wire"
import { prompt, type ServerRequest } from "./server-requests"
import { encode } from "../utils/unicode"

const LOG_MAX = 200
const LOG_PREVIEW = 240
const STARTUP_MS = 15_000
const REQUEST_MS = 120_000
const WS_OPEN = 1
const decoder = new TextDecoder()

export type GatewayEventSource = "websocket" | "control" | "internal"

type Diag = {
  count: number
  index: number
  line: (count: number) => string
}

export function hermesAgentRoot(): string {
  if (process.env.HERMES_AGENT_ROOT) return process.env.HERMES_AGENT_ROOT
  const path = join(process.env.HOME || homedir(), ".hermes", "hermes-agent")
  return !existsSync(path) && existsSync("/usr/local/lib/hermes-agent") ? "/usr/local/lib/hermes-agent" : path
}

type Pending = {
  method: string
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

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null
  private link: Promise<void> | null = null
  private target: string | null = null
  private id = 0
  private logs: string[] = []
  private unknown = new Map<string, Diag>()
  private pending = new Map<string, Pending>()
  private buf: GatewayEvent[] = []
  private requests = new Map<string, { frame: ServerRequest; replayed: boolean }>()
  private exit: number | null | undefined
  private ok = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private sub = false

  private generation = 0
  private native = false
  private description: Promise<canonical.Creation> | null = null
  private subscriptions = new Map<string, canonical.Subscription>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private seen = 0
  private stopped = false

  constructor(private readonly timing = { ping: 15_000, silence: 45_000 }) { super() }

  private push(ev: GatewayEvent, source: GatewayEventSource = "internal") {
    this.diagnose(ev, source)
    if (ev.type === "gateway.ready") {
      this.ok = true
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      this.handshake()
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

  private dispatch(msg: Record<string, unknown>, source: GatewayEventSource = "websocket") {
    if (typeof msg.method === "string" && msg.id !== undefined) {
      this.receive(msg)
      return
    }
    const id = msg.id as string | undefined
    const p = id ? this.pending.get(id) : undefined

    if (p) {
      this.pending.delete(id!)
      const res = msg.result
      const open = rec(res)?.open_requests
      if (Array.isArray(open)) open.forEach(frame => { if (rec(frame)) this.receive(frame, true) })
      if (msg.error) {
        const err = rec(msg.error)
        const message = `${err?.code ?? "RPC"}: ${typeof err?.message === "string" ? err.message : "request failed"}`
        this.log(`[rpc] ${p.method}: ${message}`)
        p.reject(new Error(message))
      } else {
        p.resolve(res)
      }
      return
    }

    if (msg.method === "event") {
      const params = rec(msg.params)
      const subscription = typeof params?.session_id === "string" ? this.subscriptions.get(params.session_id) : undefined
      if (subscription && typeof params?.execution_generation === "number") subscription.generation = params.execution_generation
      const ev = asEvent(this.native && params?.type === "session.info"
        ? { ...params, payload: canonical.metadata(params.payload) }
        : msg.params)
      if (ev) {
        if (ev.type === "request.cancel") this.requests.delete(ev.payload.id)
        this.push(ev, source)
      }
    }
  }

  private write(frame: Record<string, unknown>) {
    const data = encode(frame).text
    if (this.ws?.readyState === WS_OPEN) { this.ws.send(data); return }
    throw new Error("gateway not connected")
  }

  private receive(raw: Record<string, unknown>, replayed = false) {
    if (typeof raw.id !== "string" || typeof raw.method !== "string") return
    const frame = { id: raw.id, method: raw.method, params: rec(raw.params) ?? {} }
    if (!prompt(frame)) {
      this.write({ jsonrpc: "2.0", id: frame.id, error: { code: 4404, message: `Herm cannot show ${frame.method}` } })
      return
    }
    const old = this.requests.get(frame.id)
    this.requests.set(frame.id, { frame, replayed: old?.replayed === false ? false : replayed })
    if (!replayed && this.sub) this.emit("request", frame)
  }

  async answer(id: string, result: Record<string, unknown>): Promise<void> {
    const req = this.requests.get(id)
    if (!req) throw new Error(`request no longer open: ${id}`)
    if (req.replayed) await this.request("request.answer", { id, result })
    else this.write({ jsonrpc: "2.0", id, result })
    this.requests.delete(id)
  }

  private fail(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private disconnected(err: Error, code: number | null = null) {
    this.ok = false
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.timer = null
    this.heartbeat = null
    this.fail(err)
    this.log(`[gateway] ${err.message}`)
    this.push({ type: "error", payload: { message: err.message } })
    if (this.sub) this.emit("exit", code)
    else this.exit = code
  }

  private connect(dial: Dial, native: boolean): Promise<void> {
    const url = websocketUrl(dial.url)
    const ws = new WebSocket(url, dial.protocols)
    this.ws = ws
    this.native = native
    this.seen = performance.now()
    this.timer = setTimeout(() => {
      if (this.ok || this.ws !== ws) return
      this.ws = null
      this.disconnected(new Error(`gateway websocket startup timed out (${redact(url)})`))
      ws.close()
    }, STARTUP_MS)
    ws.addEventListener("message", event => {
      if (this.ws !== ws) return
      this.seen = performance.now()
      const raw = text(event.data)
      if (!raw) return
      try { this.dispatch(JSON.parse(raw), "websocket") }
      catch {
        const preview = raw.trim().slice(0, LOG_PREVIEW) || "(empty)"
        this.log(`[protocol] malformed websocket: ${preview}`)
        this.push({ type: "gateway.protocol_error", payload: { preview } })
      }
    })
    ws.addEventListener("close", event => {
      if (this.ws !== ws) return
      this.ws = null
      this.disconnected(new Error(`gateway websocket closed (${event.code})${event.reason ? `: ${event.reason}` : ""}`), event.code)
    })
    return new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        if (this.ws !== ws) return reject(new Error("gateway restarted"))
        if (native && ws.protocol !== "hermes-gateway-v1") {
          const err = new Error("missing hermes-gateway-v1 subprotocol echo; update Hermes")
          this.ws = null
          this.disconnected(err)
          ws.close()
          return reject(err)
        }
        resolve()
      }, { once: true })
      ws.addEventListener("error", () => reject(new Error(`gateway websocket connection failed (${redact(url)})`)), { once: true })
      ws.addEventListener("close", event => reject(new Error(`gateway websocket closed (${event.code}): ${event.reason}`)), { once: true })
    })
  }

  start() {
    this.kill()
    this.stopped = false
    const generation = this.generation
    this.ok = false
    this.buf = []
    this.requests.clear()
    this.subscriptions.clear()
    this.description = null
    this.sid = ""
    this.exit = undefined
    const raw = gatewayUrl()
    this.target = raw
    const dial = async () => {
      const grant = raw ? { url: raw, protocols: [] } : await attach()
      if (generation !== this.generation) throw new Error("gateway restarted")
      await this.connect(grant, !raw)
    }
    this.link = dial()
    void this.link.catch(err => {
      if (generation !== this.generation || this.stopped) return
      const ws = this.ws
      this.ws = null
      this.disconnected(err instanceof Error ? err : new Error(String(err)))
      ws?.close()
    })
  }

  private handshake() {
    void this.request("client.capabilities", { server_requests: true }).catch(err => {
      this.push({ type: "error", payload: { message: String(err) } })
    })
    this.seen = performance.now()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => {
      if (performance.now() - this.seen >= this.timing.silence) {
        const ws = this.ws
        this.ws = null
        this.disconnected(new Error(`gateway heartbeat timeout: no inbound frame for ${this.timing.silence / 1000} seconds`))
        ws?.close()
        return
      }
      void this.request("gateway.ping").catch(() => {})
    }, this.timing.ping)
    if (this.native) void this.describe().catch(err => this.push({ type: "error", payload: { message: String(err) } }))
  }

  private describe() {
    const generation = this.generation
    return this.description ??= this.request("runtime.describe").then(value => canonical.creation.parse(rec(value)?.session_create)).catch(err => {
      if (generation === this.generation) this.description = null
      throw err
    })
  }

  drain() {
    if (this.sub) return
    this.sub = true
    for (const ev of this.buf.splice(0)) this.emit("event", ev)
    for (const req of this.requests.values()) if (!req.replayed) this.emit("request", req.frame)
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

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.link && !this.stopped) this.start()
    if (this.target !== gatewayUrl() && !this.stopped) this.start()
    const link = this.link
    const generation = this.generation
    if (!link || this.stopped) throw new Error("gateway disconnected; reconnect manually")
    await link
    if (generation !== this.generation) throw new Error("gateway restarted")
    const contract = this.native && method === "session.create" ? await this.describe() : null
    if (generation !== this.generation || this.stopped) throw new Error("gateway restarted")
    const merged = this.sid && params.session_id === undefined && !["runtime.describe", "client.capabilities", "gateway.ping", "session.create"].includes(method)
      ? { session_id: this.sid, ...params } : params
    const frame = this.native ? canonical.prepare(method, merged, contract, this.subscriptions) : { method, params: merged }
    const rid = `r${++this.id}`
    const value = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(rid)) reject(new Error(`timeout: ${method}`))
      }, REQUEST_MS)
      this.pending.set(rid, {
        method,
        reject: err => { clearTimeout(timeout); reject(err) },
        resolve: value => { clearTimeout(timeout); resolve(value) },
      })
      try {
        const encoded = encode({ jsonrpc: "2.0", id: rid, ...frame })
        if (encoded.issues.length) this.log(`[wire] sanitized invalid unicode for ${method}: ${encoded.issues.map(x => `${x.path}:${x.count}`).join(", ")}`)
        if (this.ws?.readyState !== WS_OPEN) throw new Error(`gateway not connected: ${method}`)
        this.ws.send(encoded.text)
      } catch (err) {
        clearTimeout(timeout)
        this.pending.delete(rid)
        reject(err)
      }
    })
    if (generation !== this.generation) throw new Error("gateway restarted")
    if (this.native && frame.method === "session.detach") this.subscriptions.delete(String(frame.params.session_id))
    const result = this.native ? canonical.snapshot(frame.method, value, this.subscriptions) : value
    if (this.native && (frame.method === "session.create" || frame.method === "session.resume")) {
      const data = rec(result)
      const info = rec(data?.info)
      if (info && typeof data?.session_id === "string") this.push({ type: "session.info", session_id: data.session_id, payload: {
        ...info, session_id: data.session_id, running: typeof data.running === "boolean" ? data.running : false,
      } })
    }
    return result as T
  }

  kill() {
    this.generation++
    this.stopped = true
    this.ok = false
    const ws = this.ws
    if (ws?.readyState === WS_OPEN && this.native) {
      for (const [session_id, subscription] of this.subscriptions)
        ws.send(encode({ jsonrpc: "2.0", id: `detach-${++this.id}`, method: "session.detach", params: { session_id, subscription_id: subscription.id } }).text)
    }
    this.subscriptions.clear()
    this.ws = null
    this.link = null
    this.target = null
    if (this.timer) clearTimeout(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.timer = null
    this.heartbeat = null
    this.fail(new Error("gateway websocket closed"))
    ws?.close()
  }

  get ready(): boolean {
    return this.ok
  }
}
