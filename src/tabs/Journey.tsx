import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useGateway } from "../context/gateway"
import type { LearningBucket, LearningFramesResponse, LearningNode, LearningDetailResponse, LearningEditRequest, LearningDeleteRequest, LearningMutationResponse, LearningRun } from "../context/wire"
import { useTheme } from "../theme"
import type { Theme } from "../theme"
import { handleListKey, useFollow, useKeys } from "../keys"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { openConfirm } from "../dialogs/confirm"
import { editInEditor } from "../utils/editor"
import { trunc } from "../ui/fmt"

export type JourneyRow =
  | { kind: "gap" }
  | { kind: "slice"; bucket: LearningBucket }
  | { kind: "node"; bucket: LearningBucket; node: LearningNode; last: boolean }

export function buildJourneyRows(buckets: readonly LearningBucket[]): JourneyRow[] {
  return buckets.flatMap((bucket, b) => [
    ...(b > 0 ? [{ kind: "gap" as const }] : []),
    { kind: "slice" as const, bucket },
    ...bucket.nodes.map((node, i) => ({ kind: "node" as const, bucket, node, last: i === bucket.nodes.length - 1 })),
  ])
}

const style = (theme: Theme, key?: string, hex?: string | null): RGBA => {
  if (hex && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return RGBA.fromHex(hex)
  if (key === "skill") return theme.primary
  if (key === "memory") return theme.accent
  if (key === "label") return theme.text
  if (key === "dim") return theme.textMuted
  if (key === "bg") return theme.borderSubtle
  return theme.textMuted
}

const last = (data: LearningFramesResponse | null) => data?.frames.at(-1)?.grid ?? []

const latest = (rows: readonly JourneyRow[]) => {
  const i = [...rows].reverse().findIndex(r => r.kind === "node")
  return i >= 0 ? rows.length - 1 - i : Math.max(0, rows.length - 1)
}

const snap = (rows: readonly JourneyRow[], i: number, dir = 1) => {
  if (rows.length === 0) return 0
  const at = Math.max(0, Math.min(rows.length - 1, i))
  if (rows[at]?.kind !== "gap") return at
  const rev = [...rows].reverse().findIndex((r, n) => rows.length - 1 - n < at && r.kind !== "gap")
  if (dir < 0 && rev >= 0) return rows.length - 1 - rev
  const fwd = rows.findIndex((r, n) => n > at && r.kind !== "gap")
  if (fwd >= 0) return fwd
  return rev >= 0 ? rows.length - 1 - rev : at
}

const message = (err: unknown) => err instanceof Error ? err.message : String(err)

const rid = (r: JourneyRow | undefined, i: number) => {
  if (!r) return `empty-${i}`
  if (r.kind === "slice") return `slice-${r.bucket.index}-${r.bucket.date ?? r.bucket.label}`
  if (r.kind === "node") return `node-${r.bucket.index}-${r.node.id}`
  return `gap-${i}`
}

export const Journey = memo((props: { focused?: boolean }) => {
  const gw = useGateway()
  const theme = useTheme().theme
  const dialog = useDialog()
  const toast = useToast()
  const renderer = useRenderer()
  const dims = useTerminalDimensions()
  const keys = useKeys()
  const [data, setData] = useState<LearningFramesResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const [detail, setDetail] = useState<LearningDetailResponse | null>(null)
  const [pane, setPane] = useState<"list" | "detail">("list")
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  const rows = useMemo(() => buildJourneyRows(data?.buckets ?? []), [data])
  const row = rows[Math.min(sel, Math.max(0, rows.length - 1))]
  const node = row?.kind === "node" ? row.node : undefined
  const chart = last(data)
  const h = Math.max(5, Math.min(8, Math.floor(dims.height * 0.2)))
  const cols = Math.max(40, dims.width - 8)
  const follow = useFollow("journey", i => rid(rows[i], i))
  const scroll = useRef<ScrollBoxRenderable | null>(null)
  const seq = useRef(0)

  const jump = useCallback((i: number) => {
    const n = snap(rows, i)
    setSel(n)
    follow.opts.scrollTo(n)
  }, [rows])

  const setListSel = useCallback((next: number | ((prev: number) => number)) => {
    setSel(prev => {
      const target = typeof next === "function" ? next(prev) : next
      const n = snap(rows, target, target - prev)
      follow.opts.scrollTo(n)
      return n
    })
  }, [rows])

  useEffect(() => {
    let n = 0
    const cb = async () => {
      n++
      if (n < 2) return
      follow.opts.scrollTo(sel)
      renderer.removeFrameCallback(cb)
    }
    renderer.setFrameCallback(cb)
    return () => renderer.removeFrameCallback(cb)
  }, [renderer, rows, sel])

  useEffect(() => {
    const n = ++seq.current
    setErr(null)
    setBusy(true)
    const timer = setTimeout(() => {
      void gw.request<LearningFramesResponse>("learning.frames", { cols, rows: h, frames: 2 })
        .then(r => {
          if (n !== seq.current) return
          setData(r)
          const tree = buildJourneyRows(r.buckets ?? [])
          setSel(latest(tree))
          setDetail(null)
          setPane("list")
        })
        .catch((e: unknown) => { if (n === seq.current) setErr(message(e)) })
        .finally(() => { if (n === seq.current) setBusy(false) })
    }, 120)
    return () => { clearTimeout(timer); seq.current++ }
  }, [gw, cols, h, tick])

  const open = useCallback(async (target: LearningNode) => {
    setBusy(true)
    setErr(null)
    try {
      const r = await gw.request<LearningDetailResponse>("learning.detail", { id: target.id })
      setDetail(r)
      setPane("detail")
      if (!r.ok) toast.show({ variant: "warning", message: r.message })
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }, [gw, toast])

  const edit = useCallback(async () => {
    if (!node) return
    setBusy(true)
    setErr(null)
    try {
      const info = await gw.request<LearningDetailResponse>("learning.detail", { id: node.id })
      if (!info.ok) {
        toast.show({ variant: "warning", message: info.message })
        return
      }
      const text = await editInEditor(renderer, info.content, info.kind === "skill" ? ".md" : ".txt")
      if (text === undefined || text.trim() === info.content.trim()) {
        toast.show({ variant: "info", message: "no changes" })
        return
      }
      const req: LearningEditRequest = { id: node.id, content: text }
      const r = await gw.request<LearningMutationResponse>("learning.edit", req)
      toast.show({ variant: r.ok ? "success" : "warning", message: r.message })
      if (r.ok || /stale|refresh/i.test(r.message)) setTick(n => n + 1)
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }, [gw, node, renderer, toast])

  const del = useCallback(async () => {
    if (!node) return
    const ok = await openConfirm(dialog, {
      title: `Delete ${node.label}?`,
      body: `${node.fullLabel || node.label}\n\nThis mutates the learning source through learning.delete.`,
      yes: "delete",
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      const req: LearningDeleteRequest = { id: node.id }
      const r = await gw.request<LearningMutationResponse>("learning.delete", req)
      toast.show({ variant: r.ok ? "success" : "warning", message: r.message })
      if (r.ok || /stale|refresh/i.test(r.message)) setTick(n => n + 1)
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }, [dialog, gw, node, toast])

  useKeyboard(key => {
    if (!props.focused || dialog.open() || busy) return
    if (detail && (key.name === "tab" || keys.match("focus.cycle", key))) { setPane(p => p === "list" ? "detail" : "list"); return }
    if (detail && pane === "detail") {
      const page = Math.max(1, (scroll.current?.viewport.height ?? 10) - 1)
      if (key.name === "escape") { setPane("list"); return }
      if (key.name === "up" || key.name === "k" || key.raw === "k") { scroll.current?.scrollBy(-1); return }
      if (key.name === "down" || key.name === "j" || key.raw === "j") { scroll.current?.scrollBy(1); return }
      if (key.name === "pageup") { scroll.current?.scrollBy(-page); return }
      if (key.name === "pagedown") { scroll.current?.scrollBy(page); return }
      if (key.name === "home" || key.name === "g") { scroll.current?.scrollTo(0); return }
      if (key.name === "end" || key.raw === "G" || (key.name === "g" && key.shift)) { scroll.current?.scrollTo(scroll.current.scrollHeight); return }
      return
    }
    if (key.name === "escape" && detail) { setDetail(null); setPane("list"); return }
    const matched = handleListKey(keys, key, {
      count: rows.length,
      setSel: setListSel,
      ...follow.opts,
      onActivate: () => { if (node) void open(node) },
      onToggle: () => { if (node) void open(node) },
      onRefresh: () => setTick(n => n + 1),
      onDelete: () => void del(),
    })
    if (matched) return
    if (key.name === "e" || key.raw === "e") { void edit(); return }
  })

  const rowPick = useCallback((i: number) => jump(i), [jump])
  const rowOpen = useCallback((i: number) => {
    jump(i)
    const r = rows[i]
    if (r?.kind === "node") void open(r.node)
  }, [jump, open, rows])

  const hint = detail && pane === "detail"
    ? `↑↓/jk scroll  ${keys.print("list.pageUp")}/${keys.print("list.pageDown")} page  Tab list  Esc list`
    : `${keys.print("list.activate")} detail  ${keys.print("list.toggle")} detail  e edit  ${keys.print("list.delete")} delete  ${keys.print("list.refresh")} reload${detail ? "  Tab detail  Esc close" : ""}`

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <box flexDirection="row" flexGrow={1} minWidth={0}>
        <TabShell title={data ? `Journey · ${data.count} learned item${data.count === 1 ? "" : "s"}` : "Journey"} error={err} focus={pane === "list"} grow={detail ? 2 : 1}>
          {!data && !err ? <Loading /> : null}
          {!data && err ? <ErrorState err={err} /> : null}
          {data && data.count === 0 ? <Empty /> : null}
          {data && data.count > 0 ? (
            <box flexDirection="column" flexGrow={1} minHeight={0}>
              <Legend data={data} />
              <Chart rows={chart} theme={theme} />
              <box height={1} />
              <scrollbox ref={follow.ref} scrollY flexGrow={1}>
                <box flexDirection="column">
                  {rows.map((r, i) => <Row key={rid(r, i)} id={follow.id(i)} row={r} index={i} active={i === sel} theme={theme} pick={rowPick} open={rowOpen} />)}
                </box>
              </scrollbox>
            </box>
          ) : null}
        </TabShell>
        {detail ? <Detail detail={detail} box={scroll} focus={pane === "detail"} theme={theme} /> : null}
      </box>
      <HintBar raw={busy ? "loading…" : hint} />
    </box>
  )
})

const Loading = () => {
  const theme = useTheme().theme
  return <box flexGrow={1} justifyContent="center" alignItems="center"><text fg={theme.textMuted}>assembling learning map…</text></box>
}

const Empty = () => {
  const theme = useTheme().theme
  return <box flexGrow={1} justifyContent="center" alignItems="center"><text fg={theme.textMuted}>No learning yet — skills and memories will appear here.</text></box>
}

const ErrorState = ({ err }: { err: string }) => {
  const theme = useTheme().theme
  return <box flexGrow={1} justifyContent="center" alignItems="center"><text fg={theme.error} wrapMode="word">{err}</text></box>
}

const Legend = ({ data }: { data: LearningFramesResponse }) => {
  const theme = useTheme().theme
  const items = [...(data.legend ?? []), ...(data.categories ?? [])]
  const text = items.map(i => `${i.glyph} ${i.label}`).join("  ") || data.summary.join("  ")
  return <box height={1} overflow="hidden"><text fg={theme.textMuted} wrapMode="none">{text}</text></box>
}

const Chart = ({ rows, theme }: { rows: LearningRun[][]; theme: Theme }) => (
  <box flexDirection="column" flexShrink={0}>
    {rows.map((row, i) => (
      <box key={i} height={1} overflow="hidden">
        <text wrapMode="none">
          {row.map((run, n) => <span key={n} fg={style(theme, run[1], run[3])}>{run[0]}</span>)}
        </text>
      </box>
    ))}
  </box>
)

const Row = memo((props: { id: string; row: JourneyRow; index: number; active: boolean; theme: Theme; pick: (i: number) => void; open: (i: number) => void }) => {
  const bg = props.active ? props.theme.backgroundElement : undefined
  const caret = props.active ? "▸ " : "  "
  if (props.row.kind === "gap") return <box id={props.id} height={1} />
  if (props.row.kind === "slice") return (
    <box id={props.id} height={1} backgroundColor={bg} onMouseMove={() => props.pick(props.index)} onMouseDown={() => props.open(props.index)} overflow="hidden">
      <text wrapMode="none">
        <span fg={props.theme.textMuted}>{caret}</span>
        <span fg={props.active ? props.theme.accent : props.theme.primary}>{props.row.bucket.label}</span>
        <span fg={props.theme.textMuted}>{`  ${props.row.bucket.total} total · ${props.row.bucket.memories} memories · ${props.row.bucket.skills} skills`}</span>
      </text>
    </box>
  )
  return (
    <box id={props.id} height={1} backgroundColor={bg} onMouseMove={() => props.pick(props.index)} onMouseDown={() => props.open(props.index)} overflow="hidden">
      <text wrapMode="none">
        <span fg={props.theme.textMuted}>{caret}</span>
        <span fg={props.theme.textMuted}>{props.row.last ? "  └─ " : "  ├─ "}</span>
        <span fg={props.active ? props.theme.accent : style(props.theme, props.row.node.style)}>{`${props.row.node.glyph} ${trunc(props.row.node.fullLabel || props.row.node.label, 54)}`}</span>
        <span fg={props.theme.textMuted}>{props.row.node.meta ? `  ${props.row.node.meta}` : ""}</span>
      </text>
    </box>
  )
})

const Detail = (props: { detail: LearningDetailResponse; box: React.RefObject<ScrollBoxRenderable | null>; focus: boolean; theme: Theme }) => (
  <TabShell title={props.detail.ok ? `${props.detail.kind} · ${props.detail.label}` : "Detail"} focus={props.focus} grow={1}>
    {props.detail.ok ? (
      <scrollbox ref={props.box} scrollY flexGrow={1}>
        <box flexDirection="column" width="100%">
          {props.detail.content.split(/\r?\n/).map((line, i) => (
            <box key={i} minHeight={1}>
              <text fg={props.theme.text} wrapMode="word">{line || " "}</text>
            </box>
          ))}
        </box>
      </scrollbox>
    ) : (
      <text fg={props.theme.warning} wrapMode="word">{props.detail.message}</text>
    )}
  </TabShell>
)
