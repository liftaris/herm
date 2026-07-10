// Popover filtering and ghost text for the slash-command composer.

import { useMemo, useEffect, useState } from "react"
import { matchSub, type SlashCommand } from "./slashCommands"
import { score } from "../utils/fuzzy"

export type SlashToken = {
  text: string
  query: string
  start: number
  end: number
  whole: boolean
}

function best(q: string, cmd: SlashCommand) {
  return cmd.aliases.reduce((m, a) => Math.max(m, score(q, a)), score(q, cmd.name))
}

export function rank(list: ReadonlyArray<SlashCommand>, q: string): SlashCommand[] {
  if (!q) return [...list]
  return list
    .map(cmd => ({ cmd, s: best(q, cmd) }))
    .filter(r => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(r => r.cmd)
}

function boundary(ch: string | undefined) {
  return ch === undefined || /\s/.test(ch) || "({\"'`".includes(ch)
}

function tag(s: SlashToken | null) {
  return s ? `${s.start}:${s.end}:${s.text}` : ""
}

function exact(spot: SlashToken, cmds: ReadonlyArray<SlashCommand>) {
  const m = spot.query.match(/^(\S+)(?:\s+(\S.*))?$/)
  if (!m) return false
  return cmds.some(c => c.name === m[1] || c.aliases.includes(m[1]))
    && (m[2] !== undefined || spot.query === m[1])
}

export function slashTokenAt(input: string, caret = input.length): SlashToken | null {
  const off = Math.max(0, Math.min(caret, input.length))
  if (/^\/[A-Za-z0-9_-]*$/.test(input)) {
    return { text: input, query: input.slice(1), start: 0, end: input.length, whole: true }
  }

  const line = input.lastIndexOf("\n", Math.max(0, off - 1)) + 1
  const slash = input.lastIndexOf("/", off)
  if (slash < line) return null
  if (!boundary(input[slash - 1])) return null
  if (input[slash - 1] === "(" && input[slash - 2] === "]") return null
  if (input[slash - 1] === "[") return null

  const tail = input.slice(slash + 1)
  const m = tail.match(/^[A-Za-z0-9_-]*/)
  const query = m?.[0] ?? ""
  const end = slash + 1 + query.length
  if (input[end] === "/") return null
  if (slash === line && off > end && /^\s+[^\n]*$/.test(input.slice(end, off))) {
    return { text: input.slice(slash, off), query: input.slice(slash + 1, off), start: slash, end: off, whole: true }
  }
  if (off > end || off < slash) return null
  if (!query && input[slash + 1] === "/") return null
  return { text: input.slice(slash, end), query, start: slash, end, whole: false }
}

export function replaceSlashToken(input: string, spot: SlashToken, cmd: SlashCommand) {
  const text = `/${cmd.name}${cmd.name.includes(" ") ? " " : ""}`
  return input.slice(0, spot.start) + text + input.slice(spot.end)
}

export function useSlashPopover(input: string, cmds: ReadonlyArray<SlashCommand>, caret = input.length) {
  const [cursor, setCursor] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const spot = useMemo(() => slashTokenAt(input, caret), [input, caret])
  const key = tag(spot)

  const popover = useMemo(() => {
    if (!spot || dismissed === key) return null
    if (spot.whole && exact(spot, cmds)) return null
    const subs = matchSub(cmds, spot.text)
    if (subs) return subs
    return rank(cmds, spot.query)
  }, [spot, cmds, dismissed, key])

  const active = popover ? Math.max(0, Math.min(cursor, popover.length - 1)) : 0

  // Reset cursor when input changes
  useEffect(() => {
    setCursor(c => c === 0 ? c : 0)
    setDismissed(d => d && d !== key ? null : d)
  }, [key])

  const ghost = useMemo(() => {
    if (!popover || popover.length === 0) return ""
    const hit = popover[active]
    if (!hit || hit.name.includes(" ")) return ""
    if (!spot || !/^\/\S*$/.test(spot.text)) return ""
    const typed = spot.query
    if (typed.length < 2) return ""
    if (!hit.name.toLowerCase().startsWith(typed.toLowerCase())) return ""
    return hit.name.slice(typed.length)
  }, [spot, popover, active])

  const open = popover !== null && popover.length > 0

  return {
    popover, cursor: active, setCursor, ghost, open, spot,
    dismiss: (next?: string, off = next?.length ?? caret) =>
      setDismissed(tag(next === undefined ? spot : slashTokenAt(next, off))),
  }
}
