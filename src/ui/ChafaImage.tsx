// Inline image rendering via chafa + the SGR parser (utils/chafa.ts).
// Shown in-transcript when an assistant response or user attachment contains
// MEDIA:/path/to/image.ext. Click to collapse to a compact chip; click chip
// to re-expand. Any render failure (chafa missing, file gone, timeout)
// silently degrades to the plain MediaChip — no error chrome in the stream.

import { memo, useEffect, useState } from "react"
import type { MouseEvent } from "@opentui/core"
import { useTheme } from "../theme"
import { openFile } from "../utils/open-file"
import { renderChafa, hex, chafaBin, type Rendered } from "../utils/chafa"
import { strategy } from "../utils/terminal-image"
import { MediaChip } from "../components/chat/MediaChip"

const basename = (p: string) => p.split(/[/\\]/).pop() || p

type Props = {
  path: string
  width?: number
  bare?: boolean
  chafa?: boolean
  load?: (path: string, width: number) => Promise<Rendered>
}

export const ChafaImage = memo(({ path, width, bare, chafa, load = renderChafa }: Props) => {
  const theme = useTheme().theme
  const [collapsed, setCollapsed] = useState(false)
  const [result, setResult] = useState<Rendered | null>(null)
  const w = Math.max(20, Math.min(80, width ?? 60))
  const preview = strategy(path, chafa ?? chafaBin() !== null)

  useEffect(() => {
    let live = true
    setResult(null)
    if (preview.kind !== "chafa") return () => { live = false }
    void load(path, w).then(
      value => { if (live) setResult(value) },
      err => { if (live) setResult({ err: err instanceof Error ? err.message : String(err) }) },
    )
    return () => { live = false }
  }, [path, w, preview.kind, load])

  if (preview.kind !== "chafa" || !result || "err" in result) return <MediaChip path={path} bare={bare} />

  // Collapsed → chip re-expands on click. Override MediaChip's default
  // openFile so the click does exactly one thing; stopPropagation keeps
  // it from reaching the message's useClick (→ actions menu).
  if (collapsed) {
    return (
      <MediaChip path={path}
        bare={bare}
        onMouseDown={(e: MouseEvent) => { e.stopPropagation(); setCollapsed(false) }} />
    )
  }

  return (
    <box flexDirection="column" marginTop={bare ? 0 : 1}>
      <box flexDirection="column"
           onMouseDown={(e: MouseEvent) => { e.stopPropagation(); if (!bare) setCollapsed(true) }}>
        {result.rows.map((row, i) => (
          <text key={i}>
            {row.map((c, j) => (
              <span key={j} fg={hex(c.fg)} bg={hex(c.bg)}>{c.ch}</span>
            ))}
          </text>
        ))}
      </box>
      {bare ? null : <box height={1}
           onMouseDown={(e: MouseEvent) => { e.stopPropagation(); openFile(path) }}>
        <text>
          <span fg={theme.textMuted}>{"  "}</span>
          <span fg={theme.accent}>◉ </span>
          <span fg={theme.text}>{basename(path)}</span>
          <span fg={theme.textMuted}>{"  click image to collapse · click name to open"}</span>
        </text>
      </box>}
    </box>
  )
})
