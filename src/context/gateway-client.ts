// Stdio JSON-RPC 2.0 client for tui_gateway. Spawns the gateway as a child
// process and speaks newline-delimited JSON on stdin/stdout.

import { EventEmitter } from "events"
import { homedir } from "os"
import { resolve, delimiter } from "path"
import { existsSync } from "fs"
import type { GatewayEvent } from "./wire"
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
  private pending = new Map<string, Pending>()
  private buf: GatewayEvent[] = []
  private exit: number | null | undefined
  private ok = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private sub = false

  private root(): string { return hermesAgentRoot() }

  private push(ev: GatewayEvent) {
    if (ev.type === "gateway.ready") {
      this.ok = true
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
    }
    if (this.sub) return void this.emit("event", ev)
    this.buf.push(ev)
  }

  private log(line: string) {
    if (this.logs.push(line) > LOG_MAX) this.logs.splice(0, this.logs.length - LOG_MAX)
  }

  private dispatch(msg: Record<string, unknown>) {
    const id = msg.id as string | undefined
    const p = id ? this.pending.get(id) : undefined

    if (p) {
      this.pending.delete(id!)
      if (msg.error) {
        const err = msg.error as { message?: unknown }
        p.reject(new Error(typeof err?.message === "string" ? err.message : "request failed"))
      } else {
        p.resolve(msg.result)
      }
      return
    }

    if (msg.method === "event") {
      const ev = asEvent(msg.params)
      if (ev) this.push(ev)
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
      try { this.dispatch(JSON.parse(raw)) }
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
          this.dispatch(JSON.parse(raw))
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
