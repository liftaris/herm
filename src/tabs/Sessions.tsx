import { useState, useEffect, useCallback, useRef, memo } from "react"
import { SIDE_PIPE } from "../ui/borders"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeys, handleListKey } from "../keys"
import * as sdb from "../utils/sessions-db"
import type { SessionRow, SessionHit, LineageInfo, PeekMsg } from "../utils/sessions-db"
import { io as dbio } from "../io"
import type {
  SessionListItem, SessionListResponse,
} from "../utils/gateway-types"
import { useGateway } from "../app/gateway"
import { useTheme } from "../theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { TabShell } from "../ui/shell"
import { KVBlock } from "../ui/kv"
import { Col, Hdr, Marquee, VBAR } from "../ui/table"
import { Spinner } from "../ui/spinner"
import { Ticker, inline } from "../ui/ticker"
import { openConfirm } from "../dialogs/confirm"
import { openTextPrompt } from "../dialogs/text-prompt"
import { fmt, cost, trunc, ago, when, span, stamp } from "../ui/fmt"
import { home } from "../home"

// Architecture: herm's Sessions tab is a **local state.db reader**.
// Stock tui_gateway exposes only ~30% of what the tab needs via RPC
// (see sessions-db.ts header). The gateway is authoritative for
// exactly one thing — *which session ids it can resume* — so we join
// session.list against the local roots() by id. Enrichment (tokens,
// cost, model, lineage, subagents, last_active) all comes from
// state.db. When state.db isn't the gateway's state.db (remote
// gateway, separate profile), enrichment is absent and rows render
// un-enriched; the tab keeps working at session.list fidelity.

type Row = SessionListItem & { detail?: SessionRow }

// ─── Formatting ──────────────────────────────────────────────────────

const badge = (src: string): string => ({
  cli: "CLI", tui: "TUI", api_server: "API", discord: "Discord",
  telegram: "Telegram", slack: "Slack", whatsapp: "WhatsApp", signal: "Signal",
} as Record<string, string>)[src] ?? src

// ─── Transcript Peek ─────────────────────────────────────────────────
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

type Peeker = (sid: string, n?: number) => PeekMsg[] | Promise<PeekMsg[]>

