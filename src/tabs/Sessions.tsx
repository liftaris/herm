import { useState, useEffect, useCallback, useMemo, useRef, memo, Fragment } from "react"
import { SIDE_PIPE } from "../ui/borders"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeys, handleListKey } from "../keys"
import { sdb } from "../service/sessions-db"
import type { SessionRow, SessionHit, LineageInfo, PeekMsg } from "../service/sessions-db"
import { io as dbio } from "../io"
import type {
  SessionListItem, SessionListResponse, SessionActiveItem, SessionActiveListResponse,
} from "../context/wire"
import { useGateway, useGatewayEvent } from "../context/gateway"
import { useTheme } from "../theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { KVBlock } from "../ui/kv"
import { Col, Hdr, Marquee, VBAR } from "../ui/table"
import { Spinner } from "../ui/spinner"
import { Ticker, inline } from "../ui/ticker"
import { FilterChip } from "../ui/filter-chip"
import { openConfirm } from "../dialogs/confirm"
import { openTextPrompt } from "../dialogs/text-prompt"
import { fmt, cost, trunc, ago, when, span, stamp } from "../ui/fmt"
import { home } from "../home"
import { prefs } from "../context/preferences"
import type { SessionsPrefs } from "../context/preferences"

// Architecture: herm's Sessions tab is a **local state.db reader**.
// Stock tui_gateway exposes only ~30% of what the tab needs via RPC
// (see sessions-db.ts header). The gateway is authoritative for
// exactly one thing — *which session ids it can resume* — so we join
// session.list against the local roots() by id. Enrichment (tokens,
// cost, model, lineage, subagents, last_active) all comes from
// state.db. When state.db isn't the gateway's state.db (remote
// gateway, separate profile), enrichment is absent and rows render
// un-enriched; the tab keeps working at session.list fidelity.

type Row = SessionListItem & { detail?: SessionRow; live?: SessionActiveItem }

type Sort = NonNullable<SessionsPrefs["sort"]>

/** Row comparator for the chosen sort. "active" keys on the tip's
 *  last_active (state.db enrichment); gateway-only rows fall back to
 *  started_at so remote-only entries still interleave sensibly. */
const cmp = (s: Sort) => {
  const k = (r: Row) => s === "started"
    ? r.started_at
    : (r.detail?.last_active ?? r.started_at)
  return (a: Row, b: Row) => k(b) - k(a)
}

const WORD = { api: "API", cli: "CLI", tui: "TUI", whatsapp: "WhatsApp" } as Record<string, string>
const badge = (s: string): string => s
  .split(/[_-]+/).filter(Boolean)
  .map(w => WORD[w.toLowerCase()] ?? (w[0]?.toUpperCase() ?? "") + w.slice(1))
  .join(" ") || "—"

