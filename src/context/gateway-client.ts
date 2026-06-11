// JSON-RPC 2.0 client for tui_gateway. Uses a remote WebSocket when configured,
// otherwise spawns the gateway as a local child over newline-delimited stdio.

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

function asText(raw: unknown): string | null {
  if (typeof raw === "string") return raw
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return decoder.decode(raw as ArrayBufferLike)
  return null
}

function redact(raw: string): string {
  try {
    const url = new URL(raw)
    const auth = url.username || url.password ? "***@" : ""
    const query = url.search ? "?***" : ""
    return `${url.protocol}//${auth}${url.host}${url.pathname}${query}`
  } catch {
    const hit = raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1***@")
    const at = hit.indexOf("?")
    return at >= 0 ? `${hit.slice(0, at)}?***` : hit
  }
}

function ws(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol === "http:") url.protocol = "ws:"
    if (url.protocol === "https:") url.protocol = "wss:"
    if (url.pathname === "/" || !url.pathname) url.pathname = "/api/ws"
    return url.toString()
  } catch {
    return raw
  }
}

function root(raw: string): string | null {
  try {
    const url = new URL(raw)
    url.protocol = url.protocol === "wss:" ? "https:" : "http:"
    url.pathname = "/"
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function token(html: string): string | null {
  return html.match(/__HERMES_SESSION_TOKEN__\s*=\s*["']([^"']+)["']/)?.[1] || null
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
  private url: string | null = null
  private raw: string | null = null
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

  private reset() {
    this.ok = false
    this.buf = []
    this.exit = undefined
    if (this.timer) clearTimeout(this.timer)
  }

  private startTimer(python: string, cwd: string) {
    this.timer = setTimeout(() => {
      if (this.ok) return
      this.log(`[startup] timed out (python=${python}, cwd=${cwd})`)
      this.push({ type: "gateway.start_timeout", payload: { cwd, python } })
    }, STARTUP_MS)
  }

  private closeWs(err = new Error("gateway websocket closed")) {
    const ws = this.ws
    this.ws = null
    this.link = null
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.fail(err)
    try { ws?.close() } catch {}
  }

  private startWs(url: string) {
    const safe = redact(url)
    this.startTimer("websocket", safe)

    if (typeof WebSocket === "undefined") {
      const line = `[startup] WebSocket unavailable; cannot attach to ${safe}`
      this.log(line)
      this.push({ type: "gateway.stderr", payload: { line } })
      this.fail(new Error("gateway websocket unavailable"))
      return
    }

    try {
      const ws = new WebSocket(url)
      const old = this.ws
      let done = false
      this.ws = ws
      this.url = url
      this.link = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => {
          if (done) return
          done = true
          resolve()
        }, { once: true })
        ws.addEventListener("error", () => {
          if (done) return
          done = true
          reject(new Error("gateway websocket connection failed"))
        }, { once: true })
        ws.addEventListener("close", ev => {
          if (done) return
          done = true
          reject(new Error(`gateway websocket closed (${ev.code}) during connect`))
        }, { once: true })
      })
      this.link.catch(() => {})
      try { old?.close() } catch {}

      ws.addEventListener("message", ev => {
        if (this.ws !== ws) return
        const text = asText(ev.data)
        if (!text) return
        try {
          this.dispatch(JSON.parse(text))
        } catch {
          const preview = text.trim().slice(0, LOG_PREVIEW) || "(empty)"
          this.log(`[protocol] malformed websocket: ${preview}`)
          this.push({ type: "gateway.protocol_error", payload: { preview } })
        }
      })
      ws.addEventListener("close", ev => {
        if (this.ws !== ws) return
        if (this.timer) { clearTimeout(this.timer); this.timer = null }
        this.ws = null
        this.link = null
        this.fail(new Error(`gateway websocket closed${ev.code ? ` (${ev.code})` : ""}`))
        if (this.sub) this.emit("exit", ev.code)
        else this.exit = ev.code
      })
      ws.addEventListener("error", () => {
        if (this.ws !== ws) return
        const line = "[gateway] websocket transport error"
        this.log(line)
        this.push({ type: "gateway.stderr", payload: { line } })
      })
    } catch {
      this.log(`[startup] failed to connect websocket gateway ${safe}`)
      this.fail(new Error("gateway websocket startup failed"))
    }
  }

  private async resolve(raw: string): Promise<string> {
    const next = ws(raw)
    try {
      const url = new URL(next)
      if (url.searchParams.has("token")) return next
      const base = root(next)
      if (!base) return next
      const text = await fetch(base).then(r => r.text())
      const found = token(text)
      if (!found) return next
      url.searchParams.set("token", found)
      return url.toString()
    } catch {
      return next
    }
  }

  private startRemote(raw: string) {
    this.raw = raw
    const next = ws(raw)
    try {
      if (new URL(next).searchParams.has("token")) { this.startWs(next); return }
    } catch {}
    this.resolve(raw).then(url => {
      if (this.raw !== raw) return
      if (this.url === url && this.ws && this.ws.readyState !== WS_CLOSED && this.ws.readyState !== WS_CLOSING) return
      this.startWs(url)
    })
  }

  start() {
    const url = gatewayUrl()
    const root = this.root()
    const bin = python(root)
    const cwd = process.env.HERMES_CWD || process.cwd()
    const env = { ...process.env } as Record<string, string>
    // Ensure the gateway and agent tools resolve to the user's launch cwd.
    // TERMINAL_CWD is the canonical env var the agent reads for working dir.
    if (!env.TERMINAL_CWD) env.TERMINAL_CWD = cwd
    const pp = env.PYTHONPATH?.trim()
    env.PYTHONPATH = pp ? `${root}${delimiter}${pp}` : root

    this.reset()

    if (this.proc) {
      try { this.proc.kill() } catch {}
      this.proc = null
    }
    this.closeWs()

    if (url) { this.startRemote(url); return }
    this.url = null
    this.raw = null
    this.startTimer(bin, cwd)

    const proc = Bun.spawn([bin, "-u", "-m", "tui_gateway.entry"], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.proc = proc

    // Read stdout lines — Bun returns ReadableStream
    if (this.proc.stdout) {
      lines(this.proc.stdout as ReadableStream<Uint8Array>, raw => {
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
    if (this.proc.stderr) {
      lines(this.proc.stderr as ReadableStream<Uint8Array>, raw => {
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
    const url = gatewayUrl()
    if (url) return this.requestWs<T>(url, method, params)

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

  private async requestWs<T = unknown>(url: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
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
        resolve: v => { clearTimeout(timeout); resolve(v as T) },
      })

      const send = async () => {
        try {
          const next = await this.resolve(url)
          if (!this.pending.has(rid)) return
          if (this.url !== next || !this.ws || this.ws.readyState === WS_CLOSED || this.ws.readyState === WS_CLOSING) this.startWs(next)
          if (this.ws?.readyState === WS_CONNECTING) await this.link
          if (!this.pending.has(rid)) return
          if (!this.ws || this.ws.readyState !== WS_OPEN) throw new Error(`gateway not connected: ${method}`)
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params: merged }))
        } catch (e) {
          clearTimeout(timeout)
          if (this.pending.delete(rid)) reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
      void send()
    })
  }

  kill() {
    this.proc?.kill()
    this.closeWs()
  }

  get ready(): boolean {
    return this.ok
  }
}
