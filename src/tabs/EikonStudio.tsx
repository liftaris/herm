// Eikon Studio — three-pane editor over the active eikon folder.
//
//   Preview (left)  48×24 frame; mouse drag-pan, wheel-zoom, arrows pan.
//                   Minimap overlay bottom-right (half-block viewport).
//   Knobs   (right) rasterizer/source/name + actions + rasterizer-
//                   declared tonal rows rendered generically.
//   States  (bottom-left) six 16×8 thumbnails; Enter → per-state menu.
//
// Tab cycles panes (knobs→preview→strip). Ctrl+S saves the draft.
// Ctrl+U saves and activates. Esc on a dirty draft confirms discard.
// nav.md: no letter mnemonics beyond `n` (new) on knobs-onNew.

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { extend, useKeyboard, useTerminalDimensions } from "@opentui/react"
import { SliderRenderable } from "@opentui/core"
import type { ParsedKey, ScrollBoxRenderable } from "@opentui/core"
import { existsSync } from "node:fs"
import { basename } from "node:path"
import type { Dispatch, ReactNode, SetStateAction } from "react"
import { useTheme } from "../theme"
import type { Theme } from "../theme/types"
import { Spinner } from "../ui/spinner"
import { useKeys, handleListKey } from "../keys"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { DialogSelect } from "../ui/dialog-select"
import { openConfirm, openSaveDiscard } from "../dialogs/confirm"
import { openTextPrompt } from "../dialogs/text-prompt"
import { openPathPrompt } from "../dialogs/path-prompt"
import { openGenerate, type GenerateKind } from "../dialogs/eikon-generate"
import { openEikonSubmit } from "../dialogs/eikon-submit"
import * as submitSvc from "../service/eikon-submit"
import { gen } from "../service/eikon-gen"
import { useGateway } from "../context/gateway"
import { openNewEikon } from "../dialogs/new-eikon"
import { BUNDLED_EIKON_DIR } from "../components/avatar/bundled"
import { hermesPath } from "../service/hermes-home"
import { listEikons } from "../components/avatar/eikon"
import * as prefs from "../context/preferences"
import { eikon } from "../service/eikon"
import type { ParsedEikon } from "../components/avatar/eikon"
import { W, H, FPS0, caps, thumb, cached, resetCache, prewarm,
         type Rasterizer, type KnobDef, type Spatial, type Tone, type Flip, type Frame } from "../utils/eikon-render"
import { knobs, STATES, type Session } from "../utils/eikon-knobs"
import type { AvatarState } from "../components/avatar/states"
import { useSpinnerGlyph } from "../ui/spinner"
import type { MouseEvent } from "@opentui/core"

// SliderRenderable ships in @opentui/core but isn't in react's default
// catalogue; register it once so `<slider>` is a valid intrinsic.
extend({ slider: SliderRenderable })
declare module "@opentui/react" {
  interface OpenTUIComponents { slider: typeof SliderRenderable }
}

type Pane = "knobs" | "preview" | "strip"
const PANES: readonly Pane[] = ["knobs", "preview", "strip"]
// Help footer rows (fixed so the narrow layout can size the panel
// deterministically without measuring post-wrap).
const HELP_H = 4
// Stable contentOptions — inline `{}` would re-set on every reconcile.
const COL = { flexDirection: "column" } as const

type RowKind = "select" | "prompt" | "action" | "divider" | "header" | "knob" | "tone"
type Row = {
  id: string; kind: RowKind; label: string
  knob?: KnobDef
  show?: (s: Session, status: eikon.SourceStatus) => boolean
}

