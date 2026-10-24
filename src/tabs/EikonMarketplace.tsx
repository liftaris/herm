import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useTheme } from "../theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { FilterChip } from "../ui/filter-chip"
import { openConfirm } from "../dialogs/confirm"
import { openEikonMarketplaceAction } from "../dialogs/eikon-marketplace-action"
import { useKeys, handleListKey, useFollow } from "../keys"
import { EIKON_CARD, EikonCardGrid, EikonTitleList, titleWidth, type EikonCard } from "./eikon-panels"
import * as perf from "../utils/perf"
import { AnimatedAvatar } from "../components/avatar/AnimatedAvatar"
import { parseEikon, type ParsedEikon } from "../components/avatar/eikon"
import { eikon } from "../service/eikon"
import * as market from "../service/eikon-marketplace"
import type { MarketplaceRow, MarketplaceState } from "../service/eikon-marketplace"
import type { AvatarState } from "../components/avatar/states"

const NO_MARKET: MarketplaceState = { status: "empty", query: "", rows: [] }
const DETAIL = 54

type Pane = "grid" | "detail"

type Preview = {
  eikon: ParsedEikon
  state: AvatarState
  states: AvatarState[]
}

function localCatalog(raw?: string) {
  if (!raw) return false
  const url = URL.parse(raw)
  if (!url) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return url.protocol === "file:" || host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".localhost")
}

const filterRows = (rows: MarketplaceRow[], query: string) => {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(r => [r.entry.name, r.entry.author, r.entry.description, r.entry.id]
    .some(x => typeof x === "string" && x.toLowerCase().includes(q)))
}

