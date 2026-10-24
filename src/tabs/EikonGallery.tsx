import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { useTheme } from "../theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { useKeys, handleListKey, useFollow } from "../keys"
import { EIKON_CARD, EikonCardGrid, EikonTitleList, type EikonCard } from "./eikon-panels"
import { openConfirm } from "../dialogs/confirm"
import { openEikonSubmit } from "../dialogs/eikon-submit"
import { openNewEikon } from "../dialogs/new-eikon"
import * as submitSvc from "../service/eikon-submit"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { AnimatedAvatar } from "../components/avatar/AnimatedAvatar"
import { listEikons, parseEikonFile, type ParsedEikon } from "../components/avatar/eikon"
import { BUNDLED_EIKON_DIR } from "../components/avatar/bundled"
import { hermesPath } from "../service/hermes-home"
import * as prefs from "../context/preferences"
import { eikon } from "../service/eikon"

type Row = {
  path: string; name: string; slug: string; author?: string; bundled: boolean
  w: number; h: number; url?: string; hasSource: boolean
  lifecycle?: eikon.LifecycleInfo
  manifest?: Record<string, unknown>
}

type Props = {
  focused: boolean
  onEdit?: (name: string) => void
  submit?: submitSvc.Submit
}

type Pane = "list" | "actions"
type Action = { key: string; label: string; run: () => void; danger?: boolean }
const PREVIEW = 54

