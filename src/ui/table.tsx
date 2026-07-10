import { useRef, useEffect, useState, type ReactNode } from "react"
import { TextAttributes, type RGBA } from "@opentui/core"
import { useTheme } from "../theme"
import { prefs } from "../context/preferences"

// Flex-cell column primitive for list tabs. Replaces the .padEnd(N)
// single-<text> pattern that bleeds whenever a value exceeds its pad
// width or the terminal narrows. A Col is either fixed-width-clipped
// (w) or grow-truncated (grow); height=1 + overflow=hidden guarantees
// single-line, so the worst case is an ellipsis-free cut, never a
// shove into the neighbouring column.

// Scrollbox v-bar steals 1 col from body rows. Headers that sit
// outside the scrollbox pad by the same so the grow column lands on
// identical x in both. Requires the scrollbox to force its v-bar
// visible (auto-hide would make the gutter conditional → post-layout
// feedback loop).
export const VBAR_W = 1

// Stable prop for list scrollboxes so `updateProperties`' `!==`
// check doesn't re-set the scrollbar config on every host reconcile.
// Inline `{{ visible: true }}` is a new object each render → every
// reconcile triggers `setProperty → requestRender()` for nothing.
export const VBAR = { visible: true } as const

export const Col = (p: {
  /** Fixed width in cells. Mutually exclusive with `grow`. */
  w?: number
  /** Take remaining width; truncates under narrow terminals. */
  grow?: boolean
  /** Floor for a grow column (default 12). Ignored when `w` is set. */
  min?: number
  right?: boolean
  fg?: RGBA
  bold?: boolean
  /** Header-cell click — for sortable-column affordances. */
  onClick?: () => void
  children: string
}) => {
  const theme = useTheme().theme
  const fg = p.fg ?? theme.text
  return (
    <box width={p.w} flexGrow={p.grow ? 1 : 0} flexShrink={p.grow ? 1 : 0}
         minWidth={p.grow ? (p.min ?? 12) : p.w} height={1} overflow="hidden"
         onMouseDown={p.onClick}
         flexDirection="row" justifyContent={p.right ? "flex-end" : "flex-start"}>
      <text>{p.bold
        ? <span fg={fg}><strong>{p.children}</strong></span>
        : <span fg={fg}>{p.children}</span>}</text>
    </box>
  )
}

// Header row container. paddingRight mirrors the body scrollbox's
// v-bar so header and data Cols share available width.
export const Hdr = (p: { children: ReactNode }) => (
  <box flexDirection="row" height={1} paddingRight={VBAR_W}>
    {p.children}
  </box>
)

// A Col that horizontal-scrolls its text while active. The box still
// truncates via overflow; the string is just rotated each tick so the
// clipped slice advances. Only animates when the full text doesn't
// fit (measured post-layout from the renderable's width), so
// non-truncated cells and unselected rows don't tick.
export const Marquee = (p: {
  w?: number; grow?: boolean; min?: number
  fg?: RGBA; bold?: boolean; underline?: boolean
  active: boolean
  /** ms per character step (default 180). */
  speed?: number
  /** ms to sit still before scrolling starts (default 600). */
  hold?: number
  children: string
}) => {
  const theme = useTheme().theme
  const fg = p.fg ?? theme.text
  const text = p.children
  const box = useRef<import("@opentui/core").BoxRenderable | null>(null)
  const node = useRef<import("@opentui/core").TextRenderable | null>(null)

  const animate = prefs.get("animations") !== false && p.active
  // `wraps` gates the `text + GAP + text` duplication. Without it, a
  // title shorter than the column renders twice (e.g. "fix tests   fix
  // tests") because overflow="hidden" can't clip what already fits.
  // Flipped from the layout effect once per row/text change — O(1),
  // not per-tick, so scrollX stays the hot path.
  const [wraps, setWraps] = useState(false)
  useEffect(() => {
    const tn = node.current
    if (!tn) return
    const w = box.current?.width ?? 0
    setWraps(text.length > w)
    if (!animate) { tn.scrollX = 0; return }
    // Hold static briefly before scrolling so the cell is readable at
    // rest on select; also keeps frame-snapshot tests deterministic.
    // scrollX on the TextRenderable is a direct native paint request
    // — zero React reconciles per tick (vs ~5/s at 180ms with the
    // previous setState(off)).
    let id: ReturnType<typeof setInterval> | undefined
    const period = text.length + GAP.length
    const hold = setTimeout(() => {
      id = setInterval(() => {
        const cur = box.current?.width ?? 0
        if (text.length <= cur) { tn.scrollX = 0; return }
        tn.scrollX = (tn.scrollX + 1) % period
      }, p.speed ?? 180)
    }, p.hold ?? 600)
    return () => {
      clearTimeout(hold); if (id) clearInterval(id)
      if (node.current) node.current.scrollX = 0
    }
  }, [animate, text, p.speed, p.hold])

  // When `wraps`, render `text + GAP + text` so scrollX can roll the
  // tail→head seam through the viewport. Otherwise plain `text` — the
  // second copy would be visible inside the fitting column.
  const body = wraps ? text + GAP + text : text
  return (
    <box ref={box}
         width={p.w} flexGrow={p.grow ? 1 : 0} flexShrink={p.grow ? 1 : 0}
         minWidth={p.grow ? (p.min ?? 12) : p.w} height={1} overflow="hidden">
      <text ref={node} wrapMode="none">{p.bold
        ? <span fg={fg} attributes={p.underline ? TextAttributes.UNDERLINE : TextAttributes.NONE}><strong>{body}</strong></span>
        : <span fg={fg} attributes={p.underline ? TextAttributes.UNDERLINE : TextAttributes.NONE}>{body}</span>}</text>
    </box>
  )
}
const GAP = "   "
