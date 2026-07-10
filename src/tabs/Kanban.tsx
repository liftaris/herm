import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { BorderSides, MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import {
  boardStateOf, detailOf, tailLogOf, assignees, q, STATUSES,
  currentBoard, listBoards, resetKanban,
  maxSeverity,
  type Task, type Status, type Detail, type Board, type BlockKind,
  type Diag, type Severity, type BoardError, type PatchFields,
} from "../service/hermes-kanban"
import { patch as patchTask } from "../io/kanban"
import { useKeys } from "../keys"
import { useTheme } from "../theme"
import { useGateway } from "../context/gateway"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { Ticker } from "../ui/ticker"
import { FilterChip, cycle, type Tri } from "../ui/filter-chip"
import { openConfirm } from "../dialogs/confirm"
import { openTextPrompt } from "../dialogs/text-prompt"
import { openCreateTask } from "../dialogs/new-task"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { ago, trunc } from "../ui/fmt"
import { load as loadPrefs, set as setPref, type KanbanPrefs } from "../context/preferences"
import { parseDispatchResult, dispatchFailures, dispatchGuarded, dispatchVariant, dispatchDetails } from "../service/kanban-dispatch"
import { FileLink } from "../components/ui/FileLink"
import type { Source } from "../service/hermes-home"
import { useKanbanDiagnostics } from "./kanban-diagnostics"

// Operator surface for every kanban board under ~/.hermes/.
//
// Boards stack vertically; each is a collapsible section (▾/▸
// header + filter-chip bar + capped-height row of status columns).
// Reads are sidecar SQLite per board. Writes split by kind:
//   - title/body/priority: worker-backed bun:sqlite inside a
//     BEGIN IMMEDIATE txn + task_events row, mirroring dashboard
//     plugin_api PATCH /tasks/:id.
//   - status transitions / assign / link / edit / comment / dispatch:
//     `shell.exec → hermes kanban --board <slug> <verb>` so
//     kanban_db.py owns the state machine (run closure,
//     recompute_ready, notify-sub fanout).
//
// Focus model — one cursor, four tiers per board:
//   head    the ▾/▸ line            Space folds the board
//   filter  chip bar                ←→ chip, Space toggles
//   grid    columns × rows          ←→ col, ↑↓ row
//   pane    detail pane fields      ↑↓ / Tab walks fields
//
// Tab jumps boards UNLESS the detail pane is open — then Tab moves
// focus INTO the pane (tier=pane). Esc out of pane returns to grid;
// Esc again closes the pane.
//
//   Tab/⇧Tab board / pane field   ←→↑↓ nav            Enter detail/edit
//   Space    fold / chip           Esc close pane      r reload
//   n/N      create/child          a assign            c comment
//   u        unblock               d archive           l worker log
//   D        dispatch              b new board

type Sh = { stdout: string; stderr: string; code: number }
type Tier = "head" | "filter" | "grid" | "pane"
type BlockSupport = "unknown" | "yes" | "no"

// Column scrollbars hidden — the column border + ↑↓ are enough
// signal at kanban card density; the bar steals a col per status.
const NOBAR = { visible: false } as const
const RULE: BorderSides[] = ["bottom"]

const HEAD: Record<Status, string> = {
  triage: "triage", todo: "todo", scheduled: "scheduled",
  ready: "ready", running: "running", blocked: "blocked", done: "done",
}
// Each chip cycles off → include → exclude → off. Per-group
// semantics: a group with no `in` chips passes everything not
// `ex`'d; once any chip is `in`, the group passes ONLY `in` values
// (minus `ex`'d — though in/ex are mutually exclusive per chip, so
// that edge is moot). Same machinery for who/pri/status — status
// `ex` additionally drops the column itself.

type Chip =
  | { kind: "who"; v: string }
  | { kind: "pri"; v: number }
  | { kind: "status"; v: Status }
type Mask = {
  who: Map<string, Tri>; pri: Map<number, Tri>; status: Map<Status, Tri>
}

const EMPTY: Mask = { who: new Map(), pri: new Map(), status: new Map() }
const EMPTY_DIAG: Map<string, Diag[]> = new Map()
const EMPTY_DIAGS: Diag[] = []

const chipId = (c: Chip) =>
  c.kind === "who" ? `who:${c.v}` : c.kind === "pri" ? `pri:${c.v}` : `st:${c.v}`
const chipLabel = (c: Chip) =>
  c.kind === "who" ? c.v : c.kind === "pri" ? `P${c.v}` : HEAD[c.v]
const triOf = (c: Chip, m: Mask): Tri =>
  c.kind === "who" ? m.who.get(c.v) ?? "off"
  : c.kind === "pri" ? m.pri.get(c.v) ?? "off"
  : m.status.get(c.v) ?? "off"

const recOf = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null

const assignedByDefault = (d: Detail): boolean =>
  d.events.some(e => e.kind === "assigned"
    && recOf(e.payload)?.source === "kanban.default_assignee")

/** True when `v` survives the group. Absence ⇒ "off". */
function admits<V>(g: Map<V, Tri>, v: V): boolean {
  const t = g.get(v)
  if (t === "ex") return false
  if (t === "in") return true
  for (const s of g.values()) if (s === "in") return false
  return true
}
const pass = (t: Task, m: Mask) =>
  admits(m.who, t.assignee ?? null as unknown as string)
  && admits(m.pri, t.priority)

// Masks + open-set round-trip through ~/.config/herm/tui.json under
// the `kanban` key. Keyed by slug. Maps/Sets flatten to entry arrays
// for JSON.

const maskFromPrefs = (raw: KanbanPrefs["masks"]): Map<string, Mask> => {
  const out = new Map<string, Mask>()
  if (!raw) return out
  for (const slug of Object.keys(raw)) {
    const g = raw[slug]
    out.set(slug, {
      who: new Map(g.who ?? []),
      pri: new Map(g.pri ?? []),
      status: new Map(g.status ?? []) as Map<Status, Tri>,
    })
  }
  return out
}

const maskToPrefs = (masks: Map<string, Mask>): KanbanPrefs["masks"] => {
  const out: NonNullable<KanbanPrefs["masks"]> = {}
  for (const [slug, m] of masks) {
    // Only persist the two non-"off" states; consumer uses Map.get
    // which returns undefined for missing keys, same as "off" default.
    const filt = <K,>(xs: Array<[K, Tri]>) =>
      xs.filter(([, t]) => t === "in" || t === "ex") as Array<[K, "in" | "ex"]>
    const who = filt<string>([...m.who])
    const pri = filt<number>([...m.pri])
    const status = filt<string>([...m.status] as Array<[string, Tri]>)
    // Drop empty slugs to keep the JSON small.
    if (who.length || pri.length || status.length)
      out[slug] = { who, pri, status }
  }
  return out
}

const persist = (masks: Map<string, Mask>, open: Set<string>) => {
  const cur = loadPrefs().kanban ?? {}
  setPref("kanban", {
    ...cur,
    open: [...open],
    masks: maskToPrefs(masks),
  })
}
// Title + bottom rule. The Ticker is always mounted; `active` gates
// its interval. This avoids the conditional-mount path where the
// inner renderable is swapped while the mouse is over it — OpenTUI's
// last-hovered tracking could miss the stale element's onMouseOut,
// leaving a row marqueeing after the pointer left.

// Severity → one-glyph badge + color. Keeps cards one line regardless
// of diagnostics count; the pane shows the full list.
const SEV_GLYPH: Record<Severity, string> = {
  warning: "⚠", error: "!!", critical: "‼",
}
type SevTheme = { warning: import("@opentui/core").RGBA; error: import("@opentui/core").RGBA }
const sevColor = (sev: Severity, theme: SevTheme) =>
  sev === "warning" ? theme.warning : theme.error

const KIND: Record<BlockKind, string> = {
  dependency: "dependency-wait",
  needs_input: "needs-input",
  capability: "capability",
  transient: "transient",
}
const MARK: Record<BlockKind, string> = {
  dependency: "dep",
  needs_input: "input",
  capability: "cap",
  transient: "tmp",
}

const blockText = (t: Pick<Task, "block_kind" | "block_recurrences">): string => {
  const kind = t.block_kind ? KIND[t.block_kind] : ""
  const loop = t.block_recurrences > 1 ? `loop×${t.block_recurrences}` : ""
  if (kind && loop) return `${kind} · ${loop}`
  return kind || loop
}

const cardMark = (t: Pick<Task, "block_kind" | "block_recurrences">): string => {
  if (t.block_kind) return `[${MARK[t.block_kind]}${t.block_recurrences > 1 ? `×${t.block_recurrences}` : ""}]`
  return t.block_recurrences > 1 ? `[loop×${t.block_recurrences}]` : ""
}

const statusText = (t: Task): string => {
  const block = blockText(t)
  return block ? `${t.status} · ${block}` : t.status
}

const supportsKind = (r: Sh): boolean =>
  r.code === 0 && /--kind\b/.test(r.stdout)

const unsupportedKind = (r: Sh): boolean => {
  const s = `${r.stderr}\n${r.stdout}`.toLowerCase()
  return r.code !== 0 && s.includes("--kind")
    && (s.includes("unrecognized") || s.includes("no such option")
      || s.includes("unknown option") || s.includes("invalid option"))
}

const Card = memo((p: {
  id: string; t: Task; on: boolean; hov: boolean; sev: Severity | null
  onHover: () => void; onPick: () => void
}) => {
  const theme = useTheme().theme
  const mark = cardMark(p.t)
  return (
    <box id={p.id} height={2} flexDirection="row" paddingLeft={1}
         border={RULE} borderStyle="single" borderColor={theme.borderSubtle}
         backgroundColor={p.on ? theme.backgroundElement : undefined}
         onMouseDown={p.onPick}
         onMouseMove={p.onHover}>
      <Ticker active={p.on || p.hov} fg={p.on ? theme.accent : theme.text}>
        {mark ? <><span fg={theme.warning}>{mark}</span>{" "}</> : null}
        {p.sev
          ? <><span fg={sevColor(p.sev, theme)}>{SEV_GLYPH[p.sev]}</span>{" "}</>
          : null}
        {p.t.title}
      </Ticker>
    </box>
  )
})

const Column = memo((p: {
  slug: string; status: Status; tasks: Task[]; on: boolean; sel: number
  diags: Map<string, Diag[]>
  onPick: (i: number) => void
}) => {
  const theme = useTheme().theme
  const box = useRef<ScrollBoxRenderable | null>(null)
  // Column-level hover index. Lifting it here (instead of per-card
  // local state) means only ONE card can read hov=true at a time,
  // and the column's onMouseOut reliably clears it when the pointer
  // leaves the column — covering the case where a fast exit skips
  // the old card's own out event.
  const [hov, setHov] = useState(-1)
  const id = (i: number) => `kb-${p.slug}-${p.status}-${i}`
  useEffect(() => {
    if (p.on && p.tasks.length > 0) box.current?.scrollChildIntoView(id(p.sel))
  }, [p.on, p.sel, p.tasks.length])
  // 'scheduled' (upstream e3823657d) is a parked/delayed state — distinct
  // from blocked (waiting on human) and done (terminal). Mute the
  // header so it reads as paused rather than active.
  const tint = p.status === "blocked" ? theme.warning
    : p.status === "running" ? theme.success
    : p.status === "scheduled" ? theme.textMuted
    : p.status === "done" ? theme.textMuted : theme.primary
  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={18}
         border borderColor={p.on ? theme.primary : theme.border}
         onMouseOut={() => setHov(-1)}>
      <box height={1} paddingLeft={1}>
        <text>
          <span fg={tint}><strong>{HEAD[p.status]}</strong></span>
          <span fg={theme.textMuted}>{`  ${p.tasks.length}`}</span>
        </text>
      </box>
      <scrollbox id={`kb-col-${p.slug}-${p.status}`} ref={box} scrollY flexGrow={1} verticalScrollbarOptions={NOBAR}
                 onMouseScroll={(e: MouseEvent) => e.stopPropagation()}>
        <box flexDirection="column" width="100%">
          {p.tasks.map((t, i) => (
            <Card key={t.id} id={id(i)} t={t} on={p.on && i === p.sel}
                  hov={i === hov}
                  sev={maxSeverity(p.diags.get(t.id) ?? [])}
                  onHover={() => { if (hov !== i) setHov(i) }}
                  onPick={() => p.onPick(i)} />
          ))}
        </box>
      </scrollbox>
    </box>
  )
})


