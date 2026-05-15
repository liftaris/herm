// Single exit path. Latched so a double keypress or an exit racing a
// signal can't re-enter renderer.destroy() (OpenTUI is not idempotent
// there — second call throws on a disposed native handle).
//
// The goodbye banner writes *after* renderer.destroy() has left the alt
// screen (?1049l) so it lands on the primary scrollback the user
// actually returns to. terminal-reset's `exit` hook then flushes the
// mode-reset blob synchronously on process.exit().
//
// Parity: opencode context/exit.tsx — minus onBeforeExit/onExit (no
// plugin runtime), setTerminalTitle (herm never sets it), and the
// win32 input-buffer flush (tracked as a bead).

import { writeSync } from "node:fs"
import type { GatewaySkin } from "../context/wire"
import { goodbye } from "../context/skin"
import { frame } from "../ui/splash-art"

let done = false

export type ExitStats = {
  start: number
  msgs: number
  tools?: number
  inputTok?: number
  outputTok?: number
  skin?: GatewaySkin | null
  model?: string
}

const esc = (s: string) => `\x1b[${s}m`
const reset = esc("0")
const dim = esc("2")
const bold = esc("1")
const cyan = esc("36")
const green = esc("32")
const gray = esc("90")
const white = esc("37")

function dur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m ${r}s` : `${m}m`
}

function tok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

/** Build the farewell banner. Exported for testability. */
export function banner(
  g: string,
  d: string,
  n: string,
  t: string,
  sid: string,
  m?: string,
  tools?: string,
  itok?: string,
  otok?: string,
): string {
  const cols = process.stdout.columns ?? 0
  const rows = process.stdout.rows ?? 0
  const { lines: frameLines, inner } = cols >= 60 && rows >= 20
    ? frame(cols, rows)
    : { lines: [] as string[], inner: { x: 0, y: 0, w: 0, h: 0 } }

  if (frameLines.length === 0)
    return fallback(g, d, n, t, sid, m, tools, itok, otok)

  const content: string[] = []
  const center = (s: string) => {
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, "")
    const pad = Math.max(0, Math.floor((inner.w - stripped.length) / 2))
    return " ".repeat(pad) + s
  }

  content.push("")
  content.push(center(`${white}${bold}${g}${reset}`))
  content.push("")

  const hasStats = d || n || tools || itok || otok || m || t
  if (hasStats) {
    const label = (k: string, v: string) =>
      `${gray}${k.padEnd(10)}${reset}${white}${v}${reset}`
    if (d) content.push(center(label("session", d)))
    if (n) content.push(center(label("messages", n)))
    if (tools) content.push(center(label("tool calls", tools)))
    if (itok) content.push(center(label("input", itok)))
    if (otok) content.push(center(label("output", otok)))
    if (m) content.push(center(label("model", m)))
    if (t) content.push(center(label("title", t)))
    content.push("")
  }

  content.push(center(`${dim}──────────────────────────────${reset}`))
  content.push("")

  const cmd = `herm --resume ${sid}`
  content.push(center(`${green}${cmd}${reset}`))
  if (t) content.push(center(`${dim}— ${t}${reset}`))

  const out: string[] = [...frameLines]
  const offset = Math.max(0, Math.floor((inner.h - content.length) / 2))
  for (let i = 0; i < content.length && i + offset < inner.h; i++) {
    const row = inner.y + offset + i
    if (row < 0 || row >= out.length) continue
    const leftEdge = out[row].slice(0, inner.x)
    const rightEdge = out[row].slice(inner.x + inner.w)
    const raw = content[i].replace(/\x1b\[[0-9;]*m/g, "")
    const pad = Math.max(0, inner.w - raw.length)
    out[row] = leftEdge + content[i] + " ".repeat(pad) + rightEdge
  }

  return out.join("\n")
}

function fallback(
  g: string,
  d: string,
  n: string,
  t: string,
  sid: string,
  m?: string,
  tools?: string,
  itok?: string,
  otok?: string,
): string {
  const w = 60
  const pad = (s: string) => {
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, "")
    const left = Math.max(0, w - stripped.length - 2)
    return `${dim}│${reset} ${s}${" ".repeat(left)} ${dim}│${reset}`
  }
  const top = `${dim}┌${"─".repeat(w)}┐${reset}`
  const bot = `${dim}└${"─".repeat(w)}┘${reset}`
  const empty = pad("")
  const lines: string[] = [top, empty]

  const msg = `  ${g}  `
  const half = Math.max(0, (w - msg.length) / 2)
  lines.push(`${dim}│${reset}${" ".repeat(half)}${white}${bold}${msg}${reset}${" ".repeat(Math.ceil(half))}${dim}│${reset}`)
  lines.push(empty)

  const hasStats = d || n || tools || itok || otok || m || t
  if (hasStats) {
    if (d) lines.push(pad(`${gray}session${" ".repeat(3)}${reset}${white}${d}${reset}`))
    if (n) lines.push(pad(`${gray}messages${" ".repeat(2)}${reset}${white}${n}${reset}`))
    if (tools) lines.push(pad(`${gray}tool calls${" ".repeat(1)}${reset}${white}${tools}${reset}`))
    if (itok) lines.push(pad(`${gray}input${" ".repeat(5)}${reset}${white}${itok}${reset}`))
    if (otok) lines.push(pad(`${gray}output${" ".repeat(4)}${reset}${white}${otok}${reset}`))
    if (m) lines.push(pad(`${gray}model${" ".repeat(5)}${reset}${white}${m}${reset}`))
    if (t) lines.push(pad(`${gray}title${" ".repeat(5)}${reset}${white}${t}${reset}`))
    lines.push(empty)
  }
  lines.push(pad(`${dim}${"─".repeat(w - 2)}${reset}`))
  lines.push(empty)

  const cmd = `herm --resume ${sid}`
  lines.push(pad(`${green}${cmd}${reset}`))
  if (t) lines.push(pad(`${dim}— ${t}${reset}`))
  lines.push(empty)
  lines.push(bot)
  return lines.join("\n")
}

export function quit(
  renderer: { destroy: () => void },
  sid?: string,
  title?: string,
  gw?: { kill: () => void },
  stats?: ExitStats,
): never {
  if (done) process.exit(0)
  done = true
  process.removeAllListeners("SIGINT")
  try { gw?.kill() } catch {}
  renderer.destroy()
  if (process.stdout.isTTY && sid) {
    const g = goodbye(stats?.skin)
    const d = stats ? dur(Date.now() - stats.start) : ""
    const n = stats && stats.msgs > 0 ? `${stats.msgs}` : ""
    const tools = stats && stats.tools && stats.tools > 0 ? `${stats.tools}` : ""
    const itok = stats && stats.inputTok && stats.inputTok > 0 ? tok(stats.inputTok) : ""
    const otok = stats && stats.outputTok && stats.outputTok > 0 ? tok(stats.outputTok) : ""
    const m = stats?.model ?? ""
    const t = title ? title.slice(0, 60) : ""
    writeSync(1, "\x1b[2J\x1b[H")
    writeSync(1, "\n" + banner(g, d, n, t, sid, m, tools, itok, otok) + "\n")
  }
  process.exit(0)
}