const mb = (n: number) => n < 1024 ? `${n} B`
  : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`

const HEAD: readonly Row[] = [
  { id: "open",       kind: "select", label: "eikon" },
  { id: "rasterizer", kind: "select", label: "rasterizer" },
  { id: "source",     kind: "prompt", label: "source" },
  { id: "-1",         kind: "divider", label: "" },
  { id: "fetch",      kind: "action", label: "download source",
    show: (_s, status) => status.downloadable },
  { id: "knobsfor",   kind: "action", label: "tune",        show: (_s, status) => !!status.path },
  { id: "reset",      kind: "action", label: "reset",       show: (_s, status) => !!status.path },
  { id: "revert",     kind: "action", label: "revert",      show: s => s.dirty },
  { id: "-2",         kind: "divider", label: "", show: (_s, status) => !!status.path },
  { id: "h-input",    kind: "header",  label: "input", show: (_s, status) => !!status.path },
  { id: "contrast",   kind: "tone",    label: "contrast",   show: (_s, status) => !!status.path,
    knob: { kind: "slider", min: 0.25, max: 4, step: 0.05, default: 1,
            hint: "Spread pixel values around their mean. ×1 = source as-is; higher sharpens, lower flattens. Applied to the image before rasterizing." } },
  { id: "invert",     kind: "tone",    label: "invert",     show: (_s, status) => !!status.path,
    knob: { kind: "toggle", default: true,
            hint: "Swap light↔dark in the source pixels. On for a light subject on a dark terminal background — turn off if the subject is darker than its surround." } },
  { id: "flip",       kind: "tone",    label: "flip",       show: (_s, status) => !!status.path,
    knob: { kind: "cycle", options: ["none", "h", "v", "hv"], default: "none",
            hint: "Mirror the source horizontally, vertically, or both before rasterizing." } },
  { id: "-3",         kind: "divider", label: "", show: (_s, status) => !!status.path },
]

// One-sentence help per row, shown at the bottom of the Settings
// pane when the row is selected/hovered. Rasterizer-declared knobs
// fall through to helpOf() which reads KnobDef.hint or synthesizes
// one from the knob kind.
const HELP: Readonly<Record<string, string>> = {
  open:       "Which eikon you're editing. Enter to switch, create a new one, or install from elsewhere.",
  rasterizer: "The engine that turns your source image/video into text art. Each rasterizer exposes its own look-and-feel settings below the divider.",
  source:     "Pick, generate, or clear source.",
  fetch:      "Download published source for local editing.",
  knobsfor:   "←→ toggles whether the settings below apply to every state or just the one selected in the strip.",
  reset:      "Restore every setting below to this rasterizer's defaults and drop per-state overrides.",
  submit:     "Submit this local eikon after backend preflight.",
  revert:     "Throw away unsaved edits and reload this eikon from disk.",
}

const FLIPS: readonly Flip[] = ["none", "h", "v", "hv"]

function helpOf(row: Row | undefined): ReactNode {
  if (!row) return ""
  if (row.id === "source") return <>
    <span>{HELP.source}</span>
  </>
  const head = HELP[row.id]
  if (head) return head
  if (!row.knob) return ""
  if (row.knob.hint) return row.knob.hint
  if (row.knob.kind === "cycle")
    return `←→ or Enter cycles: ${row.knob.options.join(" · ")}.`
  if (row.knob.kind === "toggle") return "Space or Enter toggles on/off."
  return `←→ or drag adjusts (${row.knob.min}–${row.knob.max}); scroll while selected also works.`
}

function buildRows(r: Rasterizer, s: Session, status: eikon.SourceStatus): Row[] {
  const dyn = status.path
    ? Object.entries(r.knobs).map<Row>(([id, def]) =>
        ({ id, kind: "knob", label: def.label ?? id, knob: def }))
    : []
  const head = HEAD.filter(h => h.show ? h.show(s, status) : true)
  return dyn.length
    ? [...head, { id: "h-r", kind: "header", label: r.name }, ...dyn]
    : head
}

// ── Minimap (read-only) ──────────────────────────────────────────────

const MINI_W = 12

function Mini(props: { sp: Spatial; dims: Session["dims"] }) {
  const theme = useTheme().theme
  const d = props.dims ?? { w: 1, h: 1 }
  const ar = d.w / d.h
  // Half-block rows: render on a bw×bh virtual grid, two v-cells per
  // text line, so the viewport rect has sub-row precision.
  const bw = ar >= 1 ? MINI_W : Math.max(4, Math.round(MINI_W * ar))
  const bh = ar >= 1 ? Math.max(4, Math.round(MINI_W / ar)) : MINI_W
  const short = Math.min(bw, bh)
  const cw = Math.max(1, short * props.sp.zoom)
  const cx = (bw - cw) * props.sp.ox
  const cy = (bh - cw) * props.sp.oy
  const on = (x: number, y: number) => x >= cx && x < cx + cw && y >= cy && y < cy + cw
  const cell = (x: number, ty: number) => {
    const up = on(x, ty * 2), dn = on(x, ty * 2 + 1)
    return up && dn ? "█" : up ? "▀" : dn ? "▄" : "·"
  }
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.backgroundElement}>
      {Array.from({ length: Math.ceil(bh / 2) }, (_, ty) => (
        <text key={ty} fg={theme.textMuted}>
          {Array.from({ length: bw }, (_, x) => cell(x, ty)).join("")}
        </text>
      ))}
    </box>
  )
}

/** Preview-pane nav order. pan-x/pan-y render as scrollbar-style
 *  sliders flanking the frame (no label); zoom/fps stay as labeled
 *  rows beside the minimap. ↑↓ still walks all four. */
const SP_ROWS = ["pan x", "pan y", "zoom", "fps"] as const
type SpRow = typeof SP_ROWS[number]
type SpKey = keyof Spatial | "fps"

/** SliderRenderable's viewPortSize setter clamps to ≤ range, so its
 *  scrollbar model can never reach thumb=track (z→1 is asymptotic).
 *  Render the thumb directly instead: length = z·track exactly.
 *  pan-x is a single W-char █-run; pan-y is a 2-wide half-block
 *  column (2H virtual rows, same trick as Mini) for sub-row
 *  precision. Drag scrubs by cell-delta from the grab point. */
function PanBars(props: {
  sp: Spatial; sel: number; focused: boolean
  onHover: (i: number) => void; onSet: (k: SpKey, v: number) => void
  onWheel: (k: SpKey, d: 1 | -1) => void
  children: import("react").ReactNode
}) {
  const theme = useTheme().theme
  const z = props.sp.zoom
  const slack = 1 - z
  const on = (i: number) => props.focused && props.sel === i
  const fg = (i: number) => on(i) ? theme.accent : theme.textMuted
  const wheel = (k: SpKey) => (e: MouseEvent) => {
    e.stopPropagation()
    const d = e.scroll?.direction
    if (d === "up" || d === "left") props.onWheel(k, -1)
    if (d === "down" || d === "right") props.onWheel(k, 1)
  }
  const drag = useRef<{ at: number; v: number; k: "ox" | "oy" } | null>(null)
  const grab = (k: "ox" | "oy", at: number) => { drag.current = { at, v: props.sp[k], k } }
  const scrub = (at: number, L: number) => {
    const d = drag.current
    if (!d || slack <= 0) return
    props.onSet(d.k, Math.max(0, Math.min(1, +(d.v + (at - d.at) / (slack * L)).toFixed(3))))
  }
  const drop = () => { drag.current = null }
  const tw = Math.max(1, Math.round(z * W))
  const tl = Math.min(W - tw, Math.round(props.sp.ox * slack * W))
  const hbar = " ".repeat(tl) + "█".repeat(tw) + " ".repeat(W - tl - tw)
  const vh = H * 2, th = Math.max(1, z * vh), ty = props.sp.oy * slack * vh
  const vbar = Array.from({ length: H }, (_, y) => {
    const up = y * 2 >= ty && y * 2 < ty + th, dn = y * 2 + 1 >= ty && y * 2 + 1 < ty + th
    return up && dn ? "██" : up ? "▀▀" : dn ? "▄▄" : "  "
  })
  return (
    <box flexDirection="row" flexShrink={0}>
      <box flexDirection="column" flexShrink={0}>
        {props.children}
        <box width={W} height={1} backgroundColor={theme.border}
             onMouseMove={() => props.onHover(0)} onMouseScroll={wheel("ox")}
             onMouseDown={(e: { x: number }) => grab("ox", e.x)}
             onMouseDrag={(e: { x: number }) => scrub(e.x, W)}
             onMouseUp={drop} onMouseDragEnd={drop}>
          <text fg={fg(0)}>{hbar}</text>
        </box>
      </box>
      <box flexDirection="column" width={2} height={H} backgroundColor={theme.border}
           onMouseMove={() => props.onHover(1)} onMouseScroll={wheel("oy")}
           onMouseDown={(e: { y: number }) => grab("oy", e.y)}
           onMouseDrag={(e: { y: number }) => scrub(e.y, H)}
           onMouseUp={drop} onMouseDragEnd={drop}>
        {vbar.map((g, y) => <text key={y} fg={fg(1)}>{g}</text>)}
      </box>
    </box>
  )
}

/** zoom + fps labeled sliders + read-only minimap. */
function SpatialBar(props: {
  sp: Spatial; fps: number; dims: Session["dims"]
  sel: number; focused: boolean
  onHover: (i: number) => void
  onSet: (k: SpKey, v: number) => void
  onWheel: (k: SpKey, d: 1 | -1) => void
}) {
  const theme = useTheme().theme
  const rows: Array<{ label: SpRow; k: SpKey; min: number; max: number; v: number; i: number }> = [
    { label: "zoom", k: "zoom", min: 0.1, max: 1.0, v: props.sp.zoom, i: 2 },
    { label: "fps",  k: "fps",  min: 4,   max: 30,  v: props.fps,     i: 3 },
  ]
  const wheel = (k: SpKey) => (e: MouseEvent) => {
    e.stopPropagation()
    const d = e.scroll?.direction
    if (d === "up") props.onWheel(k, -1)
    if (d === "down") props.onWheel(k, 1)
  }
  return (
    <box flexDirection="row" marginTop={1} flexShrink={0}>
      <box flexDirection="column" gap={1} flexShrink={0}>
        {rows.map(d => {
          const on = props.focused && d.i === props.sel
          return (
            <box key={d.label} height={1} flexDirection="row"
                 backgroundColor={on ? theme.backgroundElement : undefined}
                 onMouseMove={() => props.onHover(d.i)} onMouseScroll={wheel(d.k)}>
              <box width={2}><text fg={on ? theme.primary : theme.textMuted}>{on ? "▸ " : "  "}</text></box>
              <box width={7}><text fg={on ? theme.text : theme.textMuted}>{d.label}</text></box>
              <box width={20} height={1}>
                <slider orientation="horizontal" min={d.min} max={d.max} value={d.v}
                        foregroundColor={on ? theme.accent : theme.textMuted}
                        backgroundColor={theme.border}
                        onChange={v => props.onSet(d.k, d.k === "fps" ? Math.round(v) : +v.toFixed(3))} />
              </box>
              <box width={7}><text fg={on ? theme.text : theme.textMuted}>
                {`  ${d.k === "fps" ? d.v.toFixed(0) : d.v.toFixed(2)}`}
              </text></box>
            </box>
          )
        })}
      </box>
      <box width={2} />
      <Mini sp={props.sp} dims={props.dims} />
    </box>
  )
}

const PreviewPane = memo((props: {
  s: Session | null
  frames: Frame[]
  play: boolean
  setPlay: Dispatch<SetStateAction<boolean>>
  focused: boolean
  busy: boolean
  live: boolean
  baked?: ParsedEikon
  spatialOk: boolean
  error: string | null
  pane: Pane
  sel: number
  onPane: (pane: Pane) => void
  onSel: (sel: number) => void
  onSet: (key: SpKey, value: number) => void
  onWheel: (key: SpKey, direction: 1 | -1) => void
  onScroll: (event: MouseEvent) => void
}) => {
  const theme = useTheme().theme
  const [tick, setTick] = useState(0)
  const n = props.frames.length
  const fps = props.live
    ? props.s?.fps ?? FPS0
    : props.baked?.states.get(props.s?.state ?? "idle")?.fps ?? FPS0

  useEffect(() => setTick(value => value % n), [props.frames, n])
  useEffect(() => {
    if (!props.play || !props.focused || n <= 1 || props.busy) return
    const id = setInterval(() => setTick(value => value + 1), 1000 / Math.max(1, fps))
    return () => clearInterval(id)
  }, [props.play, props.focused, n, props.busy, fps])

  const title = props.s
    ? `Preview — ${props.s.state}${props.s.per[props.s.state] ? " (forked)" : ""}`
      + (n > 1 ? `  ·  ${props.play ? "▶" : "⏸"} ${(tick % n) + 1}/${n}` : "")
      + (props.live ? "" : props.baked ? "  ·  (baked)" : "")
    : "Preview"
  const frame = props.frames[tick % n] ?? BLANK
  const body = (
    <box position="relative" flexDirection="column" width={W} height={H} flexShrink={0}
         backgroundColor={theme.background} onMouseScroll={props.onScroll}
         onMouseDown={() => props.setPlay(value => !value)}>
      {frame.map((line, i) =>
        <text key={i} fg={props.error ? theme.textMuted : theme.hermAvatar}>{line}</text>)}
      {props.busy && props.frames[0] === BLANK
        ? <box position="absolute" left={0} top={H >> 1} width={W} justifyContent="center">
            <Spinner color={theme.textMuted} label="decoding…" />
          </box>
        : null}
    </box>
  )

  return (
    <TabShell title={props.spatialOk ? title : `${title}  ·  (ffmpeg not installed)`}
              error={props.error} focus={props.pane === "preview"}>
      {!props.live && props.baked
        ? <box height={1} overflow="hidden">
            <text fg={theme.textMuted} wrapMode="none">Baked — download or attach source to edit.</text>
          </box>
        : null}
      {props.spatialOk && props.live && props.s
        ? <>
            <PanBars sp={props.s.spatial} sel={props.sel} focused={props.pane === "preview"}
              onHover={i => { props.onPane("preview"); props.onSel(i) }}
              onSet={props.onSet} onWheel={props.onWheel}>
              {body}
            </PanBars>
            <SpatialBar sp={props.s.spatial} fps={props.s.fps} dims={props.s.dims}
              sel={props.sel} focused={props.pane === "preview"}
              onHover={i => { props.onPane("preview"); props.onSel(i) }}
              onSet={props.onSet} onWheel={props.onWheel} />
          </>
        : body}
    </TabShell>
  )
})

// ── Knob row renderers ───────────────────────────────────────────────

function valueOf(s: Session, r: Rasterizer, row: Row, theme: Theme,
                 status?: eikon.SourceStatus, peek?: { n: number; bytes: number }, busy?: boolean): string | ReactNode {
  if (row.id === "open") return `${s.name} ▸`
  if (row.id === "rasterizer") {
    const a = r.available()
    if (a === true) return `${r.name} ▸`
    return <><span>{`${r.name} ▸`}</span><span fg={theme.warning}>{` ⚠ ${a}`}</span></>
  }
  if (row.id === "source") {
    if (!status?.path) {
      if (status?.kind === "downloadable") return "Download source"
      if (status?.kind === "baked") return "Baked only"
      return "Missing source"
    }
    const d = s.dims
    const sz = status.size === undefined ? "?" : mb(status.size)
    return d ? `${basename(status.path)} · ${d.w}×${d.h} · ${sz}` : `${basename(status.path)} · ${sz}`
  }
  if (row.id === "knobsfor") {
    const forked = !!s.per[s.state]
    return `◂ ${forked ? `${s.state} only` : "all states"} ▸`
  }
  if (row.id === "reset") return "▸ defaults"
  if (row.id === "revert") return "▸ reload from disk"
  if (row.kind === "tone") {
    if (row.id === "contrast") return `×${s.tone.contrast.toFixed(2)}`
    if (row.id === "invert") return s.tone.invert ? "● on" : "○ off"
    if (row.id === "flip") return `◂ ${s.tone.flip} ▸`
  }
  if (row.id === "fetch") return busy ? "downloading…"
    : peek ? `▸ ${peek.n} files · ${mb(peek.bytes)}` : "▸ local editable source"
  if (row.kind === "knob" && row.knob) {
    const k = knobs.eff(s, s.state)[row.id] ?? row.knob.default
    if (row.knob.kind === "cycle") return `◂ ${String(k)} ▸`
    if (row.knob.kind === "toggle") return k ? "● on" : "○ off"
    if (row.knob.kind === "slider") return Number(k).toFixed(2)
  }
  return ""
}

function KnobRow(props: {
  row: Row; s: Session; r: Rasterizer; status: eikon.SourceStatus
  on: boolean; dim: boolean; id: string
  peek?: { n: number; bytes: number }; busy?: boolean
  onHover: () => void; onClick: () => void
  onSlide?: (v: number) => void
  onWheel?: (d: 1 | -1) => void
}) {
  const theme = useTheme().theme
  const { row, on, dim } = props
  const slider = row.knob?.kind === "slider" ? row.knob : undefined
  const sval = !slider ? 0
    : row.kind === "tone" ? props.s.tone.contrast
    : Number(knobs.eff(props.s, props.s.state)[row.id] ?? slider.default)
  // SliderRenderable's `value` setter fires onChange, so a prop
  // update driven by open()/revert()/reset() echoes straight back
  // into onSlide and re-dirties the just-cleaned session. Track the
  // value we last pushed *to* the slider and drop onChange calls
  // that are just that echo.
  const pushed = useRef(sval); pushed.current = sval
  const slide = (v: number) => { if (v !== pushed.current) props.onSlide?.(v) }
  if (row.kind === "divider")
    return <box id={props.id} height={1}><text fg={theme.border}>{"─".repeat(24)}</text></box>
  if (row.kind === "header")
    return <box id={props.id} height={1}><text fg={theme.textMuted}><u>{row.label}</u></text></box>
  // Wheel over the selected slider row adjusts it and stops bubbling
  // so the enclosing scrollboxes don't also move. Unselected / non-
  // slider rows let the event through for normal list scrolling.
  const scroll = (e: MouseEvent) => {
    if (!on || !slider || !props.onWheel) return
    e.stopPropagation()
    const d = e.scroll?.direction
    if (d === "up" || d === "left") props.onWheel(-1)
    if (d === "down" || d === "right") props.onWheel(1)
  }
  return (
    <box id={props.id} height={1} flexDirection="row"
         backgroundColor={on ? theme.backgroundElement : undefined}
         onMouseMove={props.onHover} onMouseDown={props.onClick}
         onMouseScroll={scroll}>
      <box width={2}><text fg={on ? theme.primary : theme.textMuted}>{on ? "▸ " : "  "}</text></box>
      <box width={14}><text fg={dim ? theme.textMuted : on ? theme.text : theme.textMuted}>{row.label}</text></box>
      {slider ? (
        <>
          <box width={20} height={1}>
            <slider orientation="horizontal" min={slider.min} max={slider.max}
                    value={sval}
                    foregroundColor={on ? theme.accent : theme.textMuted}
                    backgroundColor={theme.border}
                    onChange={slide} />
          </box>
          <box width={1} />
        </>
      ) : null}
      <box flexGrow={1} minWidth={0} height={1} overflow="hidden">
        {props.busy && row.id === "fetch"
          ? <Spinner color={theme.accent} label="downloading…" />
          : <text fg={dim ? theme.textMuted : theme.text}>
              {valueOf(props.s, props.r, row, theme, props.status, props.peek, props.busy)}
            </text>}
      </box>
    </box>
  )
}

// ── State strip ──────────────────────────────────────────────────────

function Strip(props: {
  s: Session; frames: Map<AvatarState, Frame | undefined>
  stats: Map<AvatarState, eikon.SourceStatus>
  pending: ReadonlySet<AvatarState>
  focused: boolean; onPick: (st: AvatarState) => void
  onEmpty?: (st: AvatarState) => void
}) {
  const theme = useTheme().theme
  const glyph = useSpinnerGlyph(props.pending.size > 0)
  return (
    <box flexDirection="row" gap={1}>
      {STATES.map(st => {
        const on = props.s.state === st
        const own = !!props.s.per[st]
        const status = props.stats.get(st)!
        const mark = status.kind === "missing" ? "missing"
          : status.kind === "downloadable" ? "download"
          : status.role === st ? "own src"
          : own ? "forked" : ""
        const f = props.frames.get(st)
        const gen = props.pending.has(st)
        const empty = !f && !gen
        return (
          <box key={st} flexDirection="column" alignItems="center"
               onMouseDown={() => {
                 props.onPick(st)
                 if (empty) props.onEmpty?.(st)
               }}>
            <box border borderStyle="rounded"
                 borderColor={on && props.focused ? theme.primary : on ? theme.accent : theme.border}
                 width={18} height={10} overflow="hidden" alignItems="center" justifyContent="center">
              {gen ? <text fg={theme.accent}>{`${glyph} gen`}</text>
                : f ? f.map((ln, i) => <text key={i} fg={on ? theme.text : theme.textMuted}>{ln}</text>)
                : <text fg={theme.textMuted}>+</text>}
            </box>
            <box height={1}><text fg={on ? theme.accent : theme.textMuted}>{st}</text></box>
            <box height={1}><text fg={theme.textMuted}>{mark}</text></box>
          </box>
        )
      })}
    </box>
  )
}

// ── Main ─────────────────────────────────────────────────────────────

const BLANK: Frame = Array.from({ length: H }, () => " ".repeat(W))

// One-shot gen backend probe — calls the installed hermes-agent's
// check_*_requirements() directly so the source menu reflects actual
// provider availability (configured key/gateway), not just the
// toolset toggle. Cached at module scope; tests reset via setImpl.
let genCaps: Promise<{ image: boolean; video: boolean }> | null = null
const probeGen = () => {
  if (genCaps) return genCaps
  const p = gen.probeCached()
  p.catch(() => { genCaps = null })
  return (genCaps = p)
}
/** Test-only — wipe the gen-caps cache between mountNode calls. */
export const resetToolsetsCache = () => { genCaps = null }

export const EikonStudio = memo((props: {
  focused: boolean
  /** Name to open on mount / when Library hands over. Empty → fresh. */
  name?: string
}) => {
  const theme = useTheme().theme
  const keys = useKeys()
  const dialog = useDialog()
  const gw = useGateway()
  const toast = useToast()
  const dims = useTerminalDimensions()
  const wide = dims.width >= 120
  const ksb = useRef<ScrollBoxRenderable | null>(null)
  const outer = useRef<ScrollBoxRenderable | null>(null)

  useSyncExternalStore(eikon.onRegistry, () => eikon.rasterizers().length)

  const [s, setS] = useState<Session | null>(null)
  const [pane, setPane] = useState<Pane>("knobs")
  const [sel, setSel] = useState(0)
  const [spSel, setSpSel] = useState(0)
  // Rapid keypresses (held arrow) can fire before React commits the
  // new `sel`; read through a ref so adjust()/activate() see the
  // latest target row regardless of render timing.
  const selRef = useRef(0); selRef.current = sel
  const spRef = useRef(0); spRef.current = spSel
  const sRef = useRef<Session | null>(null); sRef.current = s
  const [frames, setFrames] = useState<Frame[]>([BLANK])
  const [play, setPlay] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [peek, setPeek] = useState<{ n: number; bytes: number } | undefined>(undefined)
  const [thumbs, setThumbs] = useState<Map<AvatarState, Frame | undefined>>(new Map())
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<ReadonlySet<AvatarState>>(new Set())
  const [genOk, setGenOk] = useState<{ image: boolean; video: boolean } | null>(null)
  const stampRef = useRef("")
  const rev = useSyncExternalStore(eikon.onRevision, eikon.revision)

  const r = useMemo(() => eikon.pick(s?.rasterizer ?? prefs.get("eikonRasterizer")), [s?.rasterizer])
  // Spatial is studio-owned now — every rasterizer gets it for free.
  // Only gate on ffmpeg (the shared decoder).
  const spatialOk = caps.ffmpeg

  // Open by name: read studio.json + probe + seed session.
  const open = useCallback((name: string) => {
    resetCache()
    stampRef.current = eikon.sourceStamp(name)
    const seed = eikon.readStudio(name)
    const ra = eikon.pick(seed?.rasterizer ?? prefs.get("eikonRasterizer"))
    const next = knobs.fresh(name, ra, seed)
    const src = eikon.findSource(name, "idle")
    next.dims = src ? (eikon.probe(src) ?? null) : null
    // Pre-warm every source's clip so the first spatial/knob change
    // is decode-free. Fire-and-forget; the preview effect awaits
    // the one it needs (shared Promise from the clip cache).
    for (const st of STATES) {
      const p = eikon.findSource(name, st)
      if (p) prewarm(p, next.fps)
    }
    setS(next)
    selRow.current = undefined
    setSel(0); setPane("knobs"); setErr(null); setFrames([BLANK])
  }, [])

  // Auto-open the active eikon (pref `eikon` by name) on first mount.
  const tried = useRef(false)
  useEffect(() => {
    if (tried.current) return
    tried.current = true
    if (props.name) return open(props.name || knobs.slug("new"))
    const n = prefs.get("eikon")
    if (n) open(n)
  }, [open, props.name])

  const dialogRef = useRef(dialog); dialogRef.current = dialog
  useEffect(() => {
    if (props.name === undefined) return
    const next = props.name || knobs.slug("new")
    const cur = sRef.current
    if (cur?.name === next) return
    if (!cur?.dirty) return open(next)
    let dead = false
    void openConfirm(dialogRef.current, {
      title: "Discard unsaved edits?", danger: true,
      body: `Switch to '${next}' and drop in-memory changes to '${cur.name}'.`,
    }).then(ok => { if (!dead && ok) open(next) })
    return () => { dead = true }
  }, [props.name, open])

  // Probe gen backends once per process so the source menu can hide
  // Generate rows when no image/video provider is configured. Cached
  // at module scope — repeated mounts share one subprocess.
  useEffect(() => {
    let dead = false
    void probeGen().then(c => { if (!dead) setGenOk(c) }).catch(() => {})
    return () => { dead = true }
  }, [])

  const stats = useMemo(() => {
    if (!s) return new Map<AvatarState, eikon.SourceStatus>()
    return new Map(STATES.map(st => [st, eikon.sourceStatus(s.name, st, { sources: s.sources })] as const))
  }, [s?.name, s?.sources, rev])
  const status = s ? stats.get(s.state) : undefined
  const src = status?.path
  const live = !!src
  // Sourceless → fall back to the packed .eikon's baked frames so the
  // preview is never blank. One readFileSync per open(); the whole
  // animation is string[] already, so tick stays 0.005ms.
  const baked = useMemo<ParsedEikon | undefined>(() => {
    if (live || !s) return undefined
    const p = eikon.baked(s.name)
    if (!p) return undefined
    try { return eikon.parseEikonFile(p) } catch { return undefined }
  }, [live, s?.name])
  const url = status?.sourceUrl
  useEffect(() => {
    setPeek(undefined)
    if (!url || !status?.downloadable) return
    let dead = false
    void eikon.peekSource(url).then(x => { if (!dead) setPeek(x) })
    return () => { dead = true }
  }, [url, status?.downloadable])

  useEffect(() => {
    if (!s) return
    const stamp = eikon.sourceStamp(s.name)
    if (!stampRef.current) { stampRef.current = stamp; return }
    if (stamp === stampRef.current) return
    stampRef.current = stamp
    if (s.dirty) {
      toast.show({ variant: "info", message: "Source changed on disk", duration: 3000 })
      return
    }
    open(s.name)
  }, [rev, s?.name, s?.dirty, open, toast])

  const rows = useMemo(() => (s && status ? buildRows(r, s, status) : []), [r, s, status])
  const navRows = useMemo(() => rows.map((x, i) => ({ ...x, i }))
    .filter(x => x.kind !== "divider" && x.kind !== "header"), [rows])
  // Keep selection anchored to its row identity when navRows mutates
  // (the `revert` row inserts into HEAD on first dirty, shifting
  // indices). Anchor on kind+id so a rasterizer knob that reuses a
  // HEAD id (e.g. a plugin declaring its own `contrast`) can't hijack
  // the resolved index.
  const selRow = useRef<string | undefined>(undefined)
  const rid = (x: Row) => `${x.kind}:${x.id}`
  const setSelBy = useCallback<typeof setSel>((arg) => {
    setSel(prev => {
      const next = typeof arg === "function" ? (arg as (p: number) => number)(prev) : arg
      const row = navRows[next]
      selRow.current = row ? rid(row) : undefined
      return next
    })
  }, [navRows])
  const prevRows = useRef(navRows)
  useEffect(() => {
    if (prevRows.current === navRows) return
    prevRows.current = navRows
    const id = selRow.current
    if (!id) return
    const ni = navRows.findIndex(x => rid(x) === id)
    if (ni >= 0 && ni !== selRef.current) setSel(ni)
  }, [navRows])
  // Knobs pane: ↑↓ keeps the selected row in view. Rows already carry
  // `id="knob-<row.id>"` (reconciler-id rule) — resolve via that.
  const kScroll = (ni: number) => {
    const row = navRows[ni]
    if (row) ksb.current?.scrollChildIntoView(`knob-${row.kind}-${row.id}`)
  }

  // Render the current state's full clip. Sourceless falls through
  // to the baked .eikon's frames for the current state — Studio's
  // own ticker still drives playback so the play/pause + title
  // counter keep working in baked mode.
  useEffect(() => {
    if (!s) return
    if (!src) {
      const clip = baked?.states.get(s.state)
      setFrames(clip?.frames.length ? clip.frames : [BLANK])
      setErr(null); setBusy(false)
      return
    }
    const ctrl = new AbortController()
    setBusy(true)
    void cached(r, src, s.spatial, s.tone, s.fps, knobs.eff(s, s.state), ctrl.signal).then(out => {
      if (ctrl.signal.aborted) return
      setBusy(false)
      if ("err" in out) { setErr(out.err); return }
      setErr(null); setFrames(out.frames)
    })
    return () => ctrl.abort()
  }, [s?.spatial, s?.tone, s?.base, s?.per, s?.state, s?.fps, s?.rasterizer, src, r, baked])


  // Thumbnails are second-class: frame-0 only, same spatial, long
  // debounce, stale during scrub, one setThumbs when the batch lands.
  // No abort plumbing — they fire after the preview has settled and
  // a new preview change just supersedes them at the setThumbs gate.
  useEffect(() => {
    if (!s) return
    let dead = false
    const t = setTimeout(() => {
      if (dead) return
      const jobs = STATES.map(st => {
        const sp = stats.get(st)?.path
        if (!sp) {
          const f = baked?.states.get(st)?.frames[0]
          return Promise.resolve([st, f ? thumb(f) : undefined] as const)
        }
        return cached(r, sp, s.spatial, s.tone, s.fps, knobs.eff(s, st))
          .then(res => [st, "err" in res ? undefined : thumb(res.frames[0]!)] as const)
      })
      void Promise.all(jobs).then(done => {
        if (dead) return
        setThumbs(new Map(done))
      })
    }, 400)
    return () => { dead = true; clearTimeout(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, s?.per, s?.sources, s?.name, s?.fps, r, baked, stats])

  const mutate = (fn: (prev: Session) => Session) => setS(p => (p ? fn(p) : p))

  const setSpatial = (sp: Partial<Spatial>) =>
    mutate(p => ({ ...p, spatial: { ...p.spatial, ...sp }, dirty: true }))

  const setBar = (k: SpKey, v: number) =>
    k === "fps"
      ? mutate(p => ({ ...p, fps: Math.round(v), dirty: true }))
      : setSpatial({ [k]: v })

  const stepBar = (k: SpKey, d: 1 | -1) => {
    const cur = sRef.current; if (!cur) return
    if (k === "fps") return setBar("fps", Math.max(4, Math.min(30, cur.fps + d * 2)))
    if (k === "zoom") return setSpatial({ zoom: Math.max(0.1, Math.min(1, +(cur.spatial.zoom + d * 0.03).toFixed(3))) })
    return setSpatial({ [k]: Math.max(0, Math.min(1, +(cur.spatial[k] + d * 0.03).toFixed(3))) })
  }

  // Knob-row actions.
  const doSave = useCallback(async (): Promise<boolean> => {
    if (!s) return false
    if (!s.dirty) {
      toast.show({ variant: "info", message: "Nothing to save" })
      return true
    }
    if (!live) {
      toast.show({ variant: "warning", message: "No source — download or attach before saving" })
      return false
    }
    setSaving(true)
    try {
      const f = await eikon.save({ ...s, dirty: false })
      mutate(p => ({ ...p, dirty: false }))
      toast.show({ variant: "success", message: `Saved → ${basename(f)}` })
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e : new Error(String(e)))
      return false
    } finally {
      setSaving(false)
    }
  }, [s, live, toast])

  const doSaveUse = useCallback(async () => {
    if (!s) return
    if (!await doSave()) return
    eikon.useInstalled(s.name)
    toast.show({ variant: "success", message: `Avatar → ${s.name}` })
  }, [doSave, s, toast])

  const doSelectRasterizer = () => {
    const opts = eikon.rasterizers().map(x => {
      const a = x.available()
      return { title: x.name, value: x.name, description: Object.keys(x.knobs).join(" · "),
               hint: a === true ? undefined : a }
    })
    dialog.replace(
      <DialogSelect title="Rasterizer" filterable={false} current={r.name} options={opts}
        onSelect={o => {
          dialog.clear()
          const next = eikon.rasterizer(o.value)
          if (!next) return
          const a = next.available()
          if (a !== true) return toast.show({ variant: "warning", message: `${o.value}: ${a}` })
          prefs.set("eikonRasterizer", o.value)
          mutate(p => knobs.swap(p, next))
        }} />,
      () => {},
    )
  }

  const runGenerate = async (st: AvatarState, kind: GenerateKind) => {
    if (!s) return
    const seed = stats.get("idle")?.path
    setPending(prev => { const n = new Set(prev); n.add(st); return n })
    const out = await openGenerate(dialog, gen.current(), {
      state: st, kind, seed, lastPrompt: s.prompts?.[st],
    })
    if (!out) {
      setPending(prev => { const n = new Set(prev); n.delete(st); return n })
      return
    }
    const role = st === "idle" && !s.sources.base ? "base" : st
    try {
      const f = eikon.adopt(s.name, out.path, role)
      mutate(p => ({
        ...p,
        sources: { ...p.sources, [role]: f },
        prompts: { ...p.prompts, [st]: out.prompt },
        dirty: true,
      }))
    } catch (e) {
      toast.error(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setPending(prev => { const n = new Set(prev); n.delete(st); return n })
    }
  }

  const download = async () => {
    if (!s || fetching) return
    setFetching(true)
    await eikon.downloadSource(s.name)
      .then(out => {
        toast.show({ variant: "success", message: `Downloaded ${out.n} file(s) · ${mb(out.bytes)}` })
        if (sRef.current?.dirty) mutate(prev => ({ ...prev, sources: { ...out.sources, ...prev.sources } }))
        else open(s.name)
      })
      .catch(e => toast.error(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setFetching(false))
  }

  const doSource = (forSt?: AvatarState) => {
    if (!s) return
    const st = forSt ?? s.state
    const info = stats.get(st) ?? eikon.sourceStatus(s.name, st, { sources: s.sources })
    const own = info.role === st || (st === "idle" && info.role === "base") || s.sources[st] !== undefined
    const loc = eikon.localSources(s.name)
    const opts: Array<{ title: string; value: string; hint?: string }> = [
      ...(info.downloadable ? [{ title: "Download source", value: "download" }] : []),
      ...loc.map(x => ({ title: x.file, value: `pick:${x.file}`, hint: x.role ?? "source" })),
      ...(genOk?.image ? [{ title: "Generate image…", value: "gen-image" }] : []),
      ...(genOk?.video ? [{ title: "Generate video…", value: "gen-video" }] : []),
      { title: "Local file…", value: "local" },
      ...(st !== "idle" && own ? [{ title: "Same as base", value: "same" }] : []),
      ...(own ? [{ title: "Remove", value: "remove" }] : []),
    ]
    dialog.replace(
      <DialogSelect title={`Source for '${st}'`} filterable={false} options={opts}
        onSelect={async o => {
          if (o.value === "download") {
            dialog.clear()
            await download()
            return
          }
          if (o.value.startsWith("pick:")) {
            dialog.clear()
            const file = o.value.slice("pick:".length)
            const role = st === "idle" && loc.find(x => x.file === file)?.role === "base" ? "base" : st
            mutate(prev => ({ ...prev, sources: { ...prev.sources, [role]: file }, dirty: true }))
            return
          }
          if (o.value === "local") {
            const p = await openPathPrompt(dialog, gw, {
              title: `Source for '${st}'`,
              label: "png/jpg/webp/gif/mp4/webm/mov  ·  Tab completes",
              filter: /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i,
            })
            if (!p) return
            const role = st === "idle" && !s.sources.base ? "base" : st
            try { const f = eikon.adopt(s.name, p, role); mutate(prev => ({ ...prev, sources: { ...prev.sources, [role]: f }, dirty: true })) }
            catch (e) { toast.error(e instanceof Error ? e : new Error(String(e))) }
            return
          }
          if (o.value === "gen-image") return void runGenerate(st, "image")
          if (o.value === "gen-video") return void runGenerate(st, "video")
          dialog.clear()
          mutate(prev => ({
            ...prev,
            sources: { ...prev.sources, [st === "idle" ? "base" : st]: null },
            dirty: true,
          }))
        }} />,
      () => {},
    )
  }

  const doPrompt = async (id: string) => {
    if (!s) return
    if (id === "source") return doSource()
  }

  // Prompts before discarding when the current draft is dirty.
  const switchTo = useCallback(async (name: string) => {
    const cur = sRef.current
    if (cur?.name === name) return
    if (cur?.dirty) {
      const ok = await openConfirm(dialog, {
        title: "Discard unsaved edits?", danger: true,
        body: `Open '${name}' and drop in-memory changes to '${cur.name}'.`,
      })
      if (!ok) return
    }
    open(name)
  }, [dialog, open])

  const apply = useCallback(async (res: Awaited<ReturnType<typeof openNewEikon>>) => {
    if (!res) return
    if (res.from === "blank") {
      eikon.ensure(res.name)
      return switchTo(res.name)
    }
    if (res.from === "file") {
      eikon.ensure(res.name)
      try { eikon.adopt(res.name, res.file, "base") }
      catch (e) { return toast.error(e instanceof Error ? e : new Error(String(e))) }
      return switchTo(res.name)
    }
    toast.show({ variant: "info", message: `Installing '${res.name}' from ${res.src}…` })
    await eikon.installPackage(res.src, { name: res.name })
      .then(out => {
        toast.show({ variant: "success", message: `Installed '${out.name}' (${out.n} files)` })
        void switchTo(out.name)
      })
      .catch(e => toast.error(e instanceof Error ? e : new Error(String(e))))
  }, [switchTo, toast])

  const doNew = useCallback(async () => {
    const res = await openNewEikon(dialog, {})
    await apply(res)
  }, [dialog, apply])

  // Installed-folder eikons take precedence over bundled flat-file
  // duplicates by slug; trailers are appended in doOpen.
  const eikonOptions = useCallback(() => {
    const installed = eikon.list().map(e => ({
      title: e.name, value: e.name, category: "installed",
      hint: e.hasSource ? "● source" : e.sourceUrl ? "○ source available" : "—",
    }))
    const seen = new Set(installed.map(o => o.value))
    const bundled = listEikons([BUNDLED_EIKON_DIR, hermesPath("eikons")])
      .filter(e => e.path.startsWith(BUNDLED_EIKON_DIR))
      .map(e => {
        const slug = e.meta.name.toLowerCase()
        return { title: e.meta.name, value: slug, category: "bundled",
                 hint: `${e.meta.width}×${e.meta.height}` }
      })
      .filter(o => !seen.has(o.value))
    // Folders with no .eikon yet (fresh `ensure()`d) — list() skips them.
    const raw = eikon.raw().filter(n => !seen.has(n)).map(n =>
      ({ title: n, value: n, category: "installed", hint: "(unsaved)" }))
    return [...installed, ...raw, ...bundled]
  }, [])

  const doInstall = useCallback(async () => {
    const src = await openTextPrompt(dialog, {
      title: "Inspect eikon source",
      label: "catalog name · github.com/u/r/eikon-name · git URL · http://…/ · local dir",
    })
    if (!src) return
    let info: eikon.InspectInfo
    try { info = await eikon.inspectSource(src) }
    catch (e) { return toast.error(e instanceof Error ? e : new Error(String(e))) }
    const ok = await openConfirm(dialog, {
      title: `Install '${info.title ?? info.name}'?`,
      body: [
        `Name: ${info.name}`,
        `Author: ${info.author ?? "unknown"}`,
        `Version: ${info.version ?? "unknown"}`,
        `Source: ${info.sourceLabel}`,
        `Trust: ${info.trust}${info.reason ? ` (${info.reason})` : ""}`,
        `Preview: ${info.previewAvailable ? "available" : "none"}; poster: ${info.posterAvailable ? "available" : "none"}`,
        "Install does not activate; use Ctrl+U or Library after install to select it.",
      ].join("\n"),
      yes: "install", no: "cancel",
    })
    if (!ok) return
    toast.show({ variant: "info", message: `Installing from ${src}…` })
    await eikon.installPackage(src)
      .then(out => {
        toast.show({ variant: "success", message: `Installed '${out.name}' (${out.n} files)` })
        void switchTo(out.name)
      })
      .catch(e => toast.error(e instanceof Error ? e : new Error(String(e))))
  }, [dialog, switchTo, toast])

  const doOpen = useCallback(() => {
    const cur = sRef.current
    const opts = [
      ...eikonOptions(),
      { title: "+ New…",      value: "__new",     category: "" },
      { title: "+ Install…",  value: "__install", category: "" },
    ]
    dialog.replace(
      <DialogSelect title="Open eikon" current={cur?.name} options={opts}
        onSelect={o => {
          dialog.clear()
          if (o.value === "__new") return void doNew()
          if (o.value === "__install") return void doInstall()
          void switchTo(o.value)
        }} />,
      () => {},
    )
  }, [dialog, eikonOptions, switchTo, doNew, doInstall])

  const doSubmit = useCallback(async () => {
    const cur = sRef.current
    if (!cur) return
    const path = submitSvc.submitPath(cur.name)
    const pub = submitSvc.publishedInfo(path)
    if (pub) {
      toast.show({ variant: "warning", title: "Published eikon", message: "Create a local draft before submitting", duration: 6000 })
      return
    }
    if (cur.dirty || !existsSync(path)) {
      const pick = await openSaveDiscard(dialog, {
        title: "Save before submit?",
        body: `'${cur.name}' has unsaved changes. Save to submit the current preview, discard to submit the last saved artifact, or keep editing.`,
      })
      if (pick === "save") {
        if (prefs.get("eikon") === cur.name) {
          const ok = await openConfirm(dialog, {
            title: `Save active '${cur.name}' before submit?`, danger: true,
            body: "Saving changes the active avatar's backing artifact. Submit itself will not change active selection.",
            yes: "save", no: "cancel",
          })
          if (!ok) return
        }
        if (!await doSave()) return
      } else if (pick === "discard") open(cur.name)
      else return
    }
    if (!existsSync(path)) {
      toast.show({ variant: "warning", message: "Save this eikon before submitting" })
      return
    }
    await openEikonSubmit(dialog, {
      name: cur.name,
      path,
      submit: submitSvc.submit,
    })
  }, [dialog, doSave, open, toast])

  const doAction = async (id: string) => {
    if (!s) return
    if (id === "knobsfor") return mutate(p => p.per[p.state] ? knobs.unfork(p) : knobs.fork(p))
    if (id === "submit") { void doSubmit(); return }
    if (id === "revert") { void discard(); return }
    if (id === "reset") {
      const ok = await openConfirm(dialog, { title: "Reset settings?", body: "Restore rasterizer defaults and drop all per-state overrides.", danger: true })
      if (ok) mutate(p => knobs.reset(p, r))
      return
    }
    if (id === "fetch") {
      if (!status?.downloadable || fetching) return
      await download()
    }
  }

  const doStripMenu = () => {
    if (!s) return
    dialog.replace(
      <DialogSelect title={`State: ${s.state}`} filterable={false}
        options={[
          { title: "Source…", value: "source" },
          { title: s.per[s.state] ? "Clear override (back to base)" : "Tune this state only", value: "fork" },
        ]}
        onSelect={o => {
          if (o.value === "source") { doSource(); return }
          dialog.clear()
          mutate(s.per[s.state] ? knobs.unfork : knobs.fork)
        }} />,
      () => {},
    )
  }

  const setTone = (t: Partial<Tone>) =>
    mutate(p => ({ ...p, tone: { ...p.tone, ...t }, dirty: true }))

  /** Step a knob row (cycle/toggle forward, slider ±). Tone rows
   *  (contrast/flip) write to `s.tone`; rasterizer knobs to `s.base`
   *  or `s.per[state]` via `knobs.edit`. */
  const stepRow = (row: Row, d: 1 | -1) => {
    if (row.kind === "tone") {
      if (row.id === "contrast") {
        const def = row.knob as Extract<KnobDef, { kind: "slider" }>
        const cur = sRef.current?.tone.contrast ?? 1
        return setTone({ contrast: +Math.max(def.min, Math.min(def.max, cur + d * def.step)).toFixed(2) })
      }
      if (row.id === "invert") return setTone({ invert: !sRef.current?.tone.invert })
      if (row.id === "flip") {
        const cur = sRef.current?.tone.flip ?? "none"
        const i = FLIPS.indexOf(cur)
        return setTone({ flip: FLIPS[(i + d + FLIPS.length) % FLIPS.length]! })
      }
      return
    }
    if (row.kind !== "knob" || !row.knob) return
    mutate(p => knobs.edit(p, k => knobs.step(k, row.id, row.knob!, d)))
  }

  /** nav.md: Enter activates; Space toggles/cycles; when a row has
   *  only one semantic, both keys and click do that. High-commitment
   *  actions (reset → confirm dialog) are Enter/click only. */
  const act = (row: Row | undefined, via: "enter" | "space" | "click") => {
    if (!row || !sRef.current) return
    if (row.kind === "select") {
      if (row.id === "open") return doOpen()
      return doSelectRasterizer()
    }
    if (row.kind === "prompt") return void doPrompt(row.id)
    if (row.kind === "action") {
      if (via === "space" && row.id === "reset") return
      return void doAction(row.id)
    }
    if (row.kind === "tone" || row.kind === "knob") {
      // slider has neither toggle nor activate semantics → Enter/Space
      // are inert (←→ and drag are the inputs).
      if (row.knob!.kind === "slider") return
      return stepRow(row, 1)
    }
  }

  const activate = () => act(navRows[selRef.current], "enter")
  const toggle   = () => act(navRows[selRef.current], "space")
  const adjust = (d: 1 | -1) => {
    const row = navRows[selRef.current]
    if (!row) return
    if (row.id === "knobsfor") return void doAction("knobsfor")
    stepRow(row, d)
  }

  const discard = async () => {
    const cur = sRef.current
    if (!cur?.dirty) return false
    const pick = await openSaveDiscard(dialog, {
      title: "Unsaved edits",
      body: `'${cur.name}' has unsaved changes. Save them, discard them, or keep editing?`,
    })
    if (pick === "save") {
      if (await doSave()) open(cur.name)
      return true
    }
    if (pick === "discard") open(cur.name)
    return true
  }

  const refresh = useCallback(() => {
    const cur = sRef.current
    if (!cur) return
    stampRef.current = eikon.sourceStamp(cur.name)
    if (cur.dirty) {
      toast.show({ variant: "info", message: "Reload skipped: unsaved edits", duration: 3000 })
      return
    }
    open(cur.name)
    toast.show({ variant: "info", message: "Reloaded", duration: 1000 })
  }, [open, toast])

  useKeyboard((key: ParsedKey) => {
    if (!props.focused || dialog.open()) return
    if (key.eventType === "release") return
    if (key.name === "u" && key.ctrl && sRef.current) return void doSaveUse()
    if (key.name === "u" && sRef.current) return void doSubmit()
    if (keys.match("eikon.save", key)) { if (!saving) void doSave(); return }
    if (key.name === "escape") return void discard()
    if (key.name === "tab") {
      const i = PANES.indexOf(pane)
      const next = PANES[(i + (key.shift ? PANES.length - 1 : 1)) % PANES.length]!
      setPane(next)
      outer.current?.scrollChildIntoView(`studio-${next}`)
      return
    }
    if (!s) {
      if (key.name === "return") return void doNew()
      return
    }
    if (pane === "knobs") {
      if (handleListKey(keys, key, {
        count: navRows.length, setSel: setSelBy, scrollTo: kScroll,
        page: Math.max(1, (ksb.current?.viewport.height ?? 10) - 1),
        onActivate: activate,
        onToggle: toggle,
        onNew: () => void doNew(),
        onRefresh: refresh,
      })) return
      if (key.name === "left") return adjust(-1)
      if (key.name === "right") return adjust(1)
      return
    }
    if (pane === "preview") {
      // Space toggles play/pause (nav.md: Space = toggle).
      if (keys.match("list.toggle", key)) return setPlay(p => !p)
      if (!spatialOk || !live) return
      // ↑↓ moves spatial-row selection; ←→ steps the selected knob.
      if (handleListKey(keys, key, { count: SP_ROWS.length, setSel: setSpSel })) return
      const spec: readonly SpKey[] = ["ox", "oy", "zoom", "fps"]
      const k = spec[spRef.current]!
      const fine = key.shift && k !== "fps"
      const d = (name: string) => name === "left" ? -1 : 1
      if (key.name === "left" || key.name === "right") {
        if (fine && (k === "ox" || k === "oy" || k === "zoom")) {
          const cur = sRef.current!.spatial[k]
          return setSpatial({ [k]: Math.max(k === "zoom" ? 0.1 : 0, Math.min(1, +(cur + d(key.name) * 0.01).toFixed(3))) })
        }
        return stepBar(k, d(key.name))
      }
      return
    }
    // strip
    if (key.name === "left")  return mutate(p => knobs.cycle(p, -1))
    if (key.name === "right") return mutate(p => knobs.cycle(p,  1))
    if (key.name === "return") return doStripMenu()
  })

  // Preview wheel: pan-y by default; +Shift → pan-x; +Ctrl → zoom.
  // Always swallowed so the outer scrollbox never moves while the
  // pointer is over the frame.
  const onScroll = (e: MouseEvent) => {
    e.stopPropagation()
    if (!spatialOk || !live || !e.scroll) return
    const d = e.scroll.direction
    if (d !== "up" && d !== "down") return
    const sign = d === "up" ? -1 : 1
    if (e.modifiers.ctrl)
      return mutate(p => ({ ...p, spatial: knobs.zoom(p.spatial, sign), dirty: true }))
    if (e.modifiers.shift)
      return mutate(p => ({ ...p, spatial: knobs.pan(p.spatial, sign, 0), dirty: true }))
    mutate(p => ({ ...p, spatial: knobs.pan(p.spatial, 0, sign), dirty: true }))
  }

  const previewErr = err ?? (!s || src || baked ? null
    : url ? "no source — Enter on 'download source'"
    :       "no source — Enter on 'source'")

  const hint: Array<readonly [string, string]> =
    !s                   ? [["Enter", "new eikon"], ["Shift+→", "library"]]
  : pane === "knobs"   ? [["↑↓", "row"], ["←→", "adjust"], [keys.print("list.activate"), "edit"], [keys.print("list.refresh"), "reload"], [keys.print("list.new"), "new"], ["u", "submit"], [keys.print("eikon.save"), "save"], ["Ctrl+U", "save & use"], ["Tab", "pane"]]
  : pane === "preview" ? [["↑↓", "row"], ["←→", "adjust"], [keys.print("list.toggle"), "play/pause"], ["wheel", "pan"], ["Ctrl+wheel", "zoom"], [keys.print("eikon.save"), "save"], ["Ctrl+U", "save & use"], ["Tab", "pane"]]
  :                      [["←→", "state"], [keys.print("list.activate"), "actions"], [keys.print("eikon.save"), "save"], ["Ctrl+U", "save & use"], ["Tab", "pane"]]

  // TabShell chrome = border(2) + padding(2) + title(1) + gap(1).
  // PanBars adds +1 row (pan-x) and +2 col (pan-y) around the frame.
  // SpatialBar = max(minimap height, 2 rows + 1 gap) + 1 margin.
  // Baked mode drops both — body sits alone at W×H.
  const BAR_H = spatialOk && live ? Math.max(Math.ceil(MINI_W / 2), 3) + 1 : 0
  const PREVIEW_W = Math.max(W + 2, 36 + 2 + MINI_W) + 6
  const PREVIEW_H = H + (spatialOk && live ? 1 : 0) + BAR_H + 6 + (previewErr ? 1 : 0)
  const preview = (
    <PreviewPane s={s} frames={frames} play={play} setPlay={setPlay}
      focused={Boolean(props.focused)} busy={busy} live={live} baked={baked}
      spatialOk={spatialOk} error={previewErr} pane={pane} sel={spSel}
      onPane={setPane} onSel={setSpSel} onSet={setBar} onWheel={stepBar}
      onScroll={onScroll} />
  )

  const help = helpOf(navRows[sel])
  const panel = (
    <TabShell title={s ? `Settings — ${s.name}` : "Settings"} focus={pane === "knobs"} grow={1}>
      {!s
        ? <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={theme.textMuted}>No eikon open. Enter to create or pick one.</text>
          </box>
        : <>
            <scrollbox id="studio-knob-scroll" ref={ksb} scrollY flexGrow={1} contentOptions={COL}
                       onMouseScroll={(e: MouseEvent) => e.stopPropagation()}>
              {rows.map((row, i) => {
                const ni = navRows.findIndex(x => x.i === i)
                const on = pane === "knobs" && ni === sel
                const dim = row.kind === "knob" && !src
                return (
                  <KnobRow key={`${row.kind}:${r.name}:${row.id}`} id={`knob-${row.kind}-${row.id}`} row={row} s={s} r={r} status={status!}
                           on={on} dim={dim} peek={peek} busy={row.id === "fetch" && fetching}
                           onHover={() => { if (ni >= 0) { setPane("knobs"); setSelBy(ni) } }}
                           onClick={() => { if (ni >= 0) { setSelBy(ni); setPane("knobs"); act(row, "click") } }}
                           onWheel={d => stepRow(row, d)}
                           onSlide={row.knob?.kind !== "slider" ? undefined
                             : row.kind === "tone"
                               ? v => setTone({ contrast: +v.toFixed(2) })
                               : v => mutate(p => knobs.edit(p, k => knobs.setSlider(k, row.id, row.knob!, v)))} />
                )
              })}
            </scrollbox>
            <box flexShrink={0} height={HELP_H} marginTop={1} overflow="hidden">
              <text fg={theme.textMuted} wrapMode="word">{help}</text>
            </box>
          </>}
    </TabShell>
  )

  // Strip cell = 10 (bordered thumb) + 2 (label lines). TabShell chrome =
  // border(2) + padding(2) + title(1) + gap(1). flexBasis=0 on TabShell
  // would collapse it in a column, so pin the wrapper height.
  const STRIP_H = 18
  const strip = s ? (
    <box id="studio-strip" flexShrink={0} height={STRIP_H}>
      <TabShell title="States" focus={pane === "strip"}>
        <Strip s={s} frames={thumbs} stats={stats} pending={pending} focused={pane === "strip"}
               onPick={st => { setPane("strip"); mutate(p => knobs.setState(p, st)) }}
               onEmpty={st => doSource(st)} />
      </TabShell>
    </box>
  ) : null

  // Full stack is ~PREVIEW_H + STRIP_H rows — taller than most
  // terminals — so it always sits inside a scrollbox. `wide` only
  // decides whether preview+knobs are row-adjacent or stacked. Tab
  // scrolls the focused pane into view; knobs has its own inner
  // scrollbox so ↑↓ follows without moving the outer viewport.
  const top = wide ? (
    <box flexDirection="row" flexShrink={0} height={PREVIEW_H}>
      <box id="studio-preview" flexShrink={0} width={PREVIEW_W}>{preview}</box>
      <box id="studio-knobs" flexGrow={1} flexBasis={0} minWidth={0}>{panel}</box>
    </box>
  ) : (
    <>
      <box id="studio-preview" flexShrink={0} height={PREVIEW_H}>{preview}</box>
      <box id="studio-knobs" flexShrink={0}
           height={Math.max(rows.length, 1) + HELP_H + 1 + 6}>{panel}</box>
    </>
  )
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <scrollbox ref={outer} scrollY flexGrow={1} contentOptions={COL}>
        {top}
        {strip}
      </scrollbox>
      <HintBar pairs={hint} suffix={saving ? "● saving…" : s?.dirty ? "● unsaved" : undefined} />
    </box>
  )
})