export const EikonMarketplace = memo((props: {
  focused: boolean
}) => {
  const toast = useToast()
  const dialog = useDialog()
  const keys = useKeys()
  const theme = useTheme().theme
  const rev = useSyncExternalStore(eikon.onRevision, eikon.revision)
  const [sel, setSel] = useState(0)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const [state, setState] = useState<MarketplaceState>(NO_MARKET)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [acting, setActing] = useState(false)
  const [previewState, setPreviewState] = useState<AvatarState>("idle")
  const [preview, setPreview] = useState<Preview | undefined>(undefined)
  const [pane, setPane] = useState<Pane>("grid")
  const previewSeq = useRef(0)
  const loadSeq = useRef(0)
  const actingRef = useRef(false)
  const follow = useFollow("market", i => state.rows[i]?.entry.identityKey ?? i)
  const listFollow = useFollow("market-list", i => state.rows[i]?.entry.identityKey ?? i)
  const dims = useTerminalDimensions()

  useEffect(() => { if (sel >= state.rows.length) setSel(Math.max(0, state.rows.length - 1)) }, [state.rows.length, sel])

  const selected = state.rows[sel]

  useEffect(() => {
    if (!selected || !state.service) {
      setPreview(undefined)
      return
    }
    const id = ++previewSeq.current
    const key = selected.entry.identityKey
    perf.count("market:preview:load")
    state.service.preview(key)
      .then(text => {
        if (previewSeq.current !== id) return
        const e = parseEikon(text)
        const st = e.states.has(previewState) ? previewState : "idle"
        setPreview({
          eikon: e,
          state: st,
          states: [...e.states.keys()] as AvatarState[],
        })
        perf.count("market:preview:ready")
      })
      .catch(err => {
        if (previewSeq.current !== id) return
        setPreview(undefined)
        toast.error(err)
        perf.count("market:preview:error")
      })
  }, [selected, state.service, previewState])

  useEffect(() => () => {
    previewSeq.current++
    setPreview(undefined)
  }, [])

  const loadMarket = useCallback((q = query) => {
    const id = ++loadSeq.current
    setLoading(true)
    const end = perf.mark("market:list:load")
    const catalog = process.env.EIKON_URL
    void market.load({ catalog, allowPrivate: localCatalog(catalog), query: q })
      .then(next => {
        if (loadSeq.current !== id) return
        perf.count("market:list:rows", next.rows.length)
        const rows = next.service ? filterRows(next.service.rows(""), q) : filterRows(next.rows, q)
        setState({ ...next, status: rows.length > 0 ? "ready" : "empty", rows, selected: rows[0] })
        setSel(p => Math.max(0, Math.min(rows.length - 1, p)))
      })
      .finally(() => { end(); if (loadSeq.current === id) setLoading(false) })
  }, [query])

  const refreshMarket = useCallback((svc: market.MarketplaceService, q = query) => {
    const rows = filterRows(svc.rows(""), q)
    setState({ status: rows.length > 0 ? "ready" : "empty", query: q, rows, selected: rows[0], service: svc })
    setSel(p => Math.max(0, Math.min(rows.length - 1, p)))
  }, [query])

  useEffect(() => { loadMarket(query) }, [query, rev, loadMarket])

  const cycle = useCallback((by: number) => {
    const states = preview?.states
    const cur = preview?.state
    if (!states?.length || !cur) return
    const at = Math.max(0, states.indexOf(cur))
    setPreviewState(states[(at + by + states.length) % states.length]!)
  }, [preview])

  const removeSelected = useCallback(async (idx?: number) => {
    const row = state.rows[idx ?? sel]
    const svc = state.service
    const name = row?.installedName ?? row?.entry.name
    if (!row || !svc || !name || !row.removable) return toast.show({ variant: "warning", message: "This eikon is not removable" })
    const active = row.active
    const ok = await openConfirm(dialog, {
      title: `Remove '${name}'?`, danger: true,
      body: active
        ? `Remove the local package for '${name}'. This is the active avatar; removal will clear the active avatar selection.`
        : `Remove the local package for '${name}'. This does not change the active avatar.`,
      yes: "remove", no: "cancel",
    })
    if (!ok) return
    const out = eikon.remove(name, { confirmActive: active })
    if (out) return toast.show({ variant: "warning", message: out.message })
    toast.show({ variant: "info", message: `Removed '${name}'` })
    refreshMarket(svc, query)
  }, [dialog, query, refreshMarket, sel, state.rows, state.service, toast])

  const delistSelected = useCallback(async (row: MarketplaceRow, svc: market.MarketplaceService) => {
    let own: Awaited<ReturnType<typeof svc.delistInfo>>
    try {
      own = await svc.delistInfo(row.entry.identityKey)
    } catch (err) {
      toast.show({ variant: "error", title: "Delist check failed", message: err instanceof Error ? err.message : String(err), duration: 6000 })
      return
    }
    if (!own.eligible) {
      toast.show({ variant: "warning", title: "Delist unavailable", message: own.reason ?? "Only the original GitHub submitter can delist this eikon", duration: 6000 })
      return
    }
    const ok = await openConfirm(dialog, {
      title: `Delist '${row.entry.name}'?`, danger: true,
      body: `This will open a GitHub delist request in liftaris/eikon for '${row.entry.name}'. The registry will remove it automatically after authorship is verified.`,
      yes: "delist", no: "cancel",
    })
    if (!ok) return
    try {
      const out = await svc.delist(row.entry.identityKey)
      toast.show({ variant: "success", title: "Delist requested", message: `${row.entry.name} will be removed automatically once GitHub verifies the request. ${out.url}`, duration: 8000 })
    } catch (err) {
      toast.show({ variant: "error", title: "Delist failed", message: err instanceof Error ? err.message : String(err), duration: 6000 })
    }
  }, [dialog, toast])

  const primary = useCallback((idx?: number) => {
    const row = state.rows[idx ?? sel]
    const svc = state.service
    if (!row || !svc || actingRef.current || acting) return
    const run = async () => {
      actingRef.current = true
      setActing(true)
      try {
        const sizes = !row.installed ? await svc.packageSizes(row.entry.identityKey) : undefined
        const pick = await openEikonMarketplaceAction(dialog, { row, sizes })
        if (!pick) return
        if (pick === "use") {
          const name = row.installedName ?? row.entry.name
          eikon.useInstalled(name)
          toast.show({ variant: "success", message: `Avatar → ${name}` })
          refreshMarket(svc, query)
          return
        }
        if (pick === "delete") return removeSelected(idx)
        if (pick === "delist") return delistSelected(row, svc)
        setInstalling(true)
        try {
          const confirm = row.installState === "active-name-conflict"
            ? await openConfirm(dialog, {
                title: `Replace active '${row.entry.name}'?`, danger: true,
                body: `Installing this catalog package will replace the active avatar's backing package for '${row.entry.name}' because another package with the same installed name is active.`,
                yes: "replace active", no: "cancel",
              })
            : true
          if (!confirm) return
          const out = pick === "download" ? await svc.downloadSource(row.entry.identityKey) : await svc.install(row.entry.identityKey, { media: pick === "source", confirmActive: row.installState === "active-name-conflict" })
          toast.show({ variant: "success", message: pick === "download" ? `Downloaded source for '${out.name}'` : `Installed '${out.name}' (${out.n} files)` })
          refreshMarket(svc, query)
        } catch (err) {
          toast.show({ variant: "error", title: pick === "download" ? "Source download failed" : "Install failed", message: err instanceof Error ? err.message : String(err), duration: 6000 })
          refreshMarket(svc, query)
        } finally {
          setInstalling(false)
        }
      } finally {
        actingRef.current = false
        setActing(false)
      }
    }
    void run().catch(err => toast.error(err))
  }, [dialog, state.rows, state.service, sel, acting, toast, refreshMarket, query, removeSelected, delistSelected])

  useKeyboard(key => {
    if (!props.focused || dialog.open()) return
    if (searching) {
      if (key.name === "escape" || key.name === "esc") { setSearching(false); return }
      if (key.name === "backspace") { setQuery(q => q.slice(0, -1)); setSel(0); return }
      const seq = typeof key.sequence === "string" ? key.sequence : ""
      const ch = key.raw && key.raw.length === 1 ? key.raw : seq.length === 1 ? seq : key.name.length === 1 && !key.ctrl && !key.meta ? key.name : ""
      if (ch >= " ") { setQuery(q => q + ch); setSel(0); return }
      return
    }
    const plain = !key.shift && !key.ctrl && !key.meta
    if (key.name === "tab") return setPane(p => p === "grid" ? "detail" : "grid")
    if (pane === "detail") {
      if (key.name === "escape" || (plain && key.name === "left")) { setPane("grid"); return }
      if (plain && key.name === "right") { cycle(1); return }
      if (keys.match("list.activate", key)) { primary(); return }
      if (keys.match("list.toggle", key)) { cycle(1); return }
      if (keys.match("list.search", key)) { setPane("grid"); setSearching(true); return }
      if (keys.match("list.refresh", key)) { loadMarket(query); return }
      return
    }
    const move = (by: number) => setSel(p => {
      const n = Math.max(0, Math.min(state.rows.length - 1, p + by))
      follow.opts.scrollTo?.(n)
      listFollow.opts.scrollTo?.(n)
      return n
    })
    if (plain && key.name === "left") { move(-1); return }
    if (plain && key.name === "right") { move(1); return }
    if (plain && key.name === "up") { move(-1); return }
    if (plain && key.name === "down") { move(1); return }
    if (handleListKey(keys, key, {
      count: state.rows.length, setSel, page: listFollow.opts.page,
      scrollTo: n => { follow.opts.scrollTo?.(n); listFollow.opts.scrollTo?.(n) },
      onActivate: primary,
      onToggle: () => cycle(1),
      onSearch: () => setSearching(true),
      onRefresh: () => loadMarket(query),
      onDelete: () => void removeSelected(),
    })) return
  })

  perf.count("market:render")
  const titles = state.rows.map(r => ({ key: r.entry.identityKey, name: r.entry.name, active: r.active }))
  const cards: EikonCard[] = state.rows.map(r => ({
    key: r.entry.identityKey,
    name: r.entry.name,
    active: r.active,
    author: r.entry.author,
    status: stateLabel(r, true),
    lines: posterLines(r.entry.poster),
  }))
  const listW = titleWidth(`Catalog (${state.rows.length})`, titles)
  const showGrid = dims.width - listW - DETAIL >= EIKON_CARD
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <box flexDirection="row" flexGrow={1} minWidth={0} minHeight={0}>
        <EikonTitleList title={`Catalog (${state.rows.length})${searching ? ` Search: ${query}` : ""}`}
          rows={titles} sel={sel} focus={props.focused && pane === "grid"} follow={listFollow} width={listW}
          onSel={setSel} onUse={primary} />
        {showGrid ? (
          <TabShell title="Posters" grow={1}>
            {state.error
              ? <box padding={1}><text fg={theme.error} wrapMode="word">Catalog unavailable: {state.error}</text></box>
              : loading && state.rows.length === 0
                ? <box padding={1}><text fg={theme.textMuted}>Loading shared eikons…</text></box>
                : <EikonCardGrid rows={cards} sel={sel} follow={follow}
                    empty={<text fg={theme.textMuted}>No catalog eikons match. Press / to change search.</text>}
                    onSel={setSel} onUse={primary} />}
          </TabShell>
        ) : null}
        <box width={DETAIL} flexShrink={0} minHeight={0}>
          <TabShell title={selected ? `Details — ${selected.entry.name}` : "Details"} focus={props.focused && pane === "detail"} grow={1}>
            <MarketplaceDetail row={selected} loading={loading} installing={installing} onUse={() => primary()}
              onFocus={() => setPane("detail")} onState={setPreviewState} preview={preview} />
          </TabShell>
        </box>
      </box>
      <HintBar pairs={[
        ["Tab", pane === "grid" ? "details" : "catalog"], [keys.print("list.activate"), "actions"],
        [pane === "detail" ? "→/Space" : "↑↓←→/Pg", pane === "detail" ? "state" : "select"],
        [keys.print("list.search"), searching ? "typing search" : "search"], [keys.print("list.refresh"), "reload"],
        ["d", "delete in modal"], ["Space", "preview"],
      ]} />
    </box>
  )
})