const ErrorBanner = memo((p: { error: BoardError; backups: string[] }) => {
  const theme = useTheme().theme
  return (
    <box flexDirection="column" marginLeft={2} marginBottom={1}
         paddingLeft={1} border borderColor={theme.error}>
      <box height={1}>
        <text>
          <span fg={theme.error}><strong>Kanban DB {p.error.kind}</strong></span>
          <span fg={theme.textMuted}>{`  ${p.error.path}`}</span>
        </text>
      </box>
      <text wrapMode="word" fg={theme.textMuted}>{p.error.message}</text>
      {p.backups.length > 0 ? (
        <text wrapMode="word" fg={theme.warning}>
          {`quarantine backup${p.backups.length === 1 ? "" : "s"}: ${p.backups.join(", ")}`}
        </text>
      ) : null}
    </box>
  )
})

const FilterBar = memo((p: {
  chips: Chip[]; mask: Mask; on: boolean; sel: number
  onPick: (i: number) => void
}) => {
  const theme = useTheme().theme
  return (
    <box height={1} flexDirection="row" flexWrap="no-wrap" overflow="hidden" marginBottom={1}>
      {p.chips.flatMap((c, i) => {
        const chip = (
          <FilterChip key={chipId(c)} label={chipLabel(c)}
            state={triOf(c, p.mask)} selected={p.on && i === p.sel}
            onMouseDown={() => p.onPick(i)} />
        )
        if (i === 0 || p.chips[i - 1].kind === c.kind) return [chip]
        return [
          <box key={`sep:${chipId(c)}`} height={1} flexShrink={0} marginLeft={1}>
            <text fg={theme.borderSubtle}>|</text>
          </box>,
          chip,
        ]
      })}
    </box>
  )
})

type ColSpec = { status: Status; tasks: Task[] }
type Section = {
  board: Board; cols: ColSpec[]; chips: Chip[]
  total: number; shown: number; running: number; cap: number
  error: BoardError | null; corruptBackups: string[]
}
// Fields are ordered top-to-bottom to match the layout. The
// `editable` flag gates whether Tab/↑↓ can land on a row and whether
// Enter opens an editor. Non-editable rows (runs/events/comments)
// are read-only views that still render in the pane but get skipped
// by the focus walker.

type PaneField =
  | "title" | "body" | "assignee" | "priority" | "status"
  | "parents" | "result" | "comment"
const FIELDS: PaneField[] = [
  "title", "body", "assignee", "priority", "status",
  "parents", "result", "comment",
]

// `result` is only editable when task is done. `body` is always
// editable. Return the subset of FIELDS that apply to the current
// task so Tab/↑↓ in the pane don't land on a disabled row.
const fieldsFor = (t: Task): PaneField[] =>
  FIELDS.filter(f => {
    if (f === "result") return t.status === "done"
    return true
  })

type Pane =
  | { kind: "detail"; slug: string; d: Detail }
  | { kind: "log"; slug: string; id: string; text: string }
  | { kind: "dispatch"; slug: string; text: string }

