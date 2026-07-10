// MEDIA: directive rendering — `MEDIA:/path` lines in assistant output
// become clickable chips instead of literal text. Neither reference
// (Ink nor opencode) renders pixels; both surface an openable link.
// OpenTUI has no image primitive, so this is the ceiling for now.

import { memo, useState } from "react"
import { TextAttributes, type MouseEvent } from "@opentui/core"
import { openFile } from "../../utils/open-file"
import { image as imagePath } from "../../utils/terminal-image"
import { useTheme } from "../../theme"

// Ink's canonical regex. Match-per-line only — a MEDIA path is the
// whole line, optionally wrapped in backticks/quotes by the model.
export const MEDIA_LINE_RE = /^\s*[`"']?MEDIA:\s*(\S+?)[`"']?\s*$/

const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "opus"])
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv"])
const IMG_RE = /!\[[^\]\n]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g

export type MediaKind = "img" | "audio" | "video" | "file" | "url"

export function classify(path: string): MediaKind {
  if (/^https?:\/\//i.test(path)) return "url"
  if (imagePath(path)) return "img"
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  if (AUDIO_EXT.has(ext)) return "audio"
  if (VIDEO_EXT.has(ext)) return "video"
  return "file"
}

const basename = (p: string) => p.split(/[/\\]/).pop() || p

export type Seg = { md: string } | { media: string } | { code: string; lang?: string }

// Split text into alternating markdown / media / code segments.
// Adjacent markdown lines are re-joined so OpenTUI's MarkdownRenderable
// still sees complete paragraphs. MEDIA lines inside fenced code are
// left as literal text (they're examples, not directives). Fences emit
// a `code` segment so MessageItem can wrap them with chrome; a trailing
// unclosed fence stays in the markdown buffer so streaming output
// doesn't flash into a CodeBlock mid-word.
export function splitContent(text: string): Seg[] {
  if (!text.includes("MEDIA:") && !text.includes("```") && !text.includes("~~~") && !text.includes("!["))
    return [{ md: text }]
  const out: Seg[] = []
  let buf: string[] = []
  let fence: { mark: string; lang?: string; body: string[] } | null = null
  const flush = () => {
    if (buf.length) out.push({ md: buf.join("\n") })
    buf = []
  }
  for (const line of text.split("\n")) {
    const f = line.match(/^\s*(`{3,}|~{3,})\s*(\S*)/)
    if (f) {
      if (fence && f[1][0] === fence.mark[0] && f[1].length >= fence.mark.length) {
        out.push({ code: fence.body.join("\n"), lang: fence.lang || undefined })
        fence = null
        continue
      }
      if (!fence) {
        flush()
        fence = { mark: f[1], lang: f[2], body: [] }
        continue
      }
    }
    if (fence) { fence.body.push(line); continue }
    const m = line.match(MEDIA_LINE_RE)?.[1]
    if (m) { flush(); out.push({ media: m }); continue }
    let at = 0
    let hit = false
    for (const img of line.matchAll(IMG_RE)) {
      const path = img[1]
      if (!imagePath(path)) continue
      if (!hit) flush()
      if (img.index > at) out.push({ md: line.slice(at, img.index) })
      out.push({ media: path })
      at = img.index + img[0].length
      hit = true
    }
    if (hit) {
      if (at < line.length) out.push({ md: line.slice(at) })
      continue
    }
    buf.push(line)
  }
  // Unclosed fence → put it back verbatim so the markdown renderable
  // shows the partial block while the stream is still producing it.
  if (fence) {
    const tail = [fence.mark + (fence.lang ?? ""), ...fence.body].join("\n")
    const last = out[out.length - 1]
    if (last && "md" in last) last.md += "\n" + tail
    else buf.push(tail)
  }
  flush()
  return out
}

export const MediaChip = memo((props: {
  path: string
  bare?: boolean
  /** Override the default open-file click. Handlers stopPropagation so
   *  the enclosing message's useClick (→ actions menu) never sees the
   *  down event. Pass to repurpose the chip (e.g. ChafaImage collapse). */
  onMouseDown?: (e: MouseEvent) => void
}) => {
  const theme = useTheme().theme
  const [hover, setHover] = useState(false)
  const kind = classify(props.path)
  const badge = {
    img: theme.accent, audio: theme.warning, video: theme.info,
    url: theme.primary, file: theme.secondary,
  }[kind]
  const click = props.onMouseDown
    ?? ((e: MouseEvent) => { e.stopPropagation(); openFile(props.path) })
  if (props.bare) return (
    <box
      flexDirection="row" height={1}
      onMouseDown={click}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <text>
        <span fg={theme.text}
              attributes={hover ? TextAttributes.UNDERLINE : TextAttributes.NONE}>
          {basename(props.path)}
        </span>
      </text>
    </box>
  )
  return (
    <box
      flexDirection="row" height={1}
      onMouseDown={click}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <text>
        <span bg={badge} fg={theme.background}> {kind} </span>
        <span bg={theme.backgroundElement} fg={theme.text}
              attributes={hover ? TextAttributes.UNDERLINE : TextAttributes.NONE}>
          {" "}{basename(props.path)}{" "}
        </span>
      </text>
    </box>
  )
})