const posterLines = (poster?: string) => {
  const lines = poster ? poster.split("\n") : []
  return lines.length ? lines : ["(no poster)"]
}

const MarketplaceDetail = (props: {
  row?: MarketplaceRow
  loading: boolean
  installing: boolean
  onUse: () => void
  onFocus: () => void
  onState: (state: AvatarState) => void
  preview?: Preview
}) => {
  const theme = useTheme().theme
  const r = props.row
  if (!r) return <box padding={1}><text fg={theme.textMuted}>{props.loading ? "Loading shared eikons…" : "No catalog entry selected."}</text></box>
  const previewState = props.preview?.state ?? "idle"
  const states = props.preview?.states ?? [previewState]
  return (
    <box flexDirection="column" padding={1} onMouseDown={props.onFocus}>
      {props.preview ? (
        <box alignItems="center" justifyContent="center" width={48} height={24} flexShrink={0} overflow="hidden">
          <AnimatedAvatar key={`${r.entry.identityKey}:${props.preview.state}`} state={props.preview.state} eikon={props.preview.eikon} />
        </box>
      ) : null}
      <box height={1} overflow="hidden"><text fg={r.active ? theme.accent : theme.text} wrapMode="none"><strong>{r.active ? "● " : ""}{r.entry.name}</strong></text></box>
      <box height={1} overflow="hidden"><text fg={theme.textMuted} wrapMode="none">by {r.entry.author ?? "unknown"}</text></box>
      <box minHeight={1}><text fg={theme.text} wrapMode="word">{r.entry.description ?? "No description."}</text></box>
      <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
        {states.map((s, i) => (
          <FilterChip key={s} label={s} state={s === previewState ? "in" : "off"}
            gap={i === 0 ? 0 : 1} color={theme.primary} textColor={theme.textMuted}
            onMouseDown={() => props.onState(s)} />
        ))}
      </box>
      <DetailRow label="Status" value={stateLabel(r)} block />
      <DetailRow label="Trust" value={trustLabel(r)} block />
      <DetailRow label="Source" value={sourceText(r)} block />
      <DetailRow label="Compat" value={compatText(r)} />
      <DetailRow label="Digest" value={digest(r) ?? "unknown"} block />
    </box>
  )
}