export const EikonGallery = memo((props: Props) => {
  const theme = useTheme().theme
  const dialog = useDialog()
  const toast = useToast()
  const keys = useKeys()
  const rev = useSyncExternalStore(eikon.onRevision, eikon.revision)
  const dims = useTerminalDimensions()

  const rows = useMemo<Row[]>(() => {
    const user = hermesPath("eikons")
    const own = eikon.list()
    const map = new Map(own.map(x => [x.name.toLowerCase(), x]))
    const meta = own.map(x => ({ inst: x, ids: ids(x.manifest as Record<string, unknown> | undefined, x.name, x.sourceUrl) }))
    const rows = listEikons([BUNDLED_EIKON_DIR, user]).map(e => {
      const slug = e.path.startsWith(BUNDLED_EIKON_DIR)
        ? e.meta.name.toLowerCase()
        : dirname(e.path) === user ? basename(e.path, ".eikon") : basename(dirname(e.path))
      const man = manifest(dirname(e.path))
      const keys = ids(man, slug)
      const mine = meta.find(x => x.ids.some(k => keys.includes(k)))?.inst ?? map.get(slug)
      return {
        path: e.path, name: e.meta.name, slug, author: e.meta.author,
        bundled: e.path.startsWith(BUNDLED_EIKON_DIR),
        w: e.meta.width, h: e.meta.height,
        url: mine?.sourceUrl,
        hasSource: mine?.hasSource ?? !!eikon.findSource(slug),
        lifecycle: mine?.lifecycle,
        ...(man ? { manifest: man } : {}),
      }
    }).filter(r => !(r.bundled && r.lifecycle))
    return [...rows.reduce((map, row) => {
      const prev = map.get(row.slug)
      if (!prev || (dirname(prev.path) === user && dirname(row.path) !== user)) map.set(row.slug, row)
      return map
    }, new Map<string, Row>()).values()]
  }, [rev])

  const active = prefs.usePref("eikon")
  const path = useMemo(() => active ? eikon.baked(active) : undefined, [active, rev])
  const current = (row: Row) => path === row.path
  const [sel, setSel] = useState(0)
  const [pane, setPane] = useState<Pane>("list")
  const [act, setAct] = useState(0)
  const galleryFollow = useFollow("gal", i => rows[i]?.slug ?? i)
  const gridFollow = useFollow("lib-grid", i => rows[i]?.slug ?? i)

  useEffect(() => { if (sel >= rows.length) setSel(Math.max(0, rows.length - 1)) }, [rows.length, sel])

  const cur = rows[sel]
  const parsed = useMemo<ParsedEikon | undefined>(() => {
    if (!cur) return undefined
    return parseEikonFile(cur.path)
  }, [cur])

  const activate = (row = cur) => {
    if (!row) return
    if (row.bundled) prefs.set("eikon", row.slug)
    else eikon.useInstalled(row.slug)
    toast.show({ variant: "success", message: `Avatar → ${row.name}` })
  }

  const doNew = useCallback(async () => {
    const res = await openNewEikon(dialog, {})
    if (!res) return
    if (res.from === "blank") {
      eikon.ensure(res.name)
      return props.onEdit?.(res.name)
    }
    if (res.from === "file") {
      eikon.ensure(res.name)
      try { eikon.adopt(res.name, res.file, "base") }
      catch (e) { return toast.error(e instanceof Error ? e : new Error(String(e))) }
      return props.onEdit?.(res.name)
    }
    toast.show({ variant: "info", message: `Installing '${res.name}' from ${res.src}…` })
    await eikon.installPackage(res.src, { name: res.name })
      .then(out => {
        toast.show({ variant: "success", message: `Installed '${out.name}' (${out.n} files)` })
      })
      .catch(e => toast.error(e instanceof Error ? e : new Error(String(e))))
  }, [dialog, toast, props])

  const updateLocal = useCallback(async () => {
    if (!cur || cur.bundled) return
    try {
      const out = await eikon.update(cur.slug)
      if ("type" in out) {
        const ok = await openConfirm(dialog, {
          title: `Update active '${cur.name}'?`, danger: true,
          body: `${out.message} The active avatar's backing package will change even though the selected name stays '${cur.slug}'.`,
          yes: "update active", no: "cancel",
        })
        if (!ok) return
        const done = await eikon.update(cur.slug, { confirmActive: true })
        if ("type" in done) return toast.show({ variant: "warning", message: done.message })
      }
      toast.show({ variant: "success", message: `Updated ${cur.name}` })
    } catch (e) {
      toast.error(e instanceof Error ? e : new Error(String(e)))
    }
  }, [cur, dialog, toast])

  const submitLocal = useCallback(async () => {
    if (!cur || cur.bundled) return
    const path = submitSvc.submitPath(cur.slug)
    const pub = submitSvc.publishedInfo(path)
    if (pub) {
      toast.show({ variant: "warning", title: "Published eikon", message: "Create a local draft before submitting", duration: 6000 })
      return
    }
    await openEikonSubmit(dialog, {
      name: cur.name,
      path,
      submit: props.submit ?? submitSvc.submit,
    })
  }, [cur, dialog, props.submit, toast])

  const del = async () => {
    if (!cur || cur.bundled) return
    const here = current(cur)
    const base = dirname(cur.path) === hermesPath("eikons")
      ? `Removes legacy flat file ${basename(cur.path)}.`
      : `Removes ${dirname(cur.path)} and all its sources.`
    const body = here ? `${base} This is the active avatar; deleting it will clear the active avatar selection.` : base
    const ok = await openConfirm(dialog, {
      title: `Delete '${cur.name}'?`, danger: true,
      body,
    })
    if (!ok) return
    const removed = eikon.remove(cur.slug, { confirmActive: here })
    if (removed) return toast.show({ variant: "warning", message: removed.message })
    toast.show({ variant: "info", message: `Deleted ${cur.name}` })
  }

  const actions = useMemo<Action[]>(() => {
    if (!cur) return []
    return [
      { key: "Enter", label: current(cur) ? "Use as active avatar (active)" : "Use as active avatar", run: () => activate() },
      ...(props.onEdit ? [{ key: "e", label: "Edit in Studio", run: () => props.onEdit?.(cur.slug) } satisfies Action] : []),
      ...(!cur.bundled ? [
        { key: "u", label: "Update local package", run: () => void updateLocal() },
        { key: "s", label: "Share to catalog", run: () => void submitLocal() },
        { key: "d", label: "Delete local eikon", run: () => void del(), danger: true },
      ] satisfies Action[] : []),
    ]
  }, [cur, path, props.onEdit, updateLocal, submitLocal])

  useEffect(() => { if (act >= actions.length) setAct(Math.max(0, actions.length - 1)) }, [act, actions.length])

  const cards = useMemo<EikonCard[]>(() => rows.map(r => {
    const p = parseEikonFile(r.path)
    const lines = p?.resolve("state.idle")?.frames[0] ?? p?.states.get("idle")?.frames[0] ?? ["(no preview)"]
    return {
      key: r.path,
      name: r.name,
      active: current(r),
      author: r.author,
      status: current(r) ? "active" : r.bundled ? "bundled/system" : "installed",
      lines,
    }
  }), [rows, path])

  useKeyboard(key => {
    if (!props.focused || dialog.open()) return
    const plain = !key.shift && !key.ctrl && !key.meta
    if (key.name === "tab") return setPane(p => p === "list" ? "actions" : "list")
    if (pane === "actions") {
      if (key.name === "escape" || (plain && key.name === "left")) { setPane("list"); return }
      if (plain && key.name === "up") { setAct(i => Math.max(0, i - 1)); return }
      if (plain && key.name === "down") { setAct(i => Math.min(actions.length - 1, i + 1)); return }
      if (keys.match("list.activate", key) || keys.match("list.toggle", key)) { actions[act]?.run(); return }
      return
    }
    if (handleListKey(keys, key, {
      count: rows.length,
      setSel,
      page: galleryFollow.opts.page,
      scrollTo: n => galleryFollow.ref.current?.scrollChildIntoView(galleryFollow.id(n)),
      onActivate: () => activate(),
      onDelete: () => void del(),
      onNew: doNew,
      onRefresh: () => { eikon.notifyRevision(); toast.show({ variant: "info", message: "Reloaded", duration: 1000 }) },
    })) return
    if (key.name === "u" && cur && !cur.bundled) return void updateLocal()
    if (key.name === "s" && cur && !cur.bundled) return void submitLocal()
    if (key.name === "e" && cur && props.onEdit) props.onEdit(cur.slug)
  })

  const listW = Math.max(
    "Library (000)".length,
    ...rows.map(r => r.name.length + 4),
  ) + 7
  const showGrid = dims.width - listW - PREVIEW >= EIKON_CARD

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <EikonTitleList title={`Library (${rows.length})`} rows={rows.map(r => ({ key: r.path, name: r.name, active: current(r) }))}
          sel={sel} focus={props.focused && pane === "list"} follow={galleryFollow} width={listW}
          onSel={setSel} onUse={i => activate(rows[i])} />
        {showGrid ? (
          <TabShell title="Grid" grow={1}>
            <EikonCardGrid rows={cards} sel={sel} follow={gridFollow} onSel={setSel} onUse={i => activate(rows[i])} />
          </TabShell>
        ) : null}
        <box width={PREVIEW} flexShrink={0} minHeight={0}>
          <TabShell title={cur ? `Preview — ${cur.name}` : "Preview"} grow={1}>
            <box flexDirection="column" flexGrow={1} padding={1} alignItems="center">
              <box alignItems="center" justifyContent="center" width={48} height={24} flexShrink={0} overflow="hidden">
                {parsed
                  ? <AnimatedAvatar key={cur!.path} state="idle" eikon={parsed} />
                  : <text fg={theme.textMuted}>No preview.</text>}
              </box>
              {cur ? (
                <box flexDirection="column" width={48}>
                  <text fg={theme.text}><strong>{cur.name}</strong></text>
                  <text fg={theme.textMuted}>Author: {cur.author ?? "—"}</text>
                  <text fg={theme.textMuted}>Status: {current(cur) ? "active" : cur.bundled ? "bundled/system" : "installed"}</text>
                  <text fg={theme.textMuted} wrapMode="word">Source: {gallerySource(cur)}</text>
                  <text fg={theme.textMuted} wrapMode="word">Trust: {galleryTrust(cur)}</text>
                  <text fg={theme.textMuted} wrapMode="word">Package: {packageId(cur)}</text>
                  <text fg={theme.textMuted}>{sourceBadge(cur)}</text>
                  <box height={1} />
                  <text fg={theme.primary}><strong>Actions</strong></text>
                  {actions.map((a, i) => (
                    <box key={a.label} height={1} overflow="hidden" paddingRight={1}
                         backgroundColor={pane === "actions" && i === act ? theme.backgroundElement : undefined}
                         onMouseDown={() => { setPane("actions"); setAct(i); a.run() }}>
                      <text fg={a.danger ? theme.error : theme.text} wrapMode="none">{pane === "actions" && i === act ? "▸ " : "  "}{a.label} [{a.key}]</text>
                    </box>
                  ))}
                </box>
              ) : null}
            </box>
          </TabShell>
        </box>
      </box>
      <HintBar pairs={[
        ["Tab", pane === "list" ? "actions" : "library"],
        [keys.print("list.activate"), pane === "actions" ? "run action" : "use"], ["↑↓", pane === "actions" ? "action" : "select"],
        [keys.print("list.new"), "new / install"], [keys.print("list.refresh"), "reload"],
        ...(cur && props.onEdit ? [["e", "edit in Studio"] as const] : []),
      ]} />
    </box>
  )
})

