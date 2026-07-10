// Tabbed diff frame for an assistant turn. Tabs stay visible; clicking
// a tab toggles that diff body inline.

import { memo, useMemo, useState } from "react"
import type { MouseEvent } from "@opentui/core"
import type { ToolPart } from "../../types/message"
import { LEFT_BAR } from "../../ui/borders"
import { DiffBlock, isDiff } from "./DiffBlock"
import { useTheme } from "../../theme"
import { sanitize as clean } from "../../utils/sanitize"

// `tool.preview` is whatever the gateway's tool.start.context emitted —
// for patch/edit tools that's a clean path. But on tool.complete, the
// reducer overwrites preview with `summary || inline_diff || preview`,
// and `inline_diff` from the gateway is the CLI-rendered blob:
//   `a/<path> → b/<path>` (the standard `--- a/` / `+++ b/` headers are
//   REPLACED with this arrow form — see display.py `_render_inline_unified_diff`)
//   followed by `@@`, `-`, `+`, ` ` lines, plus a `┊ review diff` marker
//   and a `+N/-M` summary. Order: parse args JSON → gateway arrow form
//   (`a/<path> → b/<path>`) → standard `+++ b/<path>` → standard `--- a/<path>`
//   → cleaned preview. Without this every tab label reads as the diff tail
//   (`…@`, `… autumn`, `…)`) — `t_49b65e76`.
const PATH_KEY = /"(?:path|file_path|filename|target|file)"\s*:\s*"((?:\\.|[^"\\])*)"/
// Gateway arrow form: matches `a//tmp/x.txt → b//tmp/x.txt` (paths often
// have leading `/` so we see `a//`). Prefer the `b/` (after) path.
const DIFF_HEAD_ARROW = /(?:^|\s)a\/+\S.*?\s*→\s*b\/+(\S.+?)\s*$/m
const DIFF_HEAD_NEW = /^\+\+\+ b?\/+(\S.*?)\s*$/m
const DIFF_HEAD_OLD = /^--- a?\/+(\S.*?)\s*$/m
const VERB = /^(?:Browsing|Clicking|Delegating|Editing|Generating image|Generating speech|Generating video|Listing skills|Looking at the image|Reading skill|Reading|Running code|Running|Scheduling|Searching files for|Searching past sessions|Searching the web for|Typing|Updating memory|Updating skill|Updating tasks|Writing)\s+(.+)$/
function pathFor(t: ToolPart): string {
  const args = (t as { args?: string }).args
  if (args && /^\s*\{/.test(args)) {
    const m = clean(args).match(PATH_KEY)
    if (m) return m[1]
  }
  const sources = [t.diff, t.preview].filter((s): s is string => !!s)
  for (const s of sources) {
    const c = clean(s)
    const m = c.match(DIFF_HEAD_ARROW) || c.match(DIFF_HEAD_NEW) || c.match(DIFF_HEAD_OLD)
    if (m) return m[1]
  }
  const fallback = clean(t.preview ?? t.name)
  return fallback.match(VERB)?.[1] ?? fallback
}

// Strip the gateway's CLI-rendered chrome from inline_diff so DiffBlock
// only sees real unified-diff lines. Drops `┊ review diff` markers, the
// `+N/-M` summary line, CLI-truncated `…` context lines, and the
// gateway's `a/path → b/path` header form (DiffBlock would otherwise
// render it as a literal context line). Cosmetic loss only — the body
// still shows the actual changed hunk lines.
const STRIPS = [
  /^\s*┊.*$/,                          // CLI prefix marker
  /^\s*[+-]\d+\s*\/\s*[-+]\d+\s*$/,    // +N/-M summary line
  /^\s*…/,                             // CLI truncation marker
  /a\/+\S.*?\s*→\s*b\/+\S/,            // gateway's `a/x → b/x` header
]
function sanitizeDiff(s: string): string {
  return clean(s).split("\n").filter(l => !STRIPS.some(re => re.test(l))).join("\n")
}

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const parent = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : ""
}
const trunc = (s: string, n: number) => s.length <= n ? s : "…" + s.slice(-(n - 1))

type Tab = { id: string; label: string; diff: string; add: number; del: number }

function buildTabs(tools: ToolPart[]): Tab[] {
  const raw = tools.flatMap(t => {
    const rawDiff = t.diff ?? (isDiff(t.result) ? t.result : undefined)
    if (!rawDiff) return []
    return [{ tool: t, path: pathFor(t), diff: sanitizeDiff(rawDiff) }]
  })
  // Disambiguate duplicate basenames (a/Foo.tsx + b/Foo.tsx) by prefixing
  // the parent dir only when needed — keeps short labels short.
  const counts = new Map<string, number>()
  raw.forEach(r => counts.set(base(r.path), (counts.get(base(r.path)) ?? 0) + 1))
  return raw.map(({ tool, path, diff }) => {
    const b = base(path)
    const dup = (counts.get(b) ?? 0) > 1 && parent(path)
    const label = trunc(dup ? `${parent(path)}/${b}` : b, 24)
    const lines = diff.split("\n")
    const add = lines.filter(l => /^\+(?!\+\+)/.test(l)).length
    const del = lines.filter(l => /^-(?!--)/.test(l)).length
    return { id: tool.id || `${tool.name}-${path}`, label, diff, add, del }
  })
}

export const DiffTabs = memo(({ tools }: { tools: ToolPart[] }) => {
  const theme = useTheme().theme
  const tabs = useMemo(() => buildTabs(tools), [tools])
  const [active, setActive] = useState<number | null>(null)
  if (tabs.length === 0) return null
  const idx = active === null ? null : Math.min(active, tabs.length - 1)
  const cur = idx === null ? null : tabs[idx]

  return (
    <box
      flexDirection="column" marginTop={1}
      border={["left"]} borderColor={theme.border} customBorderChars={LEFT_BAR}
      backgroundColor={theme.backgroundPanel} paddingLeft={1}
    >
      <box
        flexDirection="row" flexWrap="wrap"
        backgroundColor={theme.backgroundElement} paddingX={1}
      >
        {tabs.map((t, i) => {
          const on = i === idx
          return (
            <box
              key={t.id} height={1} flexShrink={0} marginRight={1} paddingX={1}
              backgroundColor={on ? theme.backgroundPanel : undefined}
              onMouseDown={(e: MouseEvent) => {
                e.stopPropagation()
                setActive(n => {
                  const hit = n === null ? null : Math.min(n, tabs.length - 1)
                  return hit === i ? null : i
                })
              }}
            >
              <text fg={on ? theme.primary : theme.textMuted}>
                {on ? <strong>{t.label}</strong> : t.label}
              </text>
            </box>
          )
        })}
      </box>
      {cur ? <>
        <box height={1} paddingX={1}>
          <text>
            <span fg={theme.success}>+{cur.add}</span>
            <span fg={theme.textMuted}> / </span>
            <span fg={theme.error}>-{cur.del}</span>
          </text>
        </box>
        <box paddingX={1} paddingBottom={1}>
          <DiffBlock text={cur.diff} />
        </box>
      </> : null}
    </box>
  )
})