const DetailRow = (props: { label: string; value: string; block?: boolean }) => {
  const theme = useTheme().theme
  if (props.block) return (
    <box flexDirection="column" minHeight={props.label === "Status" ? 2 : 1}>
      <text fg={theme.textMuted} wrapMode="word">{props.label}: {props.value}</text>
    </box>
  )
  return <box height={1} overflow="hidden"><text fg={theme.textMuted} wrapMode="none">{props.label}: {props.value}</text></box>
}

const shortDigest = (value?: string) => {
  if (!value) return undefined
  const [algo, hash] = value.includes(":") ? value.split(":", 2) : [undefined, value]
  if (!hash || hash.length <= 16) return value
  return algo ? `${algo}:${hash.slice(0, 12)}…` : `${hash.slice(0, 12)}…`
}

const digest = (row: MarketplaceRow) => {
  const t = row.entry.trust as { manifestDigest?: string; runtimeDigest?: string; digest?: string }
  return shortDigest(t.manifestDigest ?? t.runtimeDigest ?? t.digest)
}


const trustLabel = (row: MarketplaceRow) => {
  const t = row.trust === "mismatch" ? "Mismatch" : row.trust === "verified" ? "Verified" : row.trust === "unverified" ? "Unverified" : "Trust unknown"
  return row.reason && row.trust === "mismatch" ? `${t}: ${row.reason}` : t
}

const sourceText = (row: MarketplaceRow) => row.sourceIdentity ?? row.lifecycle.source.packageUrl ?? row.entry.sourceKey ?? row.entry.packageUrl

const compatText = (row: MarketplaceRow) => row.installState === "incompatible"
  ? `Blocked: ${row.reason ?? "requires newer Herm/eikon"}`
  : row.installState === "active-name-conflict" ? `Requires confirmation: ${row.reason}` : "Compatible"

const stateLabel = (row: MarketplaceRow, short = false) => {
  const base = row.installState === "active-name-conflict" ? "active name conflict" : row.active ? "active" : row.installed ? "installed" : "not installed"
  if (short) return base
  const src = row.sourcePresent ? " · source present" : row.sourceDownloadable ? " · source downloadable" : row.sourceAvailable ? " · source available" : ""
  const rm = row.removable ? " · removable" : row.installed ? " · not removable" : ""
  return `${base}${src}${rm}`
}