const galleryTrust = (row: Row) => {
  const t = row.lifecycle?.trust
  if (t === "verified") return "Verified"
  if (t === "mismatch") return "Mismatch"
  if (t === "unverified") return "Unverified"
  return row.bundled ? "Bundled" : "Legacy local"
}

const gallerySource = (row: Row) => {
  const src = row.lifecycle?.source
  if (src) return src.identity ?? src.repo ?? src.origin ?? src.kind
  if (row.bundled) return "bundled/system"
  return "local"
}

const packageId = (row: Row) => typeof row.manifest?.id === "string" ? row.manifest.id : row.bundled ? "bundled/system" : "—"

const manifest = (dir: string) => {
  const file = join(dir, "manifest.json")
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  } catch (err) {
    if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) throw err
    return undefined
  }
}

const sourceBadge = (row: Row) => row.hasSource ? "● source" : row.url || row.bundled ? "○ source available" : "— no source"

const key = (value: string) => {
  const url = URL.parse(value)
  if (url && (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:")) return url.href.replace(/\/?$/, "/").toLowerCase()
  return value.toLowerCase()
}

const ids = (man?: Record<string, unknown>, name?: string, url?: string) => {
  const origin = man?.origin && typeof man.origin === "object" && !Array.isArray(man.origin)
    ? man.origin as Record<string, unknown> : undefined
  return [...new Set([
    typeof man?.id === "string" ? man.id : undefined,
    typeof origin?.sourceKey === "string" ? origin.sourceKey : undefined,
    typeof origin?.identityKey === "string" ? origin.identityKey : undefined,
    typeof origin?.packageUrl === "string" ? origin.packageUrl : undefined,
    typeof origin?.source === "string" ? origin.source : undefined,
    url,
    name,
  ].filter((x): x is string => !!x).map(key))]
}