const Peek = memo((props: { sid: string; total: number; peek: Peeker }) => {
  const theme = useTheme().theme
  const [data, setData] = useState<{ turns: Folded[]; tools: number } | null>(null)
  const sb = useRef<ScrollBoxRenderable | null>(null)

  useEffect(() => {
    void Promise.resolve(props.peek(props.sid, 60)).then(m => setData(fold(m)))
  }, [props.sid, props.peek])
  // Pin to bottom on load — "where did this end up", not "how did
  // it start".
  useEffect(() => {
    if (data && sb.current) sb.current.scrollTop = sb.current.scrollHeight
  }, [data])

  if (data === null) return null
  if (data.turns.length === 0 && data.tools === 0) return (
    <box height={1}><text fg={theme.textMuted}>(no local transcript)</text></box>
  )
  const more = Math.max(0, props.total - 60)

  return (
    <box flexDirection="column" flexGrow={1} minHeight={5}
         border borderStyle="single" borderColor={theme.border}
         title={` Transcript${more > 0 ? `  ·  ${more} earlier` : ""} `}
         titleAlignment="left">
      <scrollbox ref={sb} scrollY flexGrow={1} minHeight={3}>
        <box flexDirection="column" width="100%">
          {data.turns.map((r, i) => <PeekRow key={i} row={r} />)}
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

// ─── Detail Panel ────────────────────────────────────────────────────
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
  useEffect(() => {
    void Promise.resolve(props.lineage(r.id)).then(setInfo)
  }, [r.id, props.lineage])
  const hasLineage = info.continuesFrom || info.compressedTo || subs > 0
  const go = (sid: string) => () => props.onSwitch?.(sid)

  return (
    <TabShell title="Session Detail" hint="" grow={2}>
      <box flexDirection="column" width="100%" flexGrow={1} overflow="hidden">
        <box flexDirection="column" flexShrink={0}>
          <box minHeight={1}>
            <text wrapMode="word"><span fg={theme.accent}><strong>{r.title || "Untitled"}</strong></span></text>
          </box>
          <box height={1} />
          <KVBlock rows={[
            ["ID", r.id],
            ["Source", badge(r.source ?? "")],
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

// ─── Search Detail Panel ─────────────────────────────────────────────

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
    <TabShell title="Search Match" hint="" grow={2}>
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
// ─── Rows ────────────────────────────────────────────────────────────
// Col/Hdr live in ui/table; header pads by VBAR_W so its grow column
// matches body rows inside the forced-visible v-bar scrollbox.

const HeaderRow = memo(() => {
  const theme = useTheme().theme
  const fg = theme.textMuted
  return (
    <Hdr>
      <Col w={2} fg={fg}>{"  "}</Col>
      <Col grow fg={fg} bold>Title</Col>
      <Col w={9} fg={fg} bold>Source</Col>
      <Col w={8} fg={fg} bold>Start</Col>
      <Col w={10} fg={fg} bold right>Active</Col>
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
  id: string; row: Row; idx: number; selected: boolean; indent?: boolean
} & RowCbs) => {
  const theme = useTheme().theme
  const { row: r, idx: i } = props
  const [x, setX] = useState(false)
  const active = r.detail?.last_active ?? r.detail?.ended_at ?? null
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
               bold={props.selected}>
        {r.title || "Untitled"}
      </Marquee>
      <Col w={9} fg={muted ?? theme.info}>{badge(r.source ?? "")}</Col>
      <Col w={8} fg={theme.textMuted}>{stamp(r.started_at)}</Col>
      <Col w={10} fg={theme.textMuted} right>{active ? ago(active) : "—"}</Col>
      <Col w={7} fg={theme.textMuted} right>{String(r.message_count)}</Col>
      {props.indent ? <box width={3} /> : (
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

// ─── Main ────────────────────────────────────────────────────────────

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

type Props = { focused?: boolean; currentId?: string; onSwitch?: (sid: string) => void; io?: Partial<IO> }

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
  const io: IO = {
    list: props.io?.list ?? dbio.roots,
    search: props.io?.search ?? dbio.search,
    subagents: props.io?.subagents ?? dbio.children,
    lineage: props.io?.lineage ?? dbio.lineage,
    peek: props.io?.peek ?? dbio.peek,
    remove: props.io?.remove ?? sdb.remove,
    rename: props.io?.rename ?? sdb.rename,
  }

  const [rows, setRows] = useState<Row[]>(cached ? last.rows : [])
  const [warn, setWarn] = useState("")
  const [pending, setPending] = useState(rows.length === 0)
  // Selection is tracked by row identity so that collapsing children
  // (which changes the flat index of every row below) never lands sel
  // on the wrong row. The numeric index consumers use (handleListKey,
  // rowActivate, etc.) is derived from visible[] each render.
  const [anchor, setAnchor] = useState<{ id: string; indent: boolean } | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SessionHit[]>([])
  const [searchSel, setSearchSel] = useState(0)
  // parent_id → children, populated at load() time for every row
  // with subagent_count > 0 so render stays pure (no sync fetch).
  const [kids, setKids] = useState<Map<string, Row[]>>(cached ? last.kids : new Map())
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const vscroll = useRef<ScrollBoxRenderable | null>(null)

  // Expansion is derived from the anchor: if the anchor is a parent
  // row with subagents, that parent is expanded; if the anchor is a
  // child, the child's owning parent is expanded. Anything else = no
  // expansion. This makes collapse/expand atomic with sel changes —
  // no lagging effect, no clamp pass.
  const anchored = anchor && rows.find(r => r.id === anchor.id)
  const owner =
    anchor?.indent
      ? rows.find(r => kids.get(r.id)?.some(c => c.id === anchor.id))
      : (anchored?.detail?.subagent_count ?? 0) > 0 ? anchored : undefined

  // Flat visible sequence = parents with `owner`'s children inlined.
  const visible = rows.flatMap((r, i) =>
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
  const live = useRef({ rows, visible, anchor, results, searching, onSwitch: props.onSwitch, currentId: props.currentId })
  live.current = { rows, visible, anchor, results, searching, onSwitch: props.onSwitch, currentId: props.currentId }

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

  const toRow = (d: SessionRow): Row => ({
    id: d.id, title: d.title ?? "", preview: d.lastMessage ?? "",
    message_count: d.message_count, started_at: d.started_at,
    source: d.sessionSource, detail: d,
  })

  // Two-stage paint. io.list is off-thread, so the mount frame commits
  // (spinner / cached rows) before it resolves; the RPC is slower still.
  // Kids (subagents per parent) fill in after the list — the tree
  // expands by anchor, so until then it just doesn't expand.
  const load = useCallback(async () => {
    setPending(true)
    const rpc = gw.request<SessionListResponse>("session.list", { limit: LIMIT })
      .then(r => ({ ok: true as const, v: r }))
      .catch((e: Error) => ({ ok: false as const, e }))
    const fs = Promise.resolve(io.list(LIMIT)).catch(() => [])

    const disk = await fs
    const local = new Map(disk.map(r => [r.id, r]))
    const diskRows = disk.filter(d => d.message_count > 0).map(toRow)
    setRows(diskRows)
    if (cached) last.rows = diskRows

    const fillKids = async (list: Row[]) => {
      const ps = list.filter(r => (r.detail?.subagent_count ?? 0) > 0)
      const cs = await Promise.all(ps.map(r => io.subagents(r.id)))
      const m = new Map(ps.map((r, i) => [r.id, cs[i].map(toRow)]))
      setKids(m)
      if (cached) last.kids = m
    }
    void fillKids(diskRows)

    // Stock session.list doesn't drop 0-msg stubs — every abandoned
    // connect leaves one, and they're never useful to resume. Keep
    // local state.db rows as authoritative for herm: gateway rows can
    // be stale, over-filtered, or ordered differently, but they are
    // still useful when herm is pointed at a remote/mismatched state.
    const r = await rpc
    if (r.ok && r.v.sessions?.length) {
      const seen = new Set(diskRows.map(s => s.id))
      const merged = [...diskRows]
      for (const s of r.v.sessions.filter(s => (s.message_count ?? 0) > 0)) {
        if (seen.has(s.id)) continue
        seen.add(s.id)
        merged.push({ ...s, detail: local.get(s.id) })
      }
      setRows(merged)
      if (cached) last.rows = merged
      void fillKids(merged)
    }
    setPending(false)
    setWarn(!r.ok
      ? local.size
        ? `gateway session.list failed (${r.e.message}) — listing state.db directly; rows may not resume`
        : r.e.message
      : "")
  }, [gw])

  useEffect(() => { load() }, [load])

  // Seed anchor once rows arrive (first row, unexpanded).
  useEffect(() => {
    if (!anchor && rows.length) setAnchor({ id: rows[0].id, indent: false })
  }, [rows, anchor])

  // Search is a synchronous FTS5 query on state.db, so debounce —
  // running it on every keystroke blocks the render thread. The
  // cleanup clears the pending timer, which also drops superseded
  // queries for free (only the most recent query value ever runs).
  useEffect(() => {
    if (!searching || !query.trim()) { setResults([]); return }
    debounce.current = setTimeout(() => {
      void Promise.resolve(io.search(query, 30)).then(r => {
        setResults(r)
        setSearchSel(0)
      })
    }, 150)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [query, searching])

  // ── Stable row callbacks (identity never changes) ────────────────
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
    if (!id || !l.onSwitch) return
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
    if (v && !v.indent) confirmDeleteRef.current(v.row)
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
      body: trunc(r.title || "Untitled", 46),
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
          if (/active session/i.test(e.message)) {
            toast.show({ variant: "error", message: "Can't delete the active session" })
            return false
          }
          return io.remove(r.id)
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
    const title = await openTextPrompt(dialog, {
      title: `Rename: ${trunc(r.title || "Untitled", 42)}`, label: "Title", initial: r.title || "",
    })
    if (title === null) return
    Promise.resolve()
      .then(() => {
        if (!io.rename(r.id, title)) throw new Error("not found")
        home.invalidate("recentSessions")
        // Patch in place so the row updates without a full RPC reload
        // (session.list is the slow path). reload still happens next r.
        setRows(prev => prev.map(row => row.id === r.id ? { ...row, title } : row))
        toast.show({ variant: "success", message: "Renamed" })
      })
      .catch((e: Error) =>
        toast.show({ variant: "error", message: `Rename failed: ${e.message}` }))
  }, [dialog, toast, sel])

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
      onRefresh: () => { void load(); toast.show({ variant: "info", message: "Reloaded", duration: 1000 }) },
      onDelete: () => {
        const v = visible[sel]
        if (v && !v.indent) confirmDelete(v.row)
      },
      onSearch: () => { setSearching(true); setQuery(""); setResults([]); setSearchSel(0) },
    })
    if (matched) return
    if (keys.match("sessions.rename", key)) return void rename()
    if (keys.match("sessions.prev", key) || keys.match("sessions.next", key)) {
      // Walk the compression chain. continuesFrom is the ancestor
      // (older session this was resumed from), compressedTo is the
      // descendant (newer session this compressed into). Look up
      // lineage on demand — query is in-process and sub-ms, no
      // reason to cache across the small number of ←/→ presses.
      const v = visible[sel]
      if (!v) return
      void Promise.resolve(io.lineage(v.row.id)).then(ln => {
        const target = keys.match("sessions.prev", key)
          ? ln.continuesFrom?.id
          : ln.compressedTo?.id
        if (target) lineageSwitch(target)
      })
      return
    }
  })

  const empty = searching ? results.length === 0 && query.length > 0 : rows.length === 0
  // Sidebar yields at <140 on non-Chat tabs (app.tsx), so detail can
  // stay mounted down to the shell's own floor.
  const showDetailPanel = dims.width >= 120

  return (
    <box flexDirection="row" flexGrow={1}>
      <TabShell
        title={searching
          ? `Search Results (${results.length})`
          : `Sessions (${rows.length}${pending ? "…" : ""})`}
        hint={searching
          ? "↑↓ navigate  Enter/click switch  Esc cancel"
          : `↑↓ navigate  ←→ lineage  ${keys.print("list.activate")}/click switch  ${keys.print("list.search")} search  ${keys.print("sessions.rename")} rename  ${keys.print("list.delete")} delete  ${keys.print("list.refresh")} refresh`}
        error={warn || null}
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
            {searching ? <SearchHeaderRow /> : <HeaderRow />}
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
                    <Item key={`${v.row.id}-${v.indent ? "c" : "p"}`} id={rowId(i)} idx={i}
                      row={v.row} selected={i === sel} indent={v.indent}
                      onActivate={rowActivate} onHover={rowHover} onDelete={rowDelete} />
                  ))}
            </scrollbox>
          </box>
        )}
      </TabShell>

      {showDetailPanel && searching && results[searchSel]
        ? <SearchDetail result={results[searchSel]} />
        : showDetailPanel && !searching && visible[sel]?.row
          ? <Detail row={visible[sel].row} lineage={io.lineage} peek={io.peek} onSwitch={lineageSwitch} />
          : null}
    </box>
  )
})