const SidePane = memo((p: { pane: Pane; on: boolean; sel: number; diags: Diag[] }) => {
  const { theme, syntaxStyle } = useTheme()
  if (p.pane.kind === "log" || p.pane.kind === "dispatch") return (
    <box flexDirection="column" padding={1} border borderColor={theme.border}
         backgroundColor={theme.backgroundPanel} width="50%">
      <box height={1}><text>
        <span fg={theme.primary}><strong>{p.pane.kind === "log" ? p.pane.id : "Dispatch"}</strong></span>
        <span fg={theme.textMuted}>{`  ·  ${p.pane.slug}  ·  ${p.pane.kind === "log" ? "worker log (tail)" : "details"}`}</span>
      </text></box>
      <box height={1} />
      <scrollbox scrollY flexGrow={1}>
        <text wrapMode="word" fg={theme.textMuted}>{p.pane.text || "(empty)"}</text>
      </scrollbox>
    </box>
  )
  const d = p.pane.d
  const fields = fieldsFor(d)
  const cur = p.on ? fields[Math.min(p.sel, fields.length - 1)] : null
  // Simple string row with optional edit-hint on the right. height=1
  // is load-bearing — without it sibling rows stack but can visually
  // overlap when the parent is a scroll/flex container that doesn't
  // reserve line height.
  const srow = (f: PaneField, label: string, value: string, hint?: string) => {
    const active = cur === f
    return (
      <box key={f} height={1} flexDirection="row" paddingLeft={1}
           backgroundColor={active ? theme.backgroundElement : undefined}>
        <box width={10} flexShrink={0}>
          <text fg={active ? theme.accent : theme.textMuted}>{label}</text>
        </box>
        <box flexGrow={1} minWidth={0} overflow="hidden">
          <text fg={active ? theme.text : theme.textMuted}>{value}</text>
        </box>
        {hint ? <box flexShrink={0} paddingLeft={1}>
          <text fg={theme.textMuted}>{hint}</text>
        </box> : null}
      </box>
    )
  }
  // Multi-line row — used for body/result where we want markdown
  // rendering in view mode and plain text in edit. The label row
  // doubles as the row's focus target; content flows in a box
  // indented to the label's 10-col gutter so long lines wrap inside
  // the value column instead of back to the left margin.
  const mrow = (f: PaneField, label: string, content: React.ReactNode, hint?: string) => {
    const active = cur === f
    return (
      <box key={f} flexDirection="column" paddingLeft={1}
           backgroundColor={active ? theme.backgroundElement : undefined}>
        <box height={1} flexDirection="row">
          <box width={10} flexShrink={0}>
            <text fg={active ? theme.accent : theme.textMuted}>{label}</text>
          </box>
          {hint ? <box flexGrow={1} overflow="hidden">
            <text fg={theme.textMuted}>{hint}</text>
          </box> : null}
        </box>
        <box paddingLeft={10} flexShrink={0}>{content}</box>
      </box>
    )
  }
  // Latest summary proxies for result when none was set explicitly.
  // Mirrors `hermes kanban show` — workers write task_runs.summary,
  // not tasks.result, so a raw ``result`` read looks empty even when
  // real work happened.
  const resultText = d.result || d.latest_summary || ""
  const sizeText = (n: number | null) => n === null ? "size unknown"
    : n < 1024 ? `${n} B`
    : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`
  return (
    <box flexDirection="column" padding={1} border borderColor={theme.border}
         backgroundColor={theme.backgroundPanel} width="50%">
      <box height={1}>
        <text>
          <span fg={theme.primary}><strong>{d.id}</strong></span>
          <span fg={theme.textMuted}>{`  ·  ${p.pane.slug}  ·  ${statusText(d)}  ·  ${ago(d.updated_at)}`}</span>
        </text>
      </box>
      <scrollbox scrollY flexGrow={1}>
        <box flexDirection="column" width="100%">
          {srow("title", "Title", d.title,
            p.on && cur === "title" ? "Enter edit" : undefined)}
          {mrow("body", "Body",
            d.body
              ? cur === "body"
                ? <text wrapMode="word" fg={theme.text}>{d.body}</text>
                : <markdown content={d.body} fg={theme.markdownText} syntaxStyle={syntaxStyle} />
              : <text fg={theme.textMuted}>—</text>,
            p.on && cur === "body" ? "Enter edit (raw)" : undefined)}
          {srow("assignee", "Assignee", d.assignee
              ? assignedByDefault(d) ? `${d.assignee} (default)` : d.assignee
              : "—",
            p.on && cur === "assignee" ? "Enter pick" : undefined)}
          {srow("priority", "Priority", d.priority ? `P${d.priority}` : "—",
            p.on && cur === "priority" ? "Enter select" : undefined)}
          {srow("status", "Status", statusText(d),
            p.on && cur === "status" ? "Enter change" : undefined)}
          {srow("parents", "Parents", d.parents.length ? d.parents.join(", ") : "—",
            p.on && cur === "parents" ? "Enter add/remove" : undefined)}
          {d.children.length
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Children</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{d.children.join(", ")}</text>
                </box>
              </box>
            : null}
          {d.project_id
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Project</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{d.project_id}</text>
                </box>
              </box>
            : null}
          {d.workspace_kind
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Workspace</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>
                    {d.workspace_kind}{d.workspace_path ? ` @ ${d.workspace_path}` : ""}
                  </text>
                </box>
              </box>
            : null}
          {d.branch_name
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Branch</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{d.branch_name}</text>
                </box>
              </box>
            : null}
          {d.skills.length
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Skills</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{d.skills.join(", ")}</text>
                </box>
              </box>
            : null}
          {d.model_override
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Model</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{d.model_override}</text>
                </box>
              </box>
            : null}
          {d.max_retries !== null
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Retries</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{String(d.max_retries)}</text>
                </box>
              </box>
            : null}
          {d.pid
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>PID</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{String(d.pid)}</text>
                </box>
              </box>
            : null}
          {d.last_heartbeat_at && d.status === "running"
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Heartbeat</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{ago(d.last_heartbeat_at)}</text>
                </box>
              </box>
            : null}
          {d.session_id
            ? <box height={1} flexDirection="row" paddingLeft={1}>
                <box width={10} flexShrink={0}><text fg={theme.textMuted}>Session</text></box>
                <box flexGrow={1} minWidth={0} overflow="hidden">
                  <text fg={theme.textMuted}>{d.session_id}</text>
                </box>
              </box>
            : null}
          {d.attachments.length > 0 ? <>
            <box height={1} marginTop={1}>
              <text fg={theme.textMuted}>{`Attachments (${d.attachments.length})`}</text>
            </box>
            {d.attachments.map(a => {
              const source: Source | null = a.path
                ? { file: a.path, relative: a.relative_path ?? a.path, label: a.name }
                : null
              return (
                <box key={a.id} flexDirection="column" paddingLeft={1}>
                  <box height={1}><text>
                    <span fg={theme.primary}>{`#${a.id} `}</span>
                    <span fg={theme.text}>{a.name}</span>
                    <span fg={theme.textMuted}>{`  ${sizeText(a.size)}  ${ago(a.created_at)}`}</span>
                  </text></box>
                  {source
                    ? <box height={1} overflow="hidden"><FileLink source={source}>{source.relative}</FileLink></box>
                    : <text wrapMode="word" fg={theme.error}>{`unsafe path omitted: ${a.stored_path}`}</text>}
                </box>
              )
            })}
          </> : null}
          {d.error
            ? <box flexDirection="column" paddingLeft={1}>
                <box height={1}><text fg={theme.error}>Error</text></box>
                <box paddingLeft={2}>
                  <text fg={theme.error} wrapMode="word">{d.error}</text>
                </box>
              </box>
            : null}
          {d.status === "done"
            ? mrow("result", "Result",
                resultText
                  ? cur === "result"
                    ? <text wrapMode="word" fg={theme.text}>{resultText}</text>
                    : <markdown content={resultText} fg={theme.markdownText} syntaxStyle={syntaxStyle} />
                  : <text fg={theme.textMuted}>—</text>,
                p.on && cur === "result" ? "Enter edit" : undefined)
            : null}
          {p.diags.length > 0 ? <>
            <box height={1} marginTop={1}>
              <text>
                <span fg={theme.textMuted}>Diagnostics </span>
                <span fg={sevColor(p.diags[0].severity, theme)}>{`(${p.diags.length})`}</span>
              </text>
            </box>
            {p.diags.map((dx, i) => (
              <box key={`${dx.kind}-${i}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                <box height={1}>
                  <text>
                    <span fg={sevColor(dx.severity, theme)}>{SEV_GLYPH[dx.severity]}</span>
                    <span fg={theme.text}>{` [${dx.severity}] ${dx.kind}`}</span>
                    {dx.count > 1 ? <span fg={theme.textMuted}>{`  ×${dx.count}`}</span> : null}
                  </text>
                </box>
                <box paddingLeft={2} flexDirection="column">
                  <text wrapMode="word" fg={theme.text}>{dx.title}</text>
                  {dx.detail
                    ? <text wrapMode="word" fg={theme.textMuted}>{dx.detail}</text>
                    : null}
                  {dx.actions.map((a, j) => (
                    <box key={j} height={1}>
                      <text>
                        <span fg={a.suggested ? theme.accent : theme.textMuted}>
                          {a.suggested ? "→ " : "· "}
                        </span>
                        <span fg={a.suggested ? theme.text : theme.textMuted}>{a.label}</span>
                      </text>
                    </box>
                  ))}
                </box>
              </box>
            ))}
          </> : null}
          {d.runs.length > 0 ? <>
            <box height={1} marginTop={1}>
              <text fg={theme.textMuted}>{`Runs (${d.runs.length})`}</text>
            </box>
            {d.runs.map(r => {
              const outcome = r.outcome || r.status || (r.ended_at ? "ended" : "active")
              const elapsed = r.ended_at
                ? `${Math.max(0, r.ended_at - r.started_at)}s` : "active"
              return (
                <box key={r.id} flexDirection="column">
                  <box height={1}><text>
                    <span fg={theme.primary}>{`#${r.id} `}</span>
                    <span fg={theme.text}>{outcome}</span>
                    <span fg={theme.textMuted}>{`  @${r.profile ?? "-"}  ${elapsed}  ${ago(r.started_at)}`}</span>
                  </text></box>
                  {r.summary
                    ? <text wrapMode="word" fg={theme.textMuted}>{`  → ${r.summary.split("\n")[0].slice(0, 200)}`}</text>
                    : null}
                  {r.error
                    ? <text wrapMode="word" fg={theme.error}>{`  ✖ ${r.error.split("\n")[0].slice(0, 200)}`}</text>
                    : null}
                </box>
              )
            })}
          </> : null}
          {d.events.length > 0 ? <>
            <box height={1} marginTop={1}>
              <text fg={theme.textMuted}>{`Events (${d.events.length})`}</text>
            </box>
            {d.events.map(e => (
              <box key={e.id} height={1}><text>
                <span fg={theme.textMuted}>{`${ago(e.created_at).padEnd(10)} `}</span>
                <span fg={theme.text}>{e.kind}</span>
                {e.payload
                  ? <span fg={theme.textMuted}>{`  ${JSON.stringify(e.payload)}`}</span>
                  : null}
              </text></box>
            ))}
          </> : null}
          {d.comments.length > 0 ? <>
            <box height={1} marginTop={1}>
              <text fg={theme.textMuted}>{`Comments (${d.comments.length})`}</text>
            </box>
            {d.comments.map((c, i) => (
              <box key={i} flexDirection="column">
                <box height={1}><text fg={theme.textMuted}>{`${c.author}  ·  ${ago(c.at)}`}</text></box>
                <text wrapMode="word">{c.body}</text>
              </box>
            ))}
          </> : null}
          {p.on && cur === "comment" ? (
            <box height={1} marginTop={1}>
              <text fg={theme.accent}>Enter add comment</text>
            </box>
          ) : null}
        </box>
      </scrollbox>
      <box height={1}>
        <text fg={theme.textMuted}>
          {p.on
            ? "Tab/↑↓ field  Enter edit  Esc grid  a assign  c comment  l log"
            : "Tab into pane  a assign  c comment  u unblock  d archive  l log  N child"}
        </text>
      </box>
    </box>
  )
})