const label = (r: Row) => r.title.trim() || (r.live ? "-" : "Untitled")
const src = (r: Row): string => r.detail?.sessionSource || r.source || ""
const fallback = (msg: string): boolean => {
  const s = msg.trim()
  if (/\b(?:timeout|timed out)\b/i.test(s)) return false
  return /^(method not found|unknown method(?::|\b)|gateway not running\b|gateway exited(?:\s*\(|$))/i.test(s)
}

type View = {
  id: string
  label: string
  count: number
  source?: string
  aggregate?: "conversations"
}

const HOME = "conversations"
const HBAR = { visible: false } as const
const ROW = { flexDirection: "row" } as const
const sid = (s: string): string => `source:${s}`
const chip = (id: string): string => `sessions-source-${id.replace(/[^a-z0-9_-]/gi, "_")}`
const tick = (r: Row): number => r.detail?.last_active ?? r.started_at

const FilterRow = memo((p: {
  views: View[]
  view: string
  setView: (v: string) => void
}) => {
  const theme = useTheme().theme
  const ref = useRef<ScrollBoxRenderable | null>(null)
  const renderer = useRenderer()
  useEffect(() => {
    const move = () => {
      const node = ref.current
      const idx = p.views.findIndex(v => v.id === p.view)
      if (!node || idx < 0) return
      const left = p.views.slice(0, idx).reduce((n, v, i) =>
        n + (i === 0 ? 0 : 1) + `${v.label} ${v.count}`.length + 2, 0)
      const w = `${p.views[idx].label} ${p.views[idx].count}`.length + 2
      const port = Math.max(1, node.viewport.width - 4)
      const pos = node.scrollLeft
      node.scrollLeft = Math.max(0, left < pos ? left : left + w > pos + port ? left + w - port : pos)
    }
    move()
    let frames = 0
    const frame = async () => {
      move()
      if (++frames >= 2) renderer.removeFrameCallback(frame)
    }
    renderer.setFrameCallback(frame)
    return () => renderer.removeFrameCallback(frame)
  }, [p.view, p.views, renderer])
  return (
    <scrollbox ref={ref} scrollX height={1} paddingLeft={2}
               horizontalScrollbarOptions={HBAR} contentOptions={ROW}>
      {p.views.map((v, i) => (
        <FilterChip key={v.id} id={chip(v.id)} label={`${v.label} ${v.count}`}
          state={p.view === v.id ? "in" : "off"} gap={i === 0 ? 0 : 1}
          color={theme.primary} textColor={theme.primary}
          onMouseDown={() => p.setView(v.id)} />
      ))}
    </scrollbox>
  )
})
//
// Purpose: decide whether to load a session without replacing the
// current chat. So: conversation only. Tool chatter is collapsed to
// a single count in the footer — scanning "what was said" matters;
// which tools ran doesn't, at peek granularity.
//
// Row style mirrors the chat transcript (MessageItem's Gutter): user
// = left bar in theme.primary, assistant = right bar in theme.accent.
// One line each; hover a row to fast-marquee the clipped text.

type Folded = { role: "user" | "assistant"; text: string }

const line = (s: string | null) =>
  (s ?? "").replace(/\s+/g, " ").trim()

/** Reduce raw PeekMsg[] to { turns, tools }. Exported for tests. */
export const fold = (msgs: PeekMsg[]): { turns: Folded[]; tools: number } => {
  const turns: Folded[] = []
  let tools = 0
  for (const m of msgs) {
    if (m.role === "tool") { tools++; continue }
    if (m.role !== "user" && m.role !== "assistant") continue
    const text = line(m.content)
    // Assistant rows with tool_calls but no content are pure tool-
    // invocation turns — nothing to read, counted in `tools` via
    // their result rows.
    if (!text) continue
    turns.push({ role: m.role, text })
  }
  return { turns, tools }
}

const PeekRow = memo((props: { row: Folded }) => {
  const theme = useTheme().theme
  const [hot, setHot] = useState(false)
  const left = props.row.role === "user"
  const color = left ? theme.primary : theme.accent
  const fg = left ? theme.text : theme.markdownText
  // Width-2 box with a single-side border draws exactly "│ " / " │",
  // matching components/chat/MessageItem Gutter at height=1.
  const bar = (side: "left" | "right") => (
    <box width={2} flexShrink={0} height={1}
         border={[side]} borderColor={color}
         customBorderChars={SIDE_PIPE} />
  )
  return (
    <box height={1} flexDirection="row"
         backgroundColor={hot ? theme.backgroundElement : undefined}
         onMouseOver={() => setHot(true)}
         onMouseOut={() => setHot(false)}>
      {left ? bar("left") : null}
      <Ticker active={hot} speed={35} hold={150} fg={fg}>
        {inline(props.row.text).map((s, i) =>
          s.c ? <span key={i} fg={theme.warning}>{s.t}</span>
          : s.b ? <span key={i} fg={fg}><strong>{s.t}</strong></span>
          : s.i ? <span key={i} fg={fg}><u>{s.t}</u></span>
          : <span key={i} fg={fg}>{s.t}</span>)}
      </Ticker>
      {left ? null : bar("right")}
    </box>
  )
})

type Peeker = (sid: string) => PeekMsg[] | Promise<PeekMsg[]>

const Peek = memo((props: { sid: string; total: number; peek: Peeker }) => {
  const theme = useTheme().theme
  const [data, setData] = useState<{ turns: Folded[]; tools: number } | null>(null)
  const [err, setErr] = useState("")
  const sb = useRef<ScrollBoxRenderable | null>(null)
  const gen = useRef(0)

  useEffect(() => {
    const current = ++gen.current
    setData(null)
    setErr("")
    void Promise.resolve(props.peek(props.sid))
      .then(m => { if (gen.current === current) setData(fold(m)) })
      .catch(e => {
        if (gen.current === current) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => { gen.current++ }
  }, [props.sid, props.peek])
  // Pin to bottom on load — "where did this end up", not "how did
  // it start".
  useEffect(() => {
    if (data && sb.current) sb.current.scrollTop = sb.current.scrollHeight
  }, [data])

  if (err) return <box height={1}><text fg={theme.error}>{err}</text></box>
  if (data === null) return null
  if (data.turns.length === 0 && data.tools === 0) return (
    <box height={1}><text fg={theme.textMuted}>(no local transcript)</text></box>
  )
  const gap = props.total > 4

  return (
    <box flexDirection="column" flexGrow={1} minHeight={5}
         border borderStyle="single" borderColor={theme.border}
         title={` Transcript${gap ? "  ·  first 2 / last 2" : ""} `}
         titleAlignment="left">
      <scrollbox ref={sb} scrollY flexGrow={1} minHeight={3}>
        <box flexDirection="column" width="100%">
          {data.turns.map((r, i) => <Fragment key={i}>
            <PeekRow row={r} />
            {gap && i === 1 ? (
              <box height={1}><text fg={theme.textMuted}>  …</text></box>
            ) : null}
          </Fragment>)}
        </box>
      </scrollbox>
      <box height={1}>
        <text fg={theme.textMuted}>
          {`${data.turns.length} turn${data.turns.length === 1 ? "" : "s"}  ·  ${data.tools} tool call${data.tools === 1 ? "" : "s"}`}
        </text>
      </box>
    </box>
  )
})
//
// Data provenance:
//   RPC (session.list): id, title, preview (first user msg), source,
//                       started_at, message_count
//   state.db enrich:    model, last_active, ended_at, end_reason,
//                       tokens, cost, tool_call_count, lastMessage
//
// `ended_at` is NULL for ~80% of rows — hermes-agent only sets it on
// clean CLI exit / compression / explicit reset, never on process
// kill or abandoned TUI connects. So we derive Duration and "Last
// active" from MAX(messages.timestamp) instead, which is always
// accurate, and only show the ended_at/end_reason pair when it's
// actually populated.

const Detail = memo((props: {
  row: Row
  onSwitch?: (sid: string) => void
  lineage: (sid: string) => LineageInfo | Promise<LineageInfo>
  peek: Peeker
}) => {
  const theme = useTheme().theme
  const r = props.row
  const d = r.detail
  const lastActive = d?.last_active ?? d?.ended_at ?? null
  const subs = d?.subagent_count ?? 0
  // Lineage is an off-thread worker round-trip (sub-ms query, ~1 ms
  // total). Loaded on row change, not every render.
  const [info, setInfo] = useState<LineageInfo>({})
  const [lineageErr, setLineageErr] = useState("")
  const lineageGen = useRef(0)
  useEffect(() => {
    const current = ++lineageGen.current
    setInfo({})
    setLineageErr("")
    void Promise.resolve(props.lineage(r.id))
      .then(next => { if (lineageGen.current === current) setInfo(next) })
      .catch(e => {
        if (lineageGen.current === current)
          setLineageErr(e instanceof Error ? e.message : String(e))
      })
    return () => { lineageGen.current++ }
  }, [r.id, props.lineage])
  const hasLineage = info.continuesFrom || info.compressedTo || subs > 0
  const go = (sid: string) => () => props.onSwitch?.(sid)

  return (
    <TabShell title="Session Detail" grow={2}>
      <box flexDirection="column" width="100%" flexGrow={1} overflow="hidden">
        <box flexDirection="column" flexShrink={0}>
          <box minHeight={1}>
            <text wrapMode="word"><span fg={theme.accent}><strong>{label(r)}</strong></span></text>
          </box>
          <box height={1} />
          <KVBlock rows={[
            ["ID", r.id],
            ["Source", badge(src(r))],
            ["Model", d?.model ?? "—"],
            ["Started", when(r.started_at)],
            ["Last active", lastActive ? `${when(lastActive)}  (${ago(lastActive)})` : "—"],
            ["Duration", lastActive ? span(r.started_at, lastActive) : "—"],
            ["Ended", d?.ended_at ? `${when(d.ended_at)}  ·  ${d.end_reason ?? "—"}` : undefined],
          ]} />
          <box height={1} />
          <KVBlock rows={[
            ["Messages", String(r.message_count)],
            ["Tool calls", d ? String(d.tool_call_count) : undefined],
            ["Input", d ? `${fmt(d.input_tokens)} tok` : undefined],
            ["Output", d ? `${fmt(d.output_tokens)} tok` : undefined],
            ["Cache", d ? `${fmt(d.cache_read_tokens)} r / ${fmt(d.cache_write_tokens)} w` : undefined],
            ["Reasoning", d ? `${fmt(d.reasoning_tokens)} tok` : undefined],
            ["Cost", d ? cost(d.estimated_cost_usd) : undefined, theme.success],
          ]} />
          {hasLineage ? <>
            <box height={1} />
            <box minHeight={1}><text fg={theme.textMuted}>Lineage</text></box>
            {info.continuesFrom ? (
              <box height={1} onMouseDown={go(info.continuesFrom.id)}>
                <text>
                  <span fg={theme.textMuted}>{"  ← continues from  "}</span>
                  <span fg={theme.accent}>{info.continuesFrom.title || info.continuesFrom.id}</span>
                </text>
              </box>
            ) : null}
            {info.compressedTo ? (
              <box height={1} onMouseDown={go(info.compressedTo.id)}>
                <text>
                  <span fg={theme.textMuted}>{"  → compressed to  "}</span>
                  <span fg={theme.accent}>{info.compressedTo.title || info.compressedTo.id}</span>
                </text>
              </box>
            ) : null}
            {subs > 0 ? (
              <box height={1}>
                <text>
                  <span fg={theme.textMuted}>{"  ⎇ spawned "}</span>
                  <span fg={theme.text}>{String(subs)}</span>
                  <span fg={theme.textMuted}>{` subagent${subs === 1 ? "" : "s"}`}</span>
                </text>
              </box>
            ) : null}
          </> : null}
          {lineageErr ? <box height={1}><text fg={theme.error}>{lineageErr}</text></box> : null}
          {!d ? <>
            <box height={1} />
            <box height={1}><text fg={theme.textMuted}>(no local detail — state.db mismatch)</text></box>
          </> : null}
          <box height={1} />
        </box>
        <Peek sid={r.id} total={r.message_count} peek={props.peek} />
      </box>
    </TabShell>
  )
})

const SearchDetail = memo((props: { result: SessionHit }) => {
  const theme = useTheme().theme
  const r = props.result

  // Render snippet with >>> <<< markers as highlights.
  const parts: Array<{ text: string; hi: boolean }> = []
  let rest = r.snippet
  while (rest.length) {
    const start = rest.indexOf(">>>")
    if (start < 0) { parts.push({ text: rest, hi: false }); break }
    if (start > 0) parts.push({ text: rest.slice(0, start), hi: false })
    const end = rest.indexOf("<<<", start + 3)
    if (end < 0) { parts.push({ text: rest.slice(start + 3), hi: true }); break }
    parts.push({ text: rest.slice(start + 3, end), hi: true })
    rest = rest.slice(end + 3)
  }

  return (
    <TabShell title="Search Match" grow={2}>
      <scrollbox scrollY flexGrow={1}>
        <box flexDirection="column" width="100%">
          <box minHeight={1}>
            <text wrapMode="word"><span fg={theme.accent}><strong>{r.title ?? "Untitled"}</strong></span></text>
          </box>
          <box height={1} />
          <KVBlock rows={[
            ["Source", badge(r.source)],
            ["Model", r.model ?? "—"],
            ["Time", when(r.started_at)],
          ]} />
          <box height={1} />
          <box height={1}><text fg={theme.textMuted}>Snippet</text></box>
          <box minHeight={1}>
            <text wrapMode="word">
              {parts.map((p, i) => p.hi
                ? <span key={i} fg={theme.accent}><strong>{p.text}</strong></span>
                : <span key={i} fg={theme.text}>{p.text}</span>
              )}
            </text>
          </box>
        </box>
      </scrollbox>
    </TabShell>
  )
})
// Col/Hdr live in ui/table; header pads by VBAR_W so its grow column
// matches body rows inside the forced-visible v-bar scrollbox.

const HeaderRow = memo((props: { sort: Sort; onSort: (s: Sort) => void }) => {
  const theme = useTheme().theme
  const fg = theme.textMuted
  const on = theme.accent
  const by = props.sort
  return (
    <Hdr>
      <Col w={2} fg={fg}>{"  "}</Col>
      <Col grow fg={fg} bold>Title</Col>
      <Col w={9} fg={fg} bold>Source</Col>
      <Col w={8} fg={by === "started" ? on : fg} bold
           onClick={() => props.onSort("started")}>
        {by === "started" ? "Start ▾" : "Start"}
      </Col>
      <Col w={10} fg={by === "active" ? on : fg} bold right
           onClick={() => props.onSort("active")}>
        {by === "active" ? "Active ▾" : "Active"}
      </Col>
      <Col w={7} fg={fg} bold right>Msgs</Col>
      <box width={3} />
    </Hdr>
  )
})

// Row callbacks take the index so the *functions* are stable across
// renders — otherwise every row gets a fresh closure every parent
// render and memo() never bails (O(N) React work per keystroke).
type RowCbs = {
  onActivate: (i: number) => void
  onHover: (i: number) => void
  onDelete: (i: number) => void
}

const Item = memo((props: {
  id: string; row: Row; idx: number; selected: boolean; indent?: boolean; locked?: boolean
} & RowCbs) => {
  const theme = useTheme().theme
  const { row: r, idx: i } = props
  const [x, setX] = useState(false)
  const active = r.detail?.last_active ?? r.detail?.ended_at ?? null
  const locked = props.locked || props.indent || Boolean(r.live)
  const subs = !props.indent && (r.detail?.subagent_count ?? 0) > 0
  // Parent rows get "▸ "/"  " leaders; child rows get "└─" as the tree
  // marker. Selected children still highlight via backgroundColor +
  // text color — indent is the only hierarchy signal.
  const leader = props.indent ? "└─" : (props.selected ? "▸ " : "  ")
  const muted = props.indent && !props.selected ? theme.textMuted : undefined

  return (
    <box id={props.id} flexDirection="row" height={1}
         backgroundColor={props.selected ? theme.backgroundElement : undefined}
         onMouseDown={() => props.onActivate(i)} onMouseMove={() => props.onHover(i)}>
      <Col w={2} fg={props.selected ? theme.primary : (muted ?? theme.text)}>{leader}</Col>
      <Marquee grow active={props.selected}
               fg={props.selected ? theme.accent : (muted ?? theme.text)}
               bold={props.selected}
               underline={props.selected && subs}>
        {label(r)}
      </Marquee>
      <Col w={9} fg={muted ?? theme.info}>{badge(src(r))}</Col>
      <Col w={8} fg={theme.textMuted}>{stamp(r.started_at)}</Col>
      <Col w={10} fg={theme.textMuted} right>{active ? ago(active) : "—"}</Col>
      <Col w={7} fg={theme.textMuted} right>{subs ? `${r.detail?.subagent_count} subs` : String(r.message_count)}</Col>
      {locked ? <box width={3} /> : (
        <box width={3}
             onMouseDown={(e) => { e.stopPropagation(); props.onDelete(i) }}
             onMouseOver={() => setX(true)} onMouseOut={() => setX(false)}>
          <text><span fg={x ? theme.error : theme.textMuted}>{" ✕"}</span></text>
        </box>
      )}
    </box>
  )
})

const SearchHeaderRow = memo(() => {
  const theme = useTheme().theme
  const fg = theme.textMuted
  return (
    <Hdr>
      <Col w={2} fg={fg}>{"  "}</Col>
      <Col grow fg={fg} bold>Title</Col>
      <Col w={9} fg={fg} bold>Source</Col>
      <Col w={10} fg={fg} bold>When</Col>
      <Col w={20} fg={fg} bold>Model</Col>
    </Hdr>
  )
})

const SearchItem = memo((props: {
  id: string; result: SessionHit; idx: number; selected: boolean
  onActivate: (i: number) => void; onHover: (i: number) => void
}) => {
  const theme = useTheme().theme
  const { result: r, idx: i } = props
  return (
    <box id={props.id} flexDirection="row" height={1}
         backgroundColor={props.selected ? theme.backgroundElement : undefined}
         onMouseDown={() => props.onActivate(i)} onMouseMove={() => props.onHover(i)}>
      <Col w={2} fg={props.selected ? theme.primary : theme.text}>{props.selected ? "▸ " : "  "}</Col>
      <Col grow fg={props.selected ? theme.accent : theme.text} bold={props.selected}>
        {r.title ?? "Untitled"}
      </Col>
      <Col w={9} fg={theme.info}>{badge(r.source)}</Col>
      <Col w={10} fg={theme.textMuted}>{ago(r.started_at)}</Col>
      <Col w={20} fg={theme.textMuted}>{r.model ?? "—"}</Col>
    </box>
  )
})

// Data-layer ops are injectable so tests don't fight analytics.test
// for the shared sandbox state.db. Defaults go through the io worker
// (off-thread bun:sqlite) except the two writers, which are rare and
// main-thread on purpose — they open a short-lived RW handle.
type P<F extends (...a: never[]) => unknown> =
  (...a: Parameters<F>) => ReturnType<F> | Promise<ReturnType<F>>
type IO = {
  list: P<typeof sdb.roots>
  search: P<typeof sdb.search>
  subagents: P<typeof sdb.children>
  lineage: P<typeof sdb.lineage>
  peek: P<typeof sdb.peek>
  remove: typeof sdb.remove
  rename: typeof sdb.rename
}

type Props = {
  focused?: boolean
  currentId?: string
  onSwitch?: (sid: string) => void
  onActivateLive?: (sid: string) => void
  io?: Partial<IO>
}

// Module-level cache so revisiting the tab paints the previous list on
// frame 1 while load() refreshes in place. Tests that inject `io` don't
// write here (see `cached` guard in load) — keeps suites independent.
const last = { rows: [] as Row[], kids: new Map<string, Row[]>() }

export const Sessions = memo((props: Props) => {
  const theme = useTheme().theme
  const gw = useGateway()
  const dialog = useDialog()
  const toast = useToast()
  const dims = useTerminalDimensions()

  const cached = props.io == null
  const io = useMemo<IO>(() => ({
    list: props.io?.list ?? dbio.roots,
    search: props.io?.search ?? dbio.search,
    subagents: props.io?.subagents ?? dbio.children,
    lineage: props.io?.lineage ?? dbio.lineage,
    peek: props.io?.peek ?? dbio.peek,
    remove: props.io?.remove ?? sdb.remove,
    rename: props.io?.rename ?? sdb.rename,
  }), [props.io])

  const [rows, setRows] = useState<Row[]>(cached ? last.rows : [])
  const [liveRows, setLiveRows] = useState<Row[]>([])
  const [warn, setWarn] = useState("")
  const [searchErr, setSearchErr] = useState("")
  const [pending, setPending] = useState(rows.length === 0)
  // Persisted, user-toggleable list ordering. roots() returns the
  // producer's active window; we re-sort here so the choice can flip live
  // without re-hitting state.db.
  const sort: Sort = prefs.usePref("sessions")?.sort ?? "active"
  const setSort = useCallback((s: Sort) => prefs.set("sessions", { sort: s }), [])
  const [view, setView] = useState<string>(HOME)
  const active = useMemo(() => [...liveRows].sort((a, b) =>
    Number(Boolean(b.live?.current)) - Number(Boolean(a.live?.current)) ||
    ((b.live?.last_active ?? b.started_at) - (a.live?.last_active ?? a.started_at))), [liveRows])
  const ids = useMemo(() => new Set(active.flatMap(r =>
    [r.id, r.live?.session_key].filter((x): x is string => Boolean(x)))), [active])
  const sorted = useMemo(() => rows.filter(r => !ids.has(r.id)).sort(cmp(sort)), [rows, ids, sort])
  const views = useMemo<View[]>(() => {
    const stats = sorted.reduce((m, r) => {
      const s = src(r)
      if (!s) return m
      const prev = m.get(s)
      m.set(s, { count: (prev?.count ?? 0) + 1, last: Math.max(prev?.last ?? 0, tick(r)) })
      return m
    }, new Map<string, { count: number; last: number }>())
    const conv = sorted.filter(r => src(r) !== "cron").length
    return [
      ...(conv > 0 ? [{ id: HOME, label: "Conversations", count: conv, aggregate: "conversations" as const }] : []),
      ...[...stats.entries()]
        .sort((a, b) => b[1].last - a[1].last || badge(a[0]).localeCompare(badge(b[0])))
        .map(([source, stat]) => ({ id: sid(source), label: badge(source), count: stat.count, source })),
    ]
  }, [sorted])
  const cur = views.find(v => v.id === view) ?? views[0]
  const chosen = cur?.id ?? view
  const hist = useMemo(() => {
    if (!cur) return []
    if (cur.aggregate === HOME) return sorted.filter(r => src(r) !== "cron")
    return sorted.filter(r => src(r) === cur.source)
  }, [sorted, cur])
  const listed = useMemo(() => [...active, ...hist], [active, hist])
  useEffect(() => {
    if (views.length > 0 && !views.some(v => v.id === view)) setView(views[0].id)
  }, [views, view])
  // Selection is tracked by row identity so that collapsing children
  // (which changes the flat index of every row below) never lands sel
  // on the wrong row. The numeric index consumers use (handleListKey,
  // rowActivate, etc.) is derived from visible[] each render.
  const [anchor, setAnchor] = useState<{ id: string; indent: boolean } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SessionHit[]>([])
  const [searchSel, setSearchSel] = useState(0)
  // parent_id → children, populated at load() time for every row
  // with subagent_count > 0 so render stays pure (no sync fetch).
  const [kids, setKids] = useState<Map<string, Row[]>>(cached ? last.kids : new Map())
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchGen = useRef(0)
  const vscroll = useRef<ScrollBoxRenderable | null>(null)
  const seen = useRef(false)
  const gen = useRef(0)

  // Space arms one parent for inline children. The branch is only
  // visible while the cursor is on that parent or one of its children,
  // preserving the old selection-shaped traversal without making mere
  // highlight expand rows.
  const anchored = anchor && listed.find(r => r.id === anchor.id)
  const branch = open ? listed.find(r => r.id === open) : undefined
  const owner = branch && (anchor?.indent
    ? kids.get(branch.id)?.some(c => c.id === anchor.id)
    : anchored?.id === branch.id)
    ? branch
    : undefined

  const showDetailPanel = dims.width >= 120

  // Flat visible sequence = parents with `owner`'s children inlined.
  const visible = listed.flatMap((r, i) =>
    r.id === owner?.id
      ? [{ row: r, indent: false, parentIdx: i },
         ...(kids.get(r.id) ?? []).map(c =>
           ({ row: c, indent: true, parentIdx: i }))]
      : [{ row: r, indent: false, parentIdx: i }])
  // Resolve anchor → numeric index into visible. Fallback to 0 when
  // the anchor row is gone (reload dropped it) or never set.
  const sel = anchor
    ? Math.max(0, visible.findIndex(v => v.row.id === anchor.id && v.indent === anchor.indent))
    : 0

  // Latest-value refs so the stable row callbacks below don't close
  // over stale arrays (and therefore don't need to be in their deps,
  // which would defeat the memo).
  const live = useRef({ rows: listed, visible, anchor, results, searching, onSwitch: props.onSwitch, onActivateLive: props.onActivateLive, currentId: props.currentId })
  live.current = { rows: listed, visible, anchor, results, searching, onSwitch: props.onSwitch, onActivateLive: props.onActivateLive, currentId: props.currentId }

  // Adapter for handleListKey, which speaks numeric sel. Translating
  // through the anchor means the target row is resolved against the
  // CURRENT visible layout at call time — collapse/expand re-renders
  // later and sel follows the row, not the stale index.
  const setSel: typeof setSearchSel = useCallback((arg) => {
    const cur = live.current
    const prev = cur.visible.findIndex(v =>
      v.row.id === cur.anchor?.id && v.indent === cur.anchor.indent)
    const n = typeof arg === "function" ? arg(Math.max(0, prev)) : arg
    const v = cur.visible[Math.max(0, Math.min(cur.visible.length - 1, n))]
    if (v) setAnchor({ id: v.row.id, indent: v.indent })
  }, [])

  const LIMIT = 2000

  const keep = (d: SessionRow) => d.message_count > 0 || d.lineage_root_id != null

  const toRow = (d: SessionRow): Row => ({
    id: d.id, title: d.title ?? "", preview: d.lastMessage ?? "",
    message_count: d.message_count, started_at: d.started_at,
    source: d.sessionSource, detail: d,
  })

  const toLiveRow = (s: SessionActiveItem & { source?: string }, d?: SessionRow, r?: Row): Row => ({
    id: s.id,
    title: s.title?.trim() || d?.title || "",
    preview: s.preview ?? "",
    message_count: s.message_count ?? d?.message_count ?? r?.message_count ?? 0,
    started_at: s.started_at ?? d?.started_at ?? r?.started_at ?? s.last_active ?? 0,
    source: d?.sessionSource ?? r?.source ?? s.source ?? "",
    detail: d,
    live: s,
  })

  const pick = <T,>(m: Map<string, T>, s: SessionActiveItem) =>
    m.get(s.id) ?? m.get(s.session_key ?? "")

  const patchTitle = useCallback((id?: string, title?: string) => {
    if (!id || title === undefined) return
    home.update("recentSessions", rows => rows.map(r => r.id === id ? { ...r, title } : r))
    setRows(prev => prev.map(row => row.id === id ? { ...row, title, detail: row.detail ? { ...row.detail, title } : row.detail } : row))
    setLiveRows(prev => prev.map(row => row.id === id || row.live?.session_key === id
      ? { ...row, title, live: row.live ? { ...row.live, title } : row.live }
      : row))
  }, [])

  useGatewayEvent(ev => {
    if (ev.type === "session.title") patchTitle(ev.payload.session_id, ev.payload.title)
  })

  // Two-stage paint. io.list is off-thread, so the mount frame commits
  // (spinner / cached rows) before it resolves; the RPC is slower still.
  // Kids (subagents per parent) fill in after the list — the tree
  // expands by anchor, so until then it just doesn't expand.
  const load = useCallback(async () => {
    const current = ++gen.current
    setPending(true)
    const rpc = gw.request<SessionListResponse>("session.list", { limit: LIMIT })
      .then(r => ({ ok: true as const, v: r }))
      .catch((e: Error) => ({ ok: false as const, e }))
    const active = gw.request<SessionActiveListResponse>("session.active_list", { current_session_id: props.currentId })
      .then(r => ({ ok: true as const, v: r }))
      .catch((e: Error) => ({ ok: false as const, e }))
    const fs = Promise.resolve(io.list(LIMIT)).catch(() => [])

    const disk = await fs
    if (gen.current !== current) return
    const local = new Map(disk.map(r => [r.id, r]))
    const diskRows = disk.filter(keep).map(toRow)
    setRows(diskRows)
    if (cached) last.rows = diskRows

    const [a, r] = await Promise.all([active, rpc])
    if (gen.current !== current) return
    const live = a.ok ? (a.v.sessions ?? []) : []
    if (a.ok) {
      setLiveRows(live.map(s => toLiveRow(s, pick(local, s))))
    }

    // Stock session.list doesn't drop 0-msg stubs — every abandoned
    // connect leaves one, and they're never useful to resume. Keep
    // local state.db rows as authoritative for herm: gateway rows can
    // be stale, over-filtered, or ordered differently, but they are
    // still useful when herm is pointed at a remote/mismatched state.
    // Order is applied by the `sorted` memo, not here.
    let final = diskRows
    if (r.ok && r.v.sessions?.length) {
      const seen = new Set(diskRows.map(s => s.id))
      const merged = [
        ...diskRows,
        ...r.v.sessions
          .filter(s => (s.message_count ?? 0) > 0 && !seen.has(s.id))
          .map(s => ({ ...s, detail: local.get(s.id) })),
      ]
      final = merged
      setRows(merged)
      if (cached) last.rows = merged
      const found = new Map(merged.map(s => [s.id, s]))
      if (live.length) setLiveRows(live.map(s => toLiveRow(s, pick(local, s), pick(found, s))))
    }

    let kidsError = ""
    try {
      const parents = final.filter(row => (row.detail?.subagent_count ?? 0) > 0)
      const children: SessionRow[][] = []
      for (let i = 0; i < parents.length; i += 8) {
        children.push(...await Promise.all(parents.slice(i, i + 8).map(row => io.subagents(row.id))))
        if (gen.current !== current) return
      }
      if (gen.current !== current) return
      const next = new Map(parents.map((row, i) => [row.id, children[i].map(toRow)]))
      setKids(next)
      if (cached) last.kids = next
    } catch (err) {
      kidsError = err instanceof Error ? err.message : String(err)
    }
    if (gen.current !== current) return
    setPending(false)
    const listError = !r.ok
      ? local.size
        ? `gateway session.list failed (${r.e.message}) — listing state.db directly; rows may not resume`
        : r.e.message
      : ""
    setWarn([listError, kidsError].filter(Boolean).join(" · "))
  }, [gw, props.currentId, io, cached])

  useEffect(() => { load() }, [load])
  useEffect(() => () => { gen.current++ }, [])

  // Seed anchor once rows arrive. If active rows arrive after the
  // optimistic history paint, promote the untouched first row to active.
  useEffect(() => {
    const on = active.length > 0
    const fresh = on && !seen.current
    if (!listed.length) { seen.current = on; return }
    if (!anchor || !visible.some(v => v.row.id === anchor.id && v.indent === anchor.indent)) {
      setAnchor({ id: listed[0].id, indent: false })
      seen.current = on
      return
    }
    if (fresh && active[0] && hist[0]?.id === anchor.id && !anchor.indent) {
      setAnchor({ id: active[0].id, indent: false })
    }
    seen.current = on
  }, [listed, active, hist, anchor])

  // Search is an FTS5 query on state.db, so debounce to avoid flooding
  // the worker on every keystroke. The
  // cleanup clears the pending timer, which also drops superseded
  // queries for free (only the most recent query value ever runs).
  useEffect(() => {
    const current = ++searchGen.current
    setSearchErr("")
    if (!searching || !query.trim()) { setResults([]); return }
    setResults([])
    setSearchSel(0)
    debounce.current = setTimeout(() => {
      void Promise.resolve(io.search(query, 30)).then(r => {
        if (searchGen.current !== current) return
        setResults(r)
        setSearchSel(0)
        setSearchErr("")
      }).catch(err => {
        if (searchGen.current === current)
          setSearchErr(err instanceof Error ? err.message : String(err))
      })
    }, 150)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [query, searching, io])
  // Hover-to-select is onMouseMove, not onMouseOver — the latter fires
  // when scrollChildIntoView moves rows under a stationary cursor and
  // would snap sel back during ↓-repeat (the "stutter"). Mouse motion
  // events only arrive on real pointer movement.
  const rowHover = useCallback((i: number) => {
    live.current.searching ? setSearchSel(i) : setSel(i)
  }, [setSel])
  // Switching sessions reset()s the current chat; confirm unless it's
  // a no-op (same id) or there's nothing to switch to.
  const rowActivate = useCallback((i: number) => {
    const l = live.current
    l.searching ? setSearchSel(i) : setSel(i)
    const hit = l.searching ? l.results[i] : l.visible[i]?.row
    const id = l.searching ? (hit as SessionHit | undefined)?.session_id : (hit as Row | undefined)?.id
    if (!id) return
    if (!l.searching && (hit as Row | undefined)?.live) {
      if (l.onActivateLive) return l.onActivateLive(id)
      return l.onSwitch?.(id)
    }
    if (!l.onSwitch) return
    if (id === l.currentId) return l.onSwitch(id)
    const title = (hit as { title?: string } | undefined)?.title || "Untitled"
    const n = l.searching ? undefined : (hit as Row).message_count
    void openConfirm(dialog, {
      title: "Load session?",
      body: `${trunc(title, 60)}${n != null ? `  ·  ${n} msg${n === 1 ? "" : "s"}` : ""}\n\nCurrent chat will be replaced.`,
      yes: "load",
    }).then(ok => { if (ok) l.onSwitch?.(id) })
  }, [dialog])
  // Delete on a child row is a no-op (only parents can be deleted from
  // the list). The ✕ glyph is hidden for indented rows anyway; this
  // guard covers the keyboard shortcut path.
  const rowDelete = useCallback((i: number) => {
    const v = live.current.visible[i]
    if (v && !v.indent && !v.row.live && v.row.id !== live.current.currentId)
      confirmDeleteRef.current(v.row)
  }, [])

  // Lineage-click switches target a SPECIFIC session (the predecessor
  // or successor), not the projected tip. Confirm to match list click.
  const lineageSwitch = useCallback((sid: string) => {
    const l = live.current
    if (!l.onSwitch) return
    if (sid === l.currentId) return l.onSwitch(sid)
    void openConfirm(dialog, {
      title: "Load session?",
      body: `Switch to ${trunc(sid, 24)}?\n\nCurrent chat will be replaced.`,
      yes: "load",
    }).then(ok => { if (ok) l.onSwitch?.(sid) })
  }, [dialog])

  const confirmDeleteRef = useRef<(r: Row) => void>(() => {})
  const confirmDelete = useCallback((r: Row) => {
    openConfirm(dialog, {
      title: "Delete Session?",
      body: trunc(label(r), 46),
      yes: "Delete",
      danger: true,
    }).then(async ok => {
      if (!ok) return
      // session.delete RPC first — it refuses to remove the active
      // session and also unlinks transcript files. Fall back to the
      // direct DELETE only when the gateway rejects/is down.
      const done = await gw.request<{ deleted: string }>("session.delete", { session_id: r.id })
        .then(() => true)
        .catch((e: Error) => {
          if (/cannot delete an active session/i.test(e.message)) {
            toast.show({ variant: "error", message: "Can't delete the active session" })
            return false
          }
          if (fallback(e.message))
            return io.remove(r.id)
          toast.show({ variant: "error", message: e.message })
          return false
        })
      if (!done) return
      home.invalidate("recentSessions")
      toast.show({ variant: "success", message: "Session deleted" })
      void load()
    })
  }, [gw, dialog, toast, load])
  confirmDeleteRef.current = confirmDelete

  const rename = useCallback(async () => {
    const v = live.current.visible[sel]
    // Rename only operates on parent rows — subagent children don't
    // have stable titles (usually a single-line delegate prompt) and
    // the ✕ affordance is already hidden for them.
    if (!v || v.indent) return
    const r = v.row
    const name = await openTextPrompt(dialog, {
      title: `Rename: ${trunc(label(r), 42)}`, label: "Title", initial: r.title || "",
    })
    if (name === null) return
    Promise.resolve()
      .then(async () => {
        const title = r.live
          ? (await gw.request<{ title?: string }>("session.title", { session_id: r.id, title: name })).title ?? name
          : name
        if (!r.live && !io.rename(r.id, title)) throw new Error("not found")
        const ids = [r.id, r.live?.session_key].filter((id): id is string => Boolean(id))
        home.invalidate("recentSessions")
        // Patch in place so the row updates without a full RPC reload
        // (session.list is the slow path). reload still happens next r.
        ids.forEach(id => patchTitle(id, title))
        toast.show({ variant: "success", message: "Renamed" })
      })
      .catch((e: Error) =>
        toast.show({ variant: "error", message: `Rename failed: ${e.message}` }))
  }, [gw, dialog, toast, sel, patchTitle])

  const toggle = useCallback(() => {
    const v = visible[sel]
    if (!v) return
    if (v.indent) {
      const p = listed.find(r => kids.get(r.id)?.some(c => c.id === v.row.id))
      if (!p) return
      setAnchor({ id: p.id, indent: false })
      setOpen(null)
      return
    }
    if ((v.row.detail?.subagent_count ?? 0) <= 0) return
    setOpen(id => id === v.row.id ? null : v.row.id)
  }, [visible, sel, listed, kids])

  const count = searching ? results.length : visible.length
  // Stable ids — include row.id + indent flag so a row moving between
  // indices (because a sibling expanded above it) doesn't collide with
  // the previous occupant. OpenTUI's reconciler keys on this; reused
  // ids after a layout shift log "Anchor is the same as the node X
  // being inserted, skipping insertBefore" and drop rows.
  const rowId = (i: number) => {
    if (searching) return `sess-s-${results[i]?.session_id ?? i}`
    const v = visible[i]
    return v ? `sess-${v.indent ? "c" : "p"}-${v.row.id}` : `sess-empty-${i}`
  }

  const keys = useKeys()
  useKeyboard((key) => {
    if (!props.focused || dialog.open()) return
    if (searching) {
      if (key.name === "escape") { setSearching(false); setQuery(""); setResults([]); setSearchSel(0); return }
      if (key.name === "backspace") return setQuery(p => p.slice(0, -1))
      if (key.name === "return") return rowActivate(searchSel)
      if (key.name === "up") return setSearchSel(p => Math.max(0, p - 1))
      if (key.name === "down") return setSearchSel(p => Math.min(count - 1, p + 1))
      if (key.raw && key.raw.length === 1 && key.raw >= " ") return setQuery(p => p + key.raw)
      return
    }
    const matched = handleListKey(keys, key, {
      count, setSel,
      page: Math.max(1, (vscroll.current?.viewport.height ?? 10) - 1),
      scrollTo: n => vscroll.current?.scrollChildIntoView(rowId(n)),
      onActivate: () => rowActivate(sel),
      onToggle: toggle,
      onRefresh: () => { void load(); toast.show({ variant: "info", message: "Reloaded", duration: 1000 }) },
      onDelete: () => {
        const v = visible[sel]
        if (v && !v.indent && !v.row.live && v.row.id !== props.currentId) confirmDelete(v.row)
      },
      onSearch: () => { setSearching(true); setQuery(""); setResults([]); setSearchSel(0) },
    })
    if (matched) return
    if (keys.match("sessions.sort", key)) return setSort(sort === "active" ? "started" : "active")
    if (keys.match("sessions.rename", key)) return void rename()
    const prev = keys.match("sessions.prev", key)
    const next = keys.match("sessions.next", key)
    if (prev || next) {
      if (views.length < 2) return
      const dir = prev ? -1 : 1
      setView(v => {
        const list = views.map(x => x.id)
        const i = list.indexOf(v)
        return list[((i < 0 ? 0 : i) + dir + list.length) % list.length]
      })
      return
    }
  })

  const empty = searching ? results.length === 0 && query.length > 0 : active.length === 0 && sorted.length === 0
  const action = visible[sel]?.row.live ? "activate live" : "switch"
  const top = (i: number) => Boolean(visible[i]?.row.live && (i === 0 || !visible[i - 1]?.row.live))
  const tabs = (i: number) => Boolean(views.length > 0 && hist[0] && !visible[i]?.indent && visible[i]?.row.id === hist[0].id)
  const gap = (i: number) => active.length > 0 && tabs(i)
  const blank = cur?.aggregate === HOME ? "No conversations found"
    : cur ? `No ${cur.label} sessions found` : "No sessions found"
  const nav = views.length > 1 ? [["←→", "filter"] as [string, string]] : []
  const sub = visible[sel]?.indent || (visible[sel]?.row.detail?.subagent_count ?? 0) > 0
    ? [[keys.print("list.toggle"), visible[sel]?.indent || open === visible[sel]?.row.id ? "hide subs" : "show subs"] as [string, string]]
    : []

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
    <box flexDirection="row" flexGrow={1}>
      <TabShell
        title={searching
          ? `Search Results (${results.length})`
          : `Sessions (${listed.length}${pending ? "…" : ""})`}
        error={[warn, searchErr].filter(Boolean).join(" · ") || null}
        grow={3}
      >
        {searching ? (
          <box height={1} marginBottom={1}>
            <text>
              <span fg={theme.accent}>/ </span>
              <span fg={theme.text}>{query}</span>
              <span fg={theme.accent}>█</span>
            </text>
          </box>
        ) : null}

        {empty ? (
          // key prevents OpenTUI reconciler reusing this <box> for the
          // table wrapper below — it doesn't unset padding when the new
          // vnode omits it, so padding={2} would leak into the table.
          <box key="empty" flexGrow={1} padding={2}>
            {pending && !searching
              ? <Spinner color={theme.textMuted} label="loading sessions…" />
              : <text fg={theme.textMuted}>
                  {searching ? "No matching sessions found" : "No sessions found"}
                </text>}
          </box>
        ) : (
          <box key="table" flexDirection="column" flexGrow={1} minWidth={0}>
            {searching ? <SearchHeaderRow /> : <HeaderRow sort={sort} onSort={setSort} />}
            <box height={1} />
            <scrollbox ref={vscroll} scrollY viewportCulling flexGrow={1}
                       verticalScrollbarOptions={VBAR}>
              {searching
                ? results.map((r, i) => (
                    <SearchItem key={r.session_id} id={rowId(i)} idx={i}
                      result={r} selected={i === searchSel}
                      onActivate={rowActivate} onHover={rowHover} />
                  ))
                : visible.map((v, i) => (
                    <box key={`${v.row.id}-${v.indent ? "c" : "p"}`} flexDirection="column"
                         height={1 + (top(i) ? 1 : 0) + (tabs(i) ? 2 : 0) + (gap(i) ? 1 : 0)}>
                      {top(i) ? (
                        <box height={1} paddingLeft={2}>
                          <text fg={theme.primary}>{active.length === 1 ? "Active Session" : "Active Sessions"}</text>
                        </box>
                      ) : null}
                      {gap(i) ? <box height={1} /> : null}
                      {tabs(i) ? <>
                        <FilterRow views={views} view={chosen} setView={setView} />
                        <box height={1} />
                      </> : null}
                      <Item id={rowId(i)} idx={i}
                        row={v.row} selected={i === sel} indent={v.indent}
                        locked={v.row.id === props.currentId}
                        onActivate={rowActivate} onHover={rowHover} onDelete={rowDelete} />
                    </box>
                  ))}
              {!searching && views.length > 0 && hist.length === 0 ? (
                <box key="sessions-empty-filter" flexDirection="column" height={3 + (active.length > 0 ? 1 : 0)}>
                  {active.length > 0 ? <box height={1} /> : null}
                  <FilterRow views={views} view={chosen} setView={setView} />
                  <box height={1} />
                  <box height={1} paddingLeft={2}>
                    <text fg={theme.textMuted}>{blank}</text>
                  </box>
                </box>
              ) : null}
            </scrollbox>
          </box>
        )}
      </TabShell>

      {showDetailPanel && searching && results[searchSel]
        ? <SearchDetail result={results[searchSel]} />
        : showDetailPanel && !searching && visible[sel]?.row
          ? <Detail key={visible[sel].row.id} row={visible[sel].row}
              lineage={io.lineage} peek={io.peek} onSwitch={lineageSwitch} />
          : null}
    </box>
    <HintBar pairs={searching
      ? [
          ["↑↓", "navigate"],
          ["Enter/click", "switch"],
          ["Esc", "cancel"],
        ]
      : [
          ["↑↓", "navigate"],
          ...nav,
          ...sub,
          [`${keys.print("list.activate")}/click`, action],
          [keys.print("list.search"), "search"],
          [keys.print("sessions.sort"), `sort: ${sort}`],
          [keys.print("sessions.rename"), "rename"],
          [keys.print("list.delete"), "delete"],
          [keys.print("list.refresh"), "refresh"],
        ]} />
    </box>
  )
})
