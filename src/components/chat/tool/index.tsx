// Per-tool dispatch. Each hermes tool name maps to a terse trail row;
// verbose args/results become nested rows only in expanded detail mode.

import { memo, useMemo } from "react"
import type { ToolPart as Part } from "../../../types/message"
import type { DetailMode } from "../../../context/preferences"
import { isDiff } from "../DiffBlock"
import { InlineTool, type Branch, type Detail } from "./frame"
import { Subagent } from "./Subagent"
import { spec } from "./preview"

const CHARS = 800
const LINES = 12
const TRAIL = 8

function short(s: string | undefined, n = 120): string {
  if (!s) return ""
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? one.slice(0, n - 1) + "…" : one
}

function cap(s: string): string {
  const raw = s.trim()
  let n = 1
  for (let i = 0; i < raw.length; i++) {
    if (i >= CHARS) return `${raw.slice(0, i).trimEnd()}\n…`
    if (raw[i] === "\n" && ++n > LINES) return `${raw.slice(0, i).trimEnd()}\n…`
  }
  return raw
}

function lines(s: string): number {
  let n = 1
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n" && ++n >= 5) return 6
  }
  return n + 1
}

const Inline = memo(({ branch, details, tool }: { branch?: Branch; details?: Detail[]; tool: Part }) => {
  const s = spec(tool.name)
  const body = tool.preview && !isDiff(tool.preview) ? short(tool.preview) : ""
  const label = s.verb && body ? `${s.verb} ${body}` : body || s.verb || tool.name
  return (
    <InlineTool branch={branch} part={tool} complete={!!body || tool.status !== "running"} details={details}>
      {label}
    </InlineTool>
  )
})

export function visible(tool: Part, mode: DetailMode): boolean {
  return mode !== "hidden" || tool.status === "running"
}

function details(tool: Part, mode: DetailMode): Detail[] {
  const full = tool.verboseResult && !isDiff(tool.verboseResult) ? tool.verboseResult : undefined
  const sum = tool.result && !isDiff(tool.result) ? tool.result : undefined
  const err: Detail | undefined = tool.status === "error" && (full || sum)
    ? { label: "Error", text: cap(full ?? sum!), tone: "error" }
    : undefined

  if (mode !== "expanded") return err ? [err] : []

  const out: Detail[] = []
  if (tool.verboseArgs) out.push({ label: "Args", text: cap(tool.verboseArgs) })
  if (err) out.push(err)
  if (tool.verboseResult && tool.status !== "error" && !isDiff(tool.verboseResult)) {
    out.push({ label: "Result", text: cap(tool.verboseResult) })
  }
  return out
}

export function cost(tool: Part, mode: DetailMode): number {
  if (!visible(tool, mode)) return 0
  if (tool.trail) return 2 + Math.min(tool.trail.length, TRAIL)
  if (tool.name === "delegate_task") return 2
  return 1 + details(tool, mode).reduce((n, d) => n + lines(d.text), 0)
}

export const Tool = memo(({ branch, tool, detail = "expanded" }: { branch?: Branch; tool: Part; detail?: DetailMode }) => {
  const list = useMemo(() => details(tool, detail), [tool, detail])
  if (!visible(tool, detail)) return null
  if (tool.trail || tool.name === "delegate_task") return <Subagent branch={branch} tool={tool} />
  return <Inline branch={branch} details={list} tool={tool} />
})