export const Kanban = memo((props: { focused?: boolean }) => {
  const theme = useTheme().theme
  const gw = useGateway()
  const dialog = useDialog()
  const toast = useToast()
  const dims = useTerminalDimensions()
  const keys = useKeys()

  const [boards, setBoards] = useState<Board[]>(listBoards)
  const [data, setData] = useState<Map<string, ReturnType<typeof boardStateOf>>>(
    () => new Map(boards.map(b => [b.slug, boardStateOf(b.slug)])),
  )
  const diagnostics = useKanbanDiagnostics(gw)
  const diags = diagnostics.data
  const [masks, setMasks] = useState<Map<string, Mask>>(() =>
    maskFromPrefs(loadPrefs().kanban?.masks))
  const [open, setOpen] = useState<Set<string>>(() => {
    const saved = loadPrefs().kanban?.open
    if (saved) return new Set(saved)
    // First-run fallback: current board + any non-empty board.
    const init = currentBoard()
    return new Set(listBoards()
      .filter(b => {
        const state = boardStateOf(b.slug)
        return b.slug === init || [...state.columns.values()].some(v => v.length > 0) || !!state.error
      })
      .map(b => b.slug))
  })
  const [at, setAt] = useState<string>(currentBoard)
  const [tier, setTier] = useState<Tier>("grid")
  const [col, setCol] = useState(0)
  const [row, setRow] = useState(0)
  const [chip, setChip] = useState(0)
  const [paneSel, setPaneSel] = useState(0)
  const [pane, setPane] = useState<Pane | null>(null)
  const [blocks, setBlocks] = useState<Map<string, BlockSupport>>(() => new Map())

  const outer = useRef<ScrollBoxRenderable | null>(null)

  const load = useCallback(() => {
    const bs = listBoards()
    setBoards(bs)
    setData(new Map(bs.map(b => [b.slug, boardStateOf(b.slug)])))
    setPane(p => p?.kind === "detail"
      ? (d => d ? { ...p, d } : null)(detailOf(p.slug, p.d.id)) : p)
    void diagnostics.refresh(bs)
  }, [diagnostics.refresh])
  useEffect(load, [load])

  // Persist masks + open set whenever either changes.
  useEffect(() => { persist(masks, open) }, [masks, open])

  const maskOf = (s: string): Mask => masks.get(s) ?? EMPTY

  const wide = dims.width >= 160
  // Per-section column height cap. 3 = column border(2)+header,
  // 2 per card (title + bottom rule).
  const maxH = Math.max(8, dims.height - 16)
  const sections = useMemo<Section[]>(() => {
    const built = boards.map(b => {
      const state = data.get(b.slug) ?? boardStateOf(b.slug)
      const d = state.columns
      const flat = STATUSES.flatMap(s => d.get(s) ?? [])
      const total = flat.length
      const who = [...new Set(flat.map(t => t.assignee).filter((v): v is string => !!v))].sort()
      const pri = [...new Set(flat.map(t => t.priority).filter(n => n > 0))].sort((a, z) => z - a)
      const chips: Chip[] = [
        ...who.map(v => ({ kind: "who", v } as const)),
        ...pri.map(v => ({ kind: "pri", v } as const)),
        ...STATUSES.map(v => ({ kind: "status", v } as const)),
      ]
      const m = maskOf(b.slug)
      const cols = STATUSES
        .filter(s => admits(m.status, s))
        .map(s => ({ status: s, tasks: (d.get(s) ?? []).filter(t => pass(t, m)) }))
        .filter(c => wide || c.tasks.length > 0)
      const shown = cols.reduce((a, c) => a + c.tasks.length, 0)
      const tall = cols.reduce((a, c) => Math.max(a, c.tasks.length), 0)
      return {
        board: b, cols, chips, total, shown,
        running: d.get("running")?.length ?? 0,
        cap: Math.min(maxH, Math.max(5, 3 + 2 * tall)),
        error: state.error,
        corruptBackups: state.corruptBackups,
      }
    })
    // Non-empty boards first; empties sink. Stable partition so Tab
    // order doesn't reshuffle on a transient refresh-to-zero.
    return [...built.filter(s => s.total > 0), ...built.filter(s => s.total === 0)]
  }, [boards, data, masks, wide, maxH])

  const idx = sections.findIndex(s => s.board.slug === at)
  const sec = sections[idx] ?? sections[0]
  const cols = sec?.cols ?? []
  const clampCol = Math.min(col, Math.max(0, cols.length - 1))
  const cur = cols[clampCol]
  const task = tier === "grid" || tier === "pane"
    ? cur?.tasks[Math.min(row, Math.max(0, (cur?.tasks.length ?? 1) - 1))]
    : undefined

  const grand = sections.reduce((a, s) => a + s.total, 0)
  const running = sections.reduce((a, s) => a + s.running, 0)

  // Detail pane follows the grid cursor while open. Enter still
  // toggles it; once open, ←→↑↓ rehydrate it to whatever is under
  // the cursor so the side pane reads as a live inspector. Leaving
  // the grid/pane tiers closes it — there's nothing sensible to show
  // for head/filter.
  useEffect(() => {
    if (pane?.kind !== "detail") return
    if (tier !== "grid" && tier !== "pane") { setPane(null); return }
    if (!task) { setPane(null); return }
    if (pane.slug === at && pane.d.id === task.id) return
    const d = detailOf(at, task.id)
    setPane(d ? { kind: "detail", slug: at, d } : null)
    // Reset pane cursor to the first field when the pane retargets so
    // a stale index can't land on a disabled row of the new task.
    setPaneSel(0)
  }, [task?.id, at, tier])

  useEffect(() => {
    if (!props.focused || running === 0) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [props.focused, running, load])

  useEffect(() => {
    outer.current?.scrollChildIntoView(`kb-sec-${at}`)
  }, [at, open])

  const sh = useCallback((argv: string, ok?: string) =>
    gw.request<Sh>("shell.exec", { command: `hermes kanban --board ${q(at)} ${argv}` }).then(r => {
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim())
      if (ok) toast.show({ variant: "success", message: ok })
      // Drop cached handles before re-read — the shell-backed write
      // came from another process; a handle opened before the board
      // existed (or under a since-rotated path) stays null/stale (gh#29).
      resetKanban()
      load()
      return r.stdout
    }).catch((e: Error) => void toast.show({ variant: "error", message: trunc(e.message, 120) })),
  [gw, toast, load, at])

  const blockSupport = useCallback(async (s: string): Promise<BlockSupport> => {
    const cur = blocks.get(s)
    if (cur === "yes" || cur === "no") return cur
    const next = await gw.request<Sh>("shell.exec", { command: `hermes kanban --board ${q(s)} block --help` })
      .then(r => supportsKind(r) ? "yes" as const : "no" as const)
      .catch(() => "no" as const)
    setBlocks(m => {
      const out = new Map(m)
      out.set(s, next)
      return out
    })
    return next
  }, [blocks, gw])

  const runBlock = useCallback((t: Task, reason: string | null, kind: string) => {
    const slug = live.current.at
    const arg = reason ? ` ${q(reason)}` : ""
    const suffix = kind ? ` --kind ${q(kind)}` : ""
    const ok = kind === "dependency" ? `Dependency-wait ${t.id}` : `Blocked ${t.id}`
    return gw.request<Sh>("shell.exec", { command: `hermes kanban --board ${q(slug)} block ${q(t.id)}${arg}${suffix}` })
      .then(r => {
        if (unsupportedKind(r) && kind) {
          setBlocks(m => {
            const out = new Map(m)
            out.set(slug, "no")
            return out
          })
          throw new Error("active Hermes CLI does not support typed block kinds; choose generic block")
        }
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim())
        toast.show({ variant: "success", message: ok })
        resetKanban()
        load()
        return r.stdout
      }).catch((e: Error) => void toast.show({ variant: "error", message: trunc(e.message, 120) }))
  }, [gw, toast, load])

  const writes = useRef(Promise.resolve())
  const patchDirect = useCallback((id: string, p: PatchFields, ok: string) => {
    const board = at
    writes.current = writes.current.then(async () => {
      if (!await patchTask(board, id, p))
        throw new Error(`no such task: ${id}`)
      toast.show({ variant: "success", message: ok })
      load()
    }).catch((e: Error) => {
      toast.show({ variant: "error", message: trunc(e.message, 120) })
    })
  }, [at, toast, load])
  // enterTop/enterBottom land on the first/last reachable tier of
  // the target section so ↑↓ read as one continuous vertical walk.
  // Tab always lands at head (it's the "skip past this board"
  // gesture, not the "continue scrolling" one).

  const enterTop = (s: Section) => {
    setAt(s.board.slug); setTier("head"); setChip(0); setRow(0)
  }
  const enterBottom = (s: Section) => {
    setAt(s.board.slug); setChip(Math.max(0, s.chips.length - 1))
    if (open.has(s.board.slug) && s.shown > 0) {
      const nc = Math.min(col, Math.max(0, s.cols.length - 1))
      setTier("grid"); setCol(nc)
      setRow(Math.max(0, (s.cols[nc]?.tasks.length ?? 1) - 1))
      return
    }
    if (open.has(s.board.slug)) { setTier("filter"); return }
    setTier("head")
  }
  const stepBoard = (d: 1 | -1): Section | null => {
    const n = idx + d
    return n < 0 || n >= sections.length ? null : sections[n]
  }
  const goBoard = useCallback((d: 1 | -1) => {
    const n = (idx + d + sections.length) % sections.length
    const s = sections[n]
    setAt(s.board.slug); setTier("head"); setCol(0); setRow(0); setChip(0)
    setOpen(o => o.has(s.board.slug) ? o : new Set(o).add(s.board.slug))
  }, [idx, sections])

  const flip = useCallback((c: Chip) =>
    setMasks(m => {
      const cur = m.get(at) ?? EMPTY
      const who = new Map(cur.who), pri = new Map(cur.pri), status = new Map(cur.status)
      const g = c.kind === "who" ? who : c.kind === "pri" ? pri : status
      const next = cycle((g as Map<unknown, Tri>).get(c.v) ?? "off")
      next === "off" ? (g as Map<unknown, Tri>).delete(c.v)
        : (g as Map<unknown, Tri>).set(c.v, next)
      const out = new Map(m); out.set(at, { who, pri, status })
      setRow(0)
      return out
    }), [at])

  const toggle = useCallback((s: string) =>
    setOpen(o => {
      const n = new Set(o)
      n.has(s) ? n.delete(s) : n.add(s)
      return n
    }), [])

  const newBoard = useCallback(() =>
    openTextPrompt(dialog, { title: "New board", label: "Slug (a-z, 0-9, -_)" })
      .then(v => {
        if (!v) return
        return gw.request<Sh>("shell.exec",
            { command: `hermes kanban boards create ${q(v)}` })
          .then(r => r.code === 0
            ? (toast.show({ variant: "success", message: `Board '${v}' created` }),
               resetKanban(), load(), setAt(v), setTier("head"))
            : Promise.reject(new Error((r.stderr || r.stdout).trim())))
          .catch((e: Error) => toast.show({ variant: "error", message: trunc(e.message, 120) }))
      }),
  [dialog, gw, toast, load])

  const live = useRef({ task, at, sec })
  live.current = { task, at, sec }

  const create = useCallback((parent?: Task) =>
    openCreateTask(dialog, {
      assignees: assignees(live.current.at),
      parent: parent ? { id: parent.id, title: parent.title } : undefined,
    }).then(d => {
      if (!d) return
      const ws = d.workspace.kind === "scratch" ? ""
        : d.workspace.kind === "worktree" ? "--workspace worktree"
          : `--workspace ${q(`dir:${d.workspace.path}`)}`
      const flags = [
        d.assignee ? `--assignee ${q(d.assignee)}` : "",
        d.body ? `--body ${q(d.body)}` : "",
        d.priority ? `--priority ${d.priority}` : "",
        d.parent ? `--parent ${q(d.parent)}` : "",
        d.triage ? "--triage" : "",
        d.tenant ? `--tenant ${q(d.tenant)}` : "",
        d.project ? `--project ${q(d.project)}` : "",
        ws,
        d.maxRuntime ? `--max-runtime ${q(d.maxRuntime)}` : "",
        ...d.skills.map(s => `--skill ${q(s)}`),
      ].filter(Boolean).join(" ")
      return sh(`create ${q(d.title)} ${flags}`.trim(),
        `Created${d.triage ? " (triage)" : ""}${d.assignee ? ` → ${d.assignee}` : ""}`)
    }), [dialog, sh])

  const assign = useCallback((t: Task) => {
    const opts = [{ title: "(unassigned)", value: "none" },
      ...assignees(live.current.at).map(n => ({ title: n, value: n }))]
    dialog.replace(
      <DialogSelect title={`Assign ${t.id}`} options={opts} current={t.assignee ?? "none"}
        placeholder="Search profiles…"
        onSelect={o => {
          dialog.clear()
          void sh(`assign ${q(t.id)} ${q(o.value)}`,
            o.value === "none" ? `Unassigned ${t.id}` : `${t.id} → ${o.value}`)
        }} />,
    )
  }, [dialog, sh])

  const comment = useCallback((t: Task) =>
    openTextPrompt(dialog, { title: `Comment on ${t.id}`, label: t.title })
      .then(v => v && sh(`comment ${q(t.id)} ${q(v)} --author user`, "Comment added")),
  [dialog, sh])

  // Upstream e3823657d: unblock_task releases BOTH 'blocked' AND
  // 'scheduled' tasks. Same CLI verb on both — for scheduled the
  // comment prompt is skipped (no human is waiting on input).
  const unblock = useCallback((t: Task) => {
    if (t.status !== "blocked" && t.status !== "scheduled")
      return void toast.show({ variant: "info", message: `${t.id} is ${t.status}, not blocked/scheduled` })
    if (t.status === "scheduled")
      return void sh(`unblock ${q(t.id)}`, `Released ${t.id}`)
    return openTextPrompt(dialog, {
      title: `Unblock ${t.id}`, label: "Answer (posted as comment, then task → ready)",
    }).then(v => {
      if (v) return sh(`comment ${q(t.id)} ${q(v)} --author user`)
    }).then(() => sh(`unblock ${q(t.id)}`, `Unblocked ${t.id}`))
  }, [dialog, sh, toast])

  const archive = useCallback((t: Task) =>
    openConfirm(dialog, {
      title: "Archive task?", danger: true, yes: "archive",
      body: `${t.id}  ·  ${trunc(t.title, 60)}\n\nMoves to 'archived' and ends any open run. Children stay; their dependency on this task is treated as satisfied.`,
    }).then(ok => { if (ok) void sh(`archive ${q(t.id)}`, `Archived ${t.id}`) }),
  [dialog, sh])
  // Stdout is NDJSON, one line per task. Single-task form emits one
  // row; --all emits N. Both use the same parser: count ok rows, pick
  // the first to show in the success toast.
  type SpecifyRow = { task_id: string; ok: boolean; reason?: string; new_title?: string }
  const parseSpecify = (out: string): SpecifyRow[] =>
    out.split("\n").flatMap(l => l.trim() ? [JSON.parse(l) as SpecifyRow] : [])

  const specify = useCallback((t: Task) => {
    if (t.status !== "triage")
      return void toast.show({ variant: "info", message: `${t.id} is ${t.status}, not triage` })
    return sh(`specify ${q(t.id)} --json`).then(out => {
      if (out == null) return
      const rows = parseSpecify(out)
      const r = rows[0]
      if (!r) return
      if (!r.ok)
        return void toast.show({ variant: "error", message: `specify ${r.task_id}: ${trunc(r.reason ?? "failed", 100)}` })
      toast.show({ variant: "success",
        message: r.new_title ? `Specified ${r.task_id} → ${trunc(r.new_title, 60)}` : `Specified ${r.task_id} → todo` })
    })
  }, [sh, toast])

  const specifyAll = useCallback(() => {
    const triage = live.current.sec?.cols
      .find(c => c.status === "triage")?.tasks.length ?? 0
    if (triage === 0)
      return void toast.show({ variant: "info", message: `No 'triage' tasks on ${live.current.at}` })
    return openConfirm(dialog, {
      title: `Specify all · ${live.current.at}`,
      body: `${triage} task${triage === 1 ? "" : "s"} in 'triage'. Auxiliary LLM expands each body and promotes to todo.`,
      yes: "specify",
    }).then(go => {
      if (!go) return
      return sh(`specify --all --json`).then(out => {
        if (out == null) return
        const rows = parseSpecify(out)
        const ok = rows.filter(r => r.ok).length
        const bad = rows.length - ok
        toast.show({ variant: ok === 0 && bad > 0 ? "error" : "success",
          message: `Specified ${ok}/${rows.length}${bad ? ` (${bad} failed)` : ""}` })
      })
    })
  }, [dialog, sh, toast])

  const dispatch = useCallback(() => {
    const ready = live.current.sec?.cols
      .find(c => c.status === "ready")?.tasks.length ?? 0
    if (ready === 0)
      return void toast.show({ variant: "info", message: `No 'ready' tasks on ${live.current.at}` })
    return openConfirm(dialog, {
      title: `Dispatch · ${live.current.at}`,
      body: `${ready} task${ready === 1 ? "" : "s"} in 'ready'. Spawns one worker per task (one pass).`,
      yes: "dispatch",
    }).then(ok => {
      if (!ok) return
      void sh("dispatch --json").then(out => {
        if (out == null) return
        const r = parseDispatchResult(out)
        const spawned = r.spawned.length
        const deferred = r.skipped_per_profile_capped.length
        const defaults = r.auto_assigned_default.length
        const unassigned = r.skipped_unassigned.length
        const nonspawnable = r.skipped_nonspawnable.length
        const failed = dispatchFailures(r).length
        const guarded = dispatchGuarded(r).length
        const parts = [`${spawned} spawned`]
        if (defaults) parts.push(`${defaults} defaulted`)
        if (deferred) parts.push(`${deferred} deferred`)
        if (unassigned) parts.push(`${unassigned} unassigned`)
        if (nonspawnable) parts.push(`${nonspawnable} non-spawnable`)
        if (failed) parts.push(`${failed} failed`)
        if (guarded) parts.push(`${guarded} guarded`)
        const more = dispatchDetails(r)
        toast.show({
          variant: dispatchVariant(r),
          message: `Dispatch: ${parts.join(" · ")}`,
          action: more ? { label: "details", run: () => setPane({ kind: "dispatch", slug: live.current.at, text: more }) } : undefined,
        })
      }).catch((e: Error) => void toast.show({ variant: "error", message: trunc(e.message, 120) }))
    })
  }, [dialog, sh, toast])

  const showLog = useCallback((t: Task) => {
    const s = live.current.at
    const text = tailLogOf(s, t.id)
    if (text == null)
      return void toast.show({ variant: "info", message: `No worker log for ${t.id}` })
    setPane({ kind: "log", slug: s, id: t.id, text })
  }, [toast])
  // Invoked by Enter when tier=pane. Each one targets the CURRENT
  // task (live.current.task) via the right write path: patchTask
  // for fields the dashboard writes directly, shell.exec for status
  // transitions and list-shaped fields.

  const editTitle = useCallback((t: Task) =>
    openTextPrompt(dialog, { title: `Edit title`, label: t.id, initial: t.title })
      .then(v => v !== null && v !== undefined
        && patchDirect(t.id, { title: v }, `Updated ${t.id}`)),
  [dialog, patchDirect])

  const editBody = useCallback((t: Task) =>
    openTextPrompt(dialog, { title: `Edit body`, label: t.id, initial: t.body ?? "" })
      .then(v => {
        if (v === null || v === undefined) return
        patchDirect(t.id, { body: v }, `Updated ${t.id}`)
      }),
  [dialog, patchDirect])

  const editPriority = useCallback((t: Task) => {
    const opts = Array.from({ length: 10 }, (_, i) => ({
      title: i === 0 ? "P0 (none)" : `P${i}`, value: String(i),
    }))
    dialog.replace(
      <DialogSelect title={`Priority for ${t.id}`} options={opts}
        current={String(t.priority)} filterable={false}
        onSelect={o => {
          dialog.clear()
          patchDirect(t.id, { priority: Number(o.value) }, `${t.id} → P${o.value}`)
        }} />,
    )
  }, [dialog, patchDirect])

  const editResult = useCallback((t: Task) => {
    if (t.status !== "done")
      return void toast.show({ variant: "info", message: `${t.id} is not done` })
    return openTextPrompt(dialog, {
      title: `Edit result`, label: t.id, initial: t.result ?? "",
    }).then(v => {
      if (v == null) return
      void sh(`edit ${q(t.id)} --result ${q(v)}`, `Updated ${t.id} result`)
    })
  }, [dialog, sh, toast])

  const block = useCallback((t: Task) => {
    void blockSupport(live.current.at).then(support => {
      if (support === "no") {
        return openTextPrompt(dialog, {
          title: `Block ${t.id}`,
          label: "Reason (optional; generic block — active CLI has no --kind)",
        }).then(r => { if (r !== null) void runBlock(t, r, "") })
      }
      const opts: Array<{ title: string; value: string; description?: string }> = [
        { title: "generic", value: "", description: "legacy block without --kind" },
        { title: "needs input", value: "needs_input", description: "human answer required" },
        { title: "dependency", value: "dependency", description: "wait in todo until parents finish" },
        { title: "capability", value: "capability", description: "missing tool, credential, or profile capability" },
        { title: "transient", value: "transient", description: "temporary/flaky condition" },
      ]
      dialog.replace(
        <DialogSelect title={`Block kind for ${t.id}`} options={opts}
          current={t.block_kind ?? ""} filterable={false}
          onSelect={async o => {
            dialog.clear()
            const r = await openTextPrompt(dialog, {
              title: `Block ${t.id}`, label: "Reason (optional, posted as comment)",
            })
            if (r !== null) void runBlock(t, r, o.value)
          }} />,
      )
    })
  }, [dialog, blockSupport, runBlock])

  const editStatus = useCallback((t: Task) => {
    // Only expose transitions the CLI has verbs for. 'unblock' covers
    // both blocked (human-waiting) and scheduled (time-waiting) per
    // upstream e3823657d. 'schedule' is the time-delay park; no
    // dispatcher will pick it up until something unblocks it.
    const opts: Array<{ title: string; value: string; description?: string }> = []
    if (t.status !== "done") opts.push({ title: "done", value: "complete",
      description: "mark complete (prompts for result)" })
    if (t.status !== "blocked") opts.push({ title: "blocked", value: "block",
      description: "mark blocked (choose kind, prompts for reason)" })
    if (t.status !== "scheduled") opts.push({ title: "scheduled", value: "schedule",
      description: "park until externally unblocked (prompts for reason)" })
    if (t.status === "blocked" || t.status === "scheduled")
      opts.push({ title: "ready", value: "unblock",
        description: t.status === "scheduled" ? "release back to ready" : "return to ready" })
    opts.push({ title: "archived", value: "archive", description: "archive (terminal)" })
    dialog.replace(
      <DialogSelect title={`Status for ${t.id}`} options={opts}
        current={t.status} filterable={false}
        onSelect={async o => {
          dialog.clear()
          if (o.value === "complete") {
            const res = await openTextPrompt(dialog, {
              title: `Complete ${t.id}`, label: "Result (optional)",
              initial: t.result ?? "",
            })
            const flag = res ? ` --result ${q(res)}` : ""
            void sh(`complete ${q(t.id)}${flag}`, `Completed ${t.id}`)
            return
          }
          if (o.value === "block") return block(t)
          if (o.value === "schedule") {
            const r = await openTextPrompt(dialog, {
              title: `Schedule ${t.id}`, label: "Reason (optional, posted as comment)",
            })
            const arg = r ? ` ${q(r)}` : ""
            void sh(`schedule ${q(t.id)}${arg}`, `Scheduled ${t.id}`)
            return
          }
          if (o.value === "unblock")
            return void sh(`unblock ${q(t.id)}`, `Unblocked ${t.id}`)
          if (o.value === "archive") return void archive(t)
        }} />,
    )
  }, [dialog, sh, archive, block])

  const editParents = useCallback((t: Task) => {
    // Parents live on Detail, not Task; look up the current pane
    // detail for the live parent list. Falls back to empty when the
    // pane is somehow stale.
    const detail = pane?.kind === "detail" && pane.d.id === t.id ? pane.d : detailOf(at, t.id)
    const cur = detail?.parents ?? []
    // Candidate parents = every non-archived task on the same board
    // except self. Cycle prevention is enforced upstream by
    // link_tasks (server rejects with "would cycle"), so we don't
    // need to second-guess here — just show everything usable and
    // let the linker toast the error if it fires.
    const state = data.get(at) ?? boardStateOf(at)
    const d = state.columns
    const all = STATUSES.flatMap(s => d.get(s) ?? [])
    const opts = all
      .filter(x => x.id !== t.id)
      .map(x => ({
        title: x.id, description: trunc(x.title, 50),
        value: x.id,
        category: cur.includes(x.id) ? "linked" : "available",
      }))
    dialog.replace(
      <DialogSelect title={`Parents for ${t.id}`} options={opts}
        placeholder="Select to toggle link…"
        onSelect={o => {
          dialog.clear()
          const linked = cur.includes(o.value)
          if (linked) void sh(`unlink ${q(o.value)} ${q(t.id)}`, `Unlinked ${o.value}`)
          else void sh(`link ${q(o.value)} ${q(t.id)}`, `Linked ${o.value}`)
        }} />,
    )
  }, [dialog, sh, data, at, pane])

  const openField = useCallback((f: PaneField, t: Task) => {
    if (f === "title") return void editTitle(t)
    if (f === "body") return void editBody(t)
    if (f === "assignee") return assign(t)
    if (f === "priority") return editPriority(t)
    if (f === "status") return editStatus(t)
    if (f === "parents") return editParents(t)
    if (f === "result") return void editResult(t)
    if (f === "comment") return void comment(t)
  }, [editTitle, editBody, assign, editPriority, editStatus, editParents, editResult, comment])

  type Act = { key: string; title: string; when: (t?: Task) => boolean; run: (t?: Task) => void }
  const ACTS = useMemo<Act[]>(() => [
    { key: "n", title: "New task",      when: () => true,            run: () => void create() },
    { key: "N", title: "New child",     when: t => !!t,              run: t => void create(t) },
    { key: "a", title: "Assign",        when: t => !!t,              run: t => void assign(t!) },
    { key: "c", title: "Comment",       when: t => !!t,              run: t => void comment(t!) },
    { key: "s", title: "Specify",       when: t => t?.status === "triage", run: t => void specify(t!) },
    { key: "S", title: "Specify all",   when: () => true,            run: () => void specifyAll() },
    { key: "u", title: "Unblock",       when: t => t?.status === "blocked" || t?.status === "scheduled", run: t => void unblock(t!) },
    { key: "d", title: "Archive",       when: t => !!t,              run: t => void archive(t!) },
    { key: "l", title: "Worker log",    when: t => !!t,              run: t => showLog(t!) },
    { key: "b", title: "New board",     when: () => true,            run: () => void newBoard() },
    { key: "D", title: "Dispatch",      when: () => true,            run: () => void dispatch() },
  ], [create, assign, comment, specify, specifyAll, unblock, archive, showLog, newBoard, dispatch])

  const isOpen = open.has(at)
  const paneOpen = pane?.kind === "detail"
  const paneFields = paneOpen ? fieldsFor(pane.d) : []

  useKeyboard((key) => {
    if (!props.focused || dialog.open()) return
    if (key.name === "escape" && pane) {
      // Pane-tier → step back to grid first (pane stays open); pane
      // closes on the next Esc.
      if (tier === "pane") { setTier("grid"); return }
      return setPane(null)
    }
    if (keys.match("list.refresh", key)) return load()
    // Tab behavior:
    //   pane open, not in pane → Tab enters pane (no board-jump).
    //   pane tier → Tab cycles field rows.
    //   otherwise → Tab jumps boards.
    if (key.name === "tab") {
      if (paneOpen && tier !== "pane") { setTier("pane"); setPaneSel(0); return }
      if (tier === "pane") {
        const n = paneFields.length
        if (n === 0) return
        const d = key.shift ? -1 : 1
        setPaneSel(s => (s + d + n) % n)
        return
      }
      return goBoard(key.shift ? -1 : 1)
    }
    if (tier === "pane") {
      const t = live.current.task
      if (!t || !paneOpen) return
      const f = paneFields[Math.min(paneSel, paneFields.length - 1)]
      if (key.name === "up") {
        const n = paneFields.length
        if (n === 0) return
        return setPaneSel(s => (s - 1 + n) % n)
      }
      if (key.name === "down") {
        const n = paneFields.length
        if (n === 0) return
        return setPaneSel(s => (s + 1) % n)
      }
      if (key.name === "return") return openField(f, t)
      // Letter shortcuts still fire while in pane — operators expect
      // `c` / `a` / `l` / `d` to work no matter where focus is.
      const hit = ACTS.find(a => a.key === key.raw && a.when(t))
      if (hit) return hit.run(t)
      return
    }
    if (key.name === "space" || key.name === " ") {
      if (tier === "head") return toggle(at)
      if (tier === "filter" && sec?.chips[chip]) return flip(sec.chips[chip])
      return
    }
    if (key.name === "down") {
      if (tier === "head") {
        if (isOpen) return setTier("filter")
        const n = stepBoard(1); return n ? enterTop(n) : undefined
      }
      if (tier === "filter") {
        if (sec && sec.shown > 0) { setTier("grid"); setRow(0); return }
        const n = stepBoard(1); return n ? enterTop(n) : undefined
      }
      if (row < (cur?.tasks.length ?? 1) - 1) return setRow(r => r + 1)
      const n = stepBoard(1); return n ? enterTop(n) : undefined
    }
    if (key.name === "up") {
      if (tier === "head") {
        const p = stepBoard(-1); return p ? enterBottom(p) : undefined
      }
      if (tier === "filter") return setTier("head")
      if (row > 0) return setRow(r => r - 1)
      return setTier("filter")
    }
    if (key.name === "left") {
      if (tier === "filter") return setChip(c => Math.max(0, c - 1))
      if (tier === "grid") return setCol(c => { const n = Math.max(0, c - 1); setRow(0); return n })
      return
    }
    if (key.name === "right") {
      if (tier === "filter") return setChip(c => Math.min((sec?.chips.length ?? 1) - 1, c + 1))
      if (tier === "grid") return setCol(c => { const n = Math.min(cols.length - 1, c + 1); setRow(0); return n })
      return
    }
    if (key.name === "return") {
      if (tier === "head") return toggle(at)
      if (tier === "filter" && sec?.chips[chip]) return flip(sec.chips[chip])
      if (task) return setPane(p => p?.kind === "detail" && p.d.id === task.id
        ? null : (d => d ? { kind: "detail", slug: at, d } : null)(detailOf(at, task.id)))
      return
    }
    const t = live.current.task
    const hit = ACTS.find(a => a.key === key.raw && a.when(t))
    if (hit) return hit.run(t)
  })

  const hint = useMemo(() => {
    const t = task
    const nav = tier === "head" ? "↑↓ nav  Space fold"
      : tier === "filter" ? "←→ chip  Space toggle"
      : tier === "pane" ? "Tab/↑↓ field  Enter edit  Esc grid"
      : "←→↑↓ nav  Enter detail"
    return [tier === "pane" ? "Esc grid" : "Tab board", nav,
      ...ACTS.filter(a => a.when(t)).map(a => `${a.key} ${a.title.toLowerCase()}`),
      `${keys.print("list.refresh")} reload`].join("  ")
  }, [ACTS, keys, task, tier])

  const onHead = useCallback((s: string) => {
    setAt(s); setTier("head"); toggle(s)
  }, [toggle])
  const onChip = useCallback((s: string, i: number, c: Chip) => {
    setAt(s); setTier("filter"); setChip(i); flip(c)
  }, [flip])
  const onPick = useCallback((s: string, ci: number, ri: number, id: string) => {
    setAt(s); setTier("grid"); setCol(ci); setRow(ri)
    setOpen(o => o.has(s) ? o : new Set(o).add(s))
    const d = detailOf(s, id)
    if (d) setPane({ kind: "detail", slug: s, d })
  }, [])

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
    <box flexDirection="row" flexGrow={1}>
      <TabShell
        title={`Kanban · ${sections.length} board${sections.length === 1 ? "" : "s"} · ${grand} task${grand === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`}
      >
        <scrollbox id="kb-board-scroll" ref={outer} scrollY flexGrow={1} verticalScrollbarOptions={NOBAR}>
          <box flexDirection="column" width="100%">
            {sections.map(s => {
              const on = s.board.slug === at
              const secOpen = open.has(s.board.slug)
              const m = maskOf(s.board.slug)
              const filt = m.who.size + m.pri.size + m.status.size
              const dg = diags.get(s.board.slug) ?? EMPTY_DIAG
              return (
                <box key={s.board.slug} id={`kb-sec-${s.board.slug}`}
                     flexDirection="column" flexShrink={0} marginBottom={1}>
                  <box height={1} onMouseDown={() => onHead(s.board.slug)}
                       backgroundColor={on && tier === "head" ? theme.backgroundElement : undefined}>
                    <text>
                      <span fg={on ? theme.accent : theme.textMuted}>{secOpen ? "▾ " : "▸ "}</span>
                      <span fg={on ? theme.primary : theme.text}><strong>{s.board.name}</strong></span>
                      <span fg={theme.textMuted}>
                        {s.error ? `  ·  ${s.error.kind}`
                          : s.corruptBackups.length > 0 ? `  ·  ${s.corruptBackups.length} corrupt backup${s.corruptBackups.length === 1 ? "" : "s"}`
                          : s.total === 0 ? "  ·  empty"
                          : `  ·  ${filt ? `${s.shown}/` : ""}${s.total} task${s.total === 1 ? "" : "s"}${s.running ? ` · ${s.running} running` : ""}`}
                      </span>
                    </text>
                  </box>
                  {secOpen ? (
                    s.error ? (
                      <ErrorBanner error={s.error} backups={s.corruptBackups} />
                    ) : s.corruptBackups.length > 0 && s.total === 0 ? (
                      <box height={1} marginLeft={2}>
                        <text fg={theme.warning}>{`corrupt backup found: ${s.corruptBackups[0]}`}</text>
                      </box>
                    ) : s.total === 0 ? (
                      <box height={1} marginLeft={2}>
                        <text fg={theme.textMuted}>
                          no tasks — <span fg={theme.accent}>n</span> to create one here
                        </text>
                      </box>
                    ) : (
                      <>
                        <FilterBar chips={s.chips} mask={m}
                          on={on && tier === "filter"}
                          sel={on ? Math.min(chip, s.chips.length - 1) : -1}
                          onPick={i => onChip(s.board.slug, i, s.chips[i])} />
                        {s.cols.length > 0 ? (
                          <box flexDirection="row" height={s.cap} gap={1}>
                            {s.cols.map((c, ci) => (
                              <Column key={c.status} slug={s.board.slug} status={c.status}
                                      tasks={c.tasks}
                                      diags={dg}
                                      on={on && (tier === "grid" || tier === "pane") && ci === clampCol}
                                      sel={on ? row : 0}
                                      onPick={ri => onPick(s.board.slug, ci, ri, c.tasks[ri].id)} />
                            ))}
                          </box>
                        ) : (
                          <box height={1} marginLeft={2}>
                            <text fg={theme.textMuted}>all columns hidden</text>
                          </box>
                        )}
                      </>
                    )
                  ) : null}
                </box>
              )
            })}
          </box>
        </scrollbox>
      </TabShell>
      {pane
        ? <SidePane pane={pane} on={tier === "pane"} sel={paneSel}
            diags={pane.kind === "detail"
              ? (diags.get(pane.slug)?.get(pane.d.id) ?? EMPTY_DIAGS)
              : EMPTY_DIAGS} />
        : null}
    </box>
    <HintBar raw={hint} />
    </box>
  )
})
