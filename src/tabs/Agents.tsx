import { useState, useEffect, useCallback, useRef, memo } from "react"
import { VBAR } from "../ui/table"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useKeys, handleListKey, useFollow } from "../keys"
import { useGateway, useGatewayEvent } from "../context/gateway"
import { trail } from "../app/spawnHistory"
import { useTheme } from "../theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useCommand } from "../ui/command"
import { openConfirm } from "../dialogs/confirm"
import { openSpawnHistory } from "../dialogs/spawn-history"
import { openProfileMenu } from "../dialogs/profile"
import { openCreateProfile } from "../dialogs/new-profile"
import { openInstallDistribution } from "../dialogs/install-distribution"
import { TabShell } from "../ui/shell"
import { HintBar } from "../ui/hint"
import { Spinner } from "../ui/spinner"
import { KV, KVBlock } from "../ui/kv"
import { KVLink } from "../components/ui/FileLink"
import { dur, trunc, fmt, ago } from "../ui/fmt"
import {
  listProfiles, stickyDefault, profileStats,
  type ProfileInfo, type ProfileStats, type DistributionManifest,
} from "../service/hermes-profiles"
import type { Source } from "../service/hermes-home"
import type { DelegationStatus, DelegationRecord } from "../context/wire"
import { tree as buildTree, totals as treeTotals, summary, spark, heat, peak, type Agg } from "../service/subagent-tree"

// Two panes:
//   Profiles (left)   — filesystem scan of `<root>/profiles/`. Each
//     profile is an isolated HERMES_HOME (config, env, memory, skills).
//     `s` / menu→Switch rehomes herm + respawns the gateway subprocess
//     under that HERMES_HOME (see home/rehome.ts). The current session
//     ends — it belongs to the outgoing profile's state.db — so the
//     switch is gated behind a confirm. All other mutations route
//     through `shell.exec → hermes profile <verb>` so the authoritative
//     CLI owns validation, skill seeding, aliases and gateway cleanup.
//   Delegation (right) — live subagent tree via `delegation.status`
//     (tools/delegate_tool registry). `p` toggles spawn-pause
//     (`delegation.pause`), `k` interrupts the selected child
//     (`subagent.interrupt`).

const ProfileRow = memo((props: {
  id: string
  p: ProfileInfo; idx: number; selected: boolean
  onHover: (i: number) => void; onEnter: (i: number) => void; onDelete: (i: number) => void
}) => {
  const theme = useTheme().theme
  const { p, idx: i } = props
  const [x, setX] = useState(false)
  return (
    <box id={props.id} flexDirection="row" height={1}
         backgroundColor={props.selected ? theme.backgroundElement : undefined}
         onMouseOver={() => props.onHover(i)}
         onMouseDown={() => props.onEnter(i)}>
      <box width={2}><text fg={props.selected ? theme.primary : theme.text}>
        {props.selected ? "▸ " : "  "}
      </text></box>
      <box flexGrow={1} minWidth={8} height={1} overflow="hidden">
        <text>
          <span fg={p.is_active ? theme.accent : theme.text}>
            {p.is_active ? <strong>{p.name}</strong> : p.name}
          </span>
          {p.is_sticky ? <span fg={theme.warning}>{" ★"}</span> : null}
          {p.distribution ? <span fg={theme.info}>{" ⬢"}</span> : null}
          {p.gateway_running ? <span fg={theme.success}>{" ●"}</span> : null}
        </text>
      </box>
      <box width={4} height={1}>
        <text fg={theme.textMuted}>{p.is_active ? " you" : ""}</text>
      </box>
      {p.is_default || p.is_active ? <box width={3} /> : (
        <box width={3}
             onMouseDown={(e) => { e.stopPropagation(); props.onDelete(i) }}
             onMouseOver={() => setX(true)} onMouseOut={() => setX(false)}>
          <text fg={x ? theme.error : theme.textMuted}>{" ✕"}</text>
        </box>
      )}
    </box>
  )
})

// Distribution panel for ProfileDetail. Rendered only when the profile
// has a distribution.yaml (installed via `hermes profile install`).
// `source` in the manifest is the upstream git URL / path it was pulled
// from — the clickable link targets that, not the local yaml, so users
// can visit the distribution's origin in one click. Falls back to the
// local yaml when the manifest has no recorded source.
const DistBlock = memo((props: { d: DistributionManifest; yaml: Source }) => {
  const theme = useTheme().theme
  const d = props.d
  const req = d.env_requires.filter(e => e.required).length
  const opt = d.env_requires.length - req
  const link: Source = d.source
    ? { file: d.source, relative: d.source, label: d.source }
    : props.yaml
  const when = d.installed_at ? Date.parse(d.installed_at) : NaN
  return (
    <>
      <box height={1} />
      <box height={1}><text fg={theme.info}><strong>Distribution</strong></text></box>
      <KVBlock rows={[
        ["Name", d.name],
        ["Version", `v${d.version}`],
        ["Requires", d.hermes_requires ? `Hermes ${d.hermes_requires}` : undefined],
      ]} />
      <KVLink label="Source" source={link} text={d.source || props.yaml.label} />
      <KVBlock rows={[
        ["Installed at", Number.isFinite(when) ? ago(when / 1000) : undefined],
        ["Env vars", d.env_requires.length ? `${req} required, ${opt} optional` : undefined],
      ]} />
    </>
  )
})

const ProfileDetail = memo((props: { p: ProfileInfo; stats?: ProfileStats }) => {
  const { theme, syntaxStyle } = useTheme()
  const p = props.p
  const s = props.stats
  return (
    <scrollbox scrollY flexGrow={1}>
      <box flexDirection="column" width="100%">
        <box height={1}>
          <text fg={theme.accent}>
            <strong>{p.name}</strong>
            {p.is_sticky ? <span fg={theme.warning}>{"  ★ sticky default"}</span> : null}
          </text>
        </box>
        <box height={1} />
        <KVLink label="Path" source={p.sources.dir} text={p.sources.dir.relative} />
        <KV label="Active" value={p.is_active ? "yes (this session)" : "no"}
            fg={p.is_active ? theme.accent : theme.textMuted} />
        <KV label="Model" value={p.model ?? "—"} />
        <KV label="Provider" value={p.provider ?? "—"} />
        <KV label="Skills" value={String(p.skill_count)} />
        <KV label="Sessions" value={s ? s.sessions == null ? "—" : `${fmt(s.sessions)}  (${fmt(s.messages ?? 0)} msgs)` : "…"} />
        <KV label="Cron jobs" value={s ? s.crons == null ? "—" : String(s.crons) : "…"} />
        <KV label="Theme" value={s ? s.prefs?.theme ?? "—" : "…"} />
        <KV label="Avatar" value={s ? s.prefs?.eikon ?? "—" : "…"} />
        {s?.prefs?.keys ? <KV label="Keybinds" value={`${s.prefs.keys} overrides`} /> : null}
        <KV label="Gateway" value={p.gateway_running ? "running" : "stopped"}
            fg={p.gateway_running ? theme.success : theme.textMuted} />
        {p.has_alias ? <KV label="Alias" value={`${p.name} (shell)`} /> : null}
        {p.distribution ? <DistBlock d={p.distribution} yaml={p.sources.distribution} /> : null}
        <box height={1} />
        <KVLink label="Config" source={p.sources.config} />
        <KVLink label="Soul" source={p.sources.soul} />
        {p.has_env ? <KVLink label="Env" source={p.sources.env} /> : <KV label="Env" value="—" />}
        {p.soul_preview ? <>
          <box height={1} />
          <box height={1}><text fg={theme.textMuted}>SOUL.md</text></box>
          <markdown content={p.soul_preview} fg={theme.markdownText} syntaxStyle={syntaxStyle} />
        </> : null}
      </box>
    </scrollbox>
  )
})

const HOT = ["⠀", "⠁", "⠃", "⠇", "⠏", "⠟", "⠿", "⡿", "⣿"] as const

const DelegRow = memo((props: {
  id: string
  r: DelegationRecord; idx: number; selected: boolean; now: number; hot: number
  onHover: (i: number) => void; onKill: (i: number) => void
}) => {
  const theme = useTheme().theme
  const { r, idx: i, now } = props
  const [x, setX] = useState(false)
  const up = r.started_at ? dur(now - r.started_at) : "—"
  const hotFg = [theme.textMuted, theme.textMuted, theme.text,
    theme.info, theme.info, theme.accent, theme.accent,
    theme.warning, theme.error][props.hot] ?? theme.textMuted
  return (
    <box id={props.id} flexDirection="row" height={1}
         backgroundColor={props.selected ? theme.backgroundElement : undefined}
         onMouseOver={() => props.onHover(i)}>
      <box width={2}><text fg={props.selected ? theme.primary : theme.text}>
        {props.selected ? "▸ " : "  "}
      </text></box>
      <box width={2}><text fg={hotFg}>{HOT[props.hot]} </text></box>
      <box flexGrow={1} minWidth={8} height={1} overflow="hidden">
        <text>
          <span fg={theme.textMuted}>{"· ".repeat(r.depth)}</span>
          <span fg={theme.text}>{r.goal.replace(/\s+/g, " ")}</span>
        </text>
      </box>
      <box width={14} height={1} overflow="hidden">
        <text fg={theme.textMuted}>{trunc(r.model ?? "", 13)}</text>
      </box>
      <box width={5} height={1} flexDirection="row" justifyContent="flex-end">
        <text fg={theme.textMuted}>{String(r.tool_count ?? 0)}</text>
      </box>
      <box width={8} height={1} flexDirection="row" justifyContent="flex-end">
        <text fg={theme.textMuted}>{up}</text>
      </box>
      <box width={3}
           onMouseDown={(e) => { e.stopPropagation(); props.onKill(i) }}
           onMouseOver={() => setX(true)} onMouseOut={() => setX(false)}>
        <text fg={x ? theme.error : theme.textMuted}>{" ✕"}</text>
      </box>
    </box>
  )
})

// Sort the flat registry into a parent-before-child pre-order so depth
// dots draw a coherent tree. Orphans (parent already finished) go last.
function preorder(recs: DelegationRecord[]): DelegationRecord[] {
  const byParent = new Map<string | null, DelegationRecord[]>()
  for (const r of recs) {
    const k = r.parent_id ?? null
    ;(byParent.get(k) ?? byParent.set(k, []).get(k)!).push(r)
  }
  const out: DelegationRecord[] = []
  const seen = new Set<string>()
  const walk = (k: string | null) => {
    for (const r of byParent.get(k) ?? []) {
      if (seen.has(r.subagent_id)) continue
      seen.add(r.subagent_id)
      out.push(r)
      walk(r.subagent_id)
    }
  }
  walk(null)
  for (const r of recs) if (!seen.has(r.subagent_id)) out.push(r)
  return out
}

// Live per-subagent enrichment on top of the polled registry snapshot.
// Fed by subagent.* push events; `tool_count` here is authoritative
// between polls (the registry value lags).
type Live = {
  tool_count: number
  last_tool?: string
  last_preview?: string
  thinking?: string
  status?: string
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
}

const DelegDetail = memo((props: { r: DelegationRecord; live?: Live; agg?: Agg; now: number }) => {
  const theme = useTheme().theme
  const { r, live, agg, now } = props
  const tc = live?.tool_count ?? r.tool_count ?? 0
  const tr = trail(r.subagent_id)
  return (
    <scrollbox scrollY flexGrow={1}>
      <box flexDirection="column" width="100%">
        <box minHeight={1}><text fg={theme.accent} wrapMode="word"><strong>{r.goal}</strong></text></box>
        {agg && agg.agents > 1 ? (
          <box height={1}><text fg={theme.textMuted}>{summary(agg)}</text></box>
        ) : null}
        <box height={1} />
        <KVBlock rows={[
          ["Status",   live?.status ?? r.status ?? "running"],
          ["Model",    r.model ?? "—"],
          ["Depth",    String(r.depth)],
          ["Parent",   r.parent_id ?? "(root)"],
          ["Uptime",   r.started_at ? dur(now - r.started_at) : "—"],
          ["Tools",    String(tc)],
          ["Tokens",   live ? `${fmt(live.input_tokens ?? 0)} in / ${fmt(live.output_tokens ?? 0)} out` : undefined],
          ["Cost",     live?.cost_usd != null ? `$${live.cost_usd.toFixed(4)}` : undefined],
        ]} />
        {live?.thinking ? <>
          <box height={1} />
          <box height={1}><text fg={theme.textMuted}>thinking</text></box>
          <box minHeight={1}><text fg={theme.textMuted} wrapMode="word">{trunc(live.thinking, 200)}</text></box>
        </> : null}
        {tr.length > 0 ? <>
          <box height={1} />
          <box height={1}><text fg={theme.textMuted}>recent tools</text></box>
          {tr.slice(-8).map((t, i) => (
            <box key={i} height={1} overflow="hidden">
              <text>
                <span fg={theme.textMuted}>{"┃ "}</span>
                <span fg={theme.text}>{t.name.padEnd(14)}</span>
                <span fg={theme.textMuted}>{t.preview ? trunc(t.preview.replace(/\s+/g, " "), 40) : ""}</span>
              </text>
            </box>
          ))}
        </> : null}
      </box>
    </scrollbox>
  )
})

type ShellResult = { stdout: string; stderr: string; code: number }
type Pane = "profiles" | "deleg"
type View = "list" | "detail"
type Props = {
  focused?: boolean
  sessionId: string
  onSwitchProfile?: (home: string, name: string) => void
}

export const Agents = memo((props: Props) => {
  const theme = useTheme().theme
  const gw = useGateway()
  const dialog = useDialog()
  const toast = useToast()
  const cmd = useCommand()

  const [pane, setPane] = useState<Pane>("profiles")
  // Profiles-pane list↔detail swap for narrow terminals — in wide
  // layouts both render side-by-side and this is ignored.
  const [pView, setPView] = useState<View>("list")
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [deleg, setDeleg] = useState<DelegationStatus | null>(null)
  const [liveMap, setLiveMap] = useState<ReadonlyMap<string, Live>>(() => new Map())
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [pSel, setPSel] = useState(0)
  const [dSel, setDSel] = useState(0)
  const [err, setErr] = useState("")
  const [delegErr, setDelegErr] = useState("")
  const delegGen = useRef(0)

  const active = preorder(deleg?.active ?? [])
  // Aggregates: rebuild the tree from the same snapshot + live
  // enrichment. O(n) per poll (n≤max_concurrent×depth, tiny).
  const nodes = buildTree(deleg?.active ?? [], liveMap, now)
  const all = treeTotals(nodes)
  const hotPeak = peak(nodes)
  // Flat lookup: subagent_id → subtree aggregate, for the selected
  // row's detail pane and per-row hotness colouring.
  const aggOf = new Map<string, Agg>()
  {
    const walk = (ns: typeof nodes) => {
      for (const n of ns) { aggOf.set(n.rec.subagent_id, n.agg); walk(n.kids) }
    }
    walk(nodes)
  }
  const live = useRef({ profiles, active })
  live.current = { profiles, active }

  // Gateway's own HERMES_HOME (may differ from herm's process env).
  // Fetched once on mount; listProfiles() derives is_active from it.
  const gwHome = useRef<string | undefined>(undefined)
  // Lazy per-profile stats (session/msg/cron counts) — fetched when a
  // profile is first selected, cached by path, cleared on `r`.
  const [stats, setStats] = useState<ReadonlyMap<string, ProfileStats>>(() => new Map())
  const [sticky, setSticky] = useState(stickyDefault)

  const loadProfiles = useCallback(() => {
    setStats(new Map())
    setSticky(stickyDefault())
    listProfiles(gwHome.current)
      .then(ps => { setProfiles(ps); setErr("") })
      .catch((e: Error) => setErr(`profiles: ${e.message}`))
  }, [])

  useEffect(() => {
    gw.request<{ home?: string }>("config.get", { key: "profile" })
      .then(r => { gwHome.current = r.home })
      .catch(() => {})
      .finally(loadProfiles)
  }, [gw, loadProfiles])

  const loadDeleg = useCallback(() => {
    const current = ++delegGen.current
    gw.request<DelegationStatus>("delegation.status")
      .then(r => {
        if (delegGen.current !== current) return
        setDeleg(r)
        setNow(Date.now() / 1000)
        setDelegErr("")
      })
      .catch(e => {
        if (delegGen.current === current) setDelegErr(e instanceof Error ? e.message : String(e))
      })
  }, [gw])

  useEffect(loadDeleg, [loadDeleg])
  useEffect(() => () => { delegGen.current++ }, [])

  // Poll delegation while focused + agents are live; back off when idle.
  useEffect(() => {
    if (!props.focused) return
    const ms = (deleg?.active.length ?? 0) > 0 ? 1500 : 5000
    const t = setInterval(loadDeleg, ms)
    return () => clearInterval(t)
  }, [props.focused, deleg?.active.length, loadDeleg])

  // Push enrichment: subagent.* events arrive regardless of focus; we
  // fold them into a per-id map so rows/detail show fresh tool counts
  // and the last tool/preview between registry polls. start/complete
  // also trigger an immediate registry refresh so the list is instant.
  useGatewayEvent(ev => {
    if (!ev.type.startsWith("subagent.")) return
    const p = ev.payload as { subagent_id?: string; tool_name?: string; tool_preview?: string;
      text?: string; status?: string; input_tokens?: number; output_tokens?: number; cost_usd?: number }
    const id = p.subagent_id
    if (!id) return
    setLiveMap(prev => {
      const next = new Map(prev)
      const cur = next.get(id) ?? { tool_count: 0 }
      switch (ev.type) {
        case "subagent.start":
          next.set(id, { tool_count: 0 }); break
        case "subagent.tool":
          next.set(id, { ...cur, tool_count: cur.tool_count + 1,
            last_tool: p.tool_name, last_preview: p.tool_preview }); break
        case "subagent.thinking":
          next.set(id, { ...cur, thinking: p.text }); break
        case "subagent.complete":
          next.set(id, { ...cur, status: p.status,
            input_tokens: p.input_tokens, output_tokens: p.output_tokens, cost_usd: p.cost_usd }); break
      }
      return next
    })
    if (ev.type === "subagent.start" || ev.type === "subagent.complete") loadDeleg()
  })

  // Thin wrapper for `hermes profile <verb>` — all profile mutations go
  // through the CLI so validation/skill-seeding/alias/cleanup stay
  // upstream-owned. Returns stdout on success, throws on non-zero.
  const sh = useCallback((cmd: string) =>
    gw.request<ShellResult>("shell.exec", { command: cmd }).then(r => {
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "exit " + r.code).trim())
      return r.stdout
    }), [gw])
  const pHover = useCallback((i: number) => setPSel(i), [])
  const dHover = useCallback((i: number) => setDSel(i), [])

  const pDelete = useCallback(async (i: number) => {
    const p = live.current.profiles[i]
    if (!p || p.is_default || p.is_active) return
    // `hermes profile delete` stops that profile's gateway first
    // (SIGTERM + up to 10s wait). shell.exec is capped at 30s —
    // usually fine, but warn so a rare timeout isn't mysterious.
    const warn = p.gateway_running
      ? "\n\nIts gateway is running and will be stopped first (may take up to ~10s)."
      : ""
    const ok = await openConfirm(dialog, {
      title: "Delete Profile?",
      body: `'${p.name}' — config, env, memory, skills, and sessions will be removed. This cannot be undone.${warn}`,
      yes: "delete", danger: true,
    })
    if (!ok) return
    sh(`hermes profile delete ${p.name} -y`)
      .then(() => {
        toast.show({ variant: "success", message: `Deleted '${p.name}'` })
        loadProfiles()
      })
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [sh, dialog, toast, loadProfiles])

  const pSwitch = useCallback(async (i: number) => {
    const p = live.current.profiles[i]
    if (!p || p.is_active || !props.onSwitchProfile) return
    const ok = await openConfirm(dialog, {
      title: `Switch to '${p.name}'?`,
      body: "The gateway restarts under this profile's HERMES_HOME. "
          + "The current session ends (it stays in the outgoing profile's history).",
      yes: "switch",
    })
    if (ok) props.onSwitchProfile(p.path, p.name)
  }, [dialog, props.onSwitchProfile])

  // `hermes profile update` re-pulls distribution-owned files from the
  // source in `distribution.yaml`. `--force-config` additionally
  // overwrites config.yaml. When the active profile is updated, the
  // gateway stops mid-command; follow with the same rehome path as
  // Switch so herm re-attaches under the refreshed profile.
  const pUpdate = useCallback(async (p: ProfileInfo, force: boolean) => {
    const cmd = `hermes profile update ${p.name} -y${force ? " --force-config" : ""}`
    toast.show({ variant: "info", message: `Updating '${p.name}'…` })
    try {
      await sh(cmd)
      toast.show({ variant: "success", message: `Updated '${p.name}'` })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      if (!p.is_active || !props.onSwitchProfile
          || !/gateway (?:exited|restarted)/i.test(error.message)) {
        toast.show({ variant: "error", message: error.message })
        return
      }
    }
    if (p.is_active && props.onSwitchProfile) {
      props.onSwitchProfile(p.path, p.name)
      return
    }
    loadProfiles()
  }, [sh, toast, loadProfiles, props.onSwitchProfile])

  const pEnter = useCallback((i: number) => {
    setPSel(i)
    const p = live.current.profiles[i]
    if (!p) return
    openProfileMenu(dialog, p, {
      switch: props.onSwitchProfile ? () => pSwitch(i) : undefined,
      sticky: (pp) => sh(`hermes profile use ${pp.name}`)
        .then(() => { toast.show({ variant: "success", message: `Sticky default → '${pp.name}'` }); loadProfiles() })
        .catch((e: Error) => toast.show({ variant: "error", message: e.message })),
      unsticky: () => sh("hermes profile use --clear")
        .then(() => { toast.show({ variant: "info", message: "Cleared sticky default" }); loadProfiles() })
        .catch((e: Error) => toast.show({ variant: "error", message: e.message })),
      export: (pp) => sh(`hermes profile export ${pp.name}`)
        .then(out => toast.show({ variant: "success", message: trunc(out.trim() || `Exported '${pp.name}'`, 80) }))
        .catch((e: Error) => toast.show({ variant: "error", message: e.message })),
      remove: () => pDelete(i),
      update: (pp, force) => pUpdate(pp, force),
    })
  }, [sh, dialog, toast, loadProfiles, pDelete, pSwitch, pUpdate, props.onSwitchProfile])

  const dKill = useCallback(async (i: number) => {
    const r = live.current.active[i]
    if (!r) return
    const ok = await openConfirm(dialog, {
      title: "Interrupt subagent?",
      body: `${trunc(r.goal, 120)}\n\nThe child returns whatever partial result it has so far.`,
      yes: "interrupt", danger: true,
    })
    if (!ok) return
    gw.request<{ found: boolean }>("subagent.interrupt", { subagent_id: r.subagent_id })
      .then(res => {
        toast.show(res.found
          ? { variant: "success", message: `Interrupted ${r.subagent_id}` }
          : { variant: "info", message: "Already finished" })
        loadDeleg()
      })
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [gw, dialog, toast, loadDeleg])

  const create = useCallback(() => {
    openCreateProfile(dialog, { existing: live.current.profiles.map(p => p.name) })
      .then(r => {
        if (!r) return
        const flags = [
          r.cloneFrom ? `--clone --clone-from ${r.cloneFrom}` : "",
          r.alias ? "" : "--no-alias",
        ].filter(Boolean).join(" ")
        toast.show({ variant: "info", message: `Creating '${r.name}'…` })
        return sh(`hermes profile create ${r.name} ${flags}`.trim())
          .then(() => {
            toast.show({ variant: "success", message: `Created '${r.name}'` })
            loadProfiles()
          })
      })
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [sh, dialog, toast, loadProfiles])

  // Install a distribution. The dialog runs its own preview-clone and
  // shows the real manifest before we commit; the install shellout
  // passes the ORIGINAL source (URL/path user entered) so the on-disk
  // distribution.yaml's `source:` records the remote for future updates.
  const install = useCallback(() => {
    openInstallDistribution(dialog, gw)
      .then(r => {
        if (!r) return
        const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
        const flags = [
          r.name ? `--name ${shq(r.name)}` : "",
          r.alias ? "--alias" : "",
        ].filter(Boolean).join(" ")
        toast.show({ variant: "info", message: `Installing '${r.manifest.name}'…` })
        return sh(`hermes profile install ${shq(r.source)} -y ${flags}`.trim())
          .then(() => {
            const installed = r.name || r.manifest.name
            toast.show({ variant: "success", message: `Installed '${installed}'` })
            loadProfiles()
            const reqs = r.manifest.env_requires.filter(e => e.required).map(e => e.name)
            if (reqs.length > 0) {
              toast.show({
                variant: "warning",
                title: "Env vars needed",
                message: `${reqs.join(", ")} — add to the profile's .env before using it`,
                duration: 6000,
              })
            }
          })
      })
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [gw, sh, dialog, toast, loadProfiles])

  const selected = profiles[pSel]
  const statGen = useRef(0)

  useEffect(() => {
    const path = selected?.path
    if (!path || stats.has(path)) return
    const g = ++statGen.current
    void profileStats(path).then(s => {
      if (statGen.current !== g) return
      setStats(prev => new Map(prev).set(path, s))
    })
  }, [selected?.path, stats])

  const dims = useTerminalDimensions()
  const wide = dims.width >= 130
  const pWide = dims.width >= 170 || (!wide && dims.width >= 90)
  const pFollow = useFollow("prof")
  const dFollow = useFollow("deleg")

  const keys = useKeys()
  useKeyboard((key) => {
    if (!props.focused || dialog.open()) return
    if (key.name === "tab") return setPane(p => p === "profiles" ? "deleg" : "profiles")
    if (keys.match("list.refresh", key)) { loadProfiles(); loadDeleg(); toast.show({ variant: "info", message: "Reloaded", duration: 1000 }); return }
    if (pane === "profiles") {
      if (key.name === "escape" && !pWide && pView === "detail") return setPView("list")
      if (key.name === "s") return void pSwitch(pSel)
      if (keys.match("agents.install", key)) return install()
      handleListKey(keys, key, {
        count: profiles.length, setSel: setPSel, ...pFollow.opts,
        onNew: create,
        onDelete: () => pDelete(pSel),
        onActivate: () => {
          if (!pWide && pView === "list") return setPView("detail")
          pEnter(pSel)
        },
      })
      return
    }
    const matched = handleListKey(keys, key, {
      count: active.length, setSel: setDSel, ...dFollow.opts,
      onDelete: () => dKill(dSel),
    })
    if (matched) return
    if (keys.match("agents.kill", key)) return dKill(dSel)
    if (keys.match("agents.history", key)) return openSpawnHistory(dialog, gw, props.sessionId)
  })

  const showProfiles = wide || pane === "profiles"
  const showDeleg = wide || pane === "deleg"
  const showList = pWide || pView === "list"
  const showDetail = pWide || pView === "detail"

  const limits = deleg
    ? `depth≤${deleg.max_spawn_depth} · conc≤${deleg.max_concurrent_children}` : ""
  const dHint = active.length > 0
    ? `${spark(nodes)}  ${summary(all)}`
    : limits

  const togglePause = useCallback(() => {
    const next = !deleg?.paused
    gw.request<{ paused: boolean }>("delegation.pause", { paused: next })
      .then(r => {
        setDeleg(d => d ? { ...d, paused: r.paused } : d)
        toast.show({ variant: "info", message: r.paused ? "Delegation paused" : "Delegation resumed" })
      })
      .catch((e: Error) => toast.show({ variant: "error", message: e.message }))
  }, [gw, toast, deleg?.paused])

  useEffect(() => cmd.register([
    { title: deleg?.paused ? "Resume Delegation" : "Pause Delegation", value: "deleg.pause",
      category: "Agents", onSelect: togglePause },
    // No action: — 'i' is tab-local to Agents (handled in useKeyboard below)
    // so firing install from the palette doesn't conflict with other tabs
    // that may want 'i' for their own verbs.
    { title: "Install Distribution…", value: "profile.install",
      category: "Agents", description: "from git URL or local directory", onSelect: install },
  ]), [cmd, togglePause, deleg?.paused, install])

  const pair = (k: string, v: string) => `[${k}] ${v}`
  const join = (...parts: string[]) => parts.filter(Boolean).join("  ")
  const sw = props.onSwitchProfile ? pair("s", "switch") : ""
  const pHint = pWide
    ? join("[↑↓] nav", pair(keys.print("list.activate"), "actions"), sw,
           pair(keys.print("list.new"), "new"),
           pair(keys.print("agents.install"), "install"),
           pair(keys.print("list.delete"), "delete"),
           pair(keys.print("list.refresh"), "refresh"))
    : pView === "list"
      ? join("[↑↓] nav", pair(keys.print("list.activate"), "detail"), sw,
             pair(keys.print("list.new"), "new"),
             pair(keys.print("list.delete"), "delete"))
      : join(pair(keys.print("list.activate"), "actions"), sw, "[Esc] back",
             pair(keys.print("list.delete"), "delete"))

  const profilesHint = `${pHint}  ${pair("Tab", wide ? "→ delegation" : "↔ delegation")}`
  const delegKeys = join(
    "[↑↓] nav",
    pair(keys.print("agents.kill"), "interrupt"),
    pair(keys.print("agents.history"), "history"),
    pair(keys.print("list.refresh"), "refresh"),
  )
  const delegHint = dHint ? `${delegKeys}  ·  ${dHint}` : delegKeys
  // Wide: both panes visible, footer joins hints by focused pane order.
  // Narrow: only one pane rendered, footer matches.
  const footerHint = wide
    ? (pane === "profiles" ? `${profilesHint}  ·  ${delegHint}` : `${delegHint}  ·  ${profilesHint}`)
    : (pane === "profiles" ? profilesHint : delegHint)

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
    <box flexDirection="row" flexGrow={1}>
      {/* ── Profiles ── */}
      {showProfiles ? (
      <TabShell title={`Profiles (${profiles.length})${sticky ? `  ·  ★ ${sticky}` : ""}`}
                error={err || null}
                focus={pane === "profiles"} grow={3}>
        <box flexDirection="row" flexGrow={1} minWidth={0}>
          {showList ? (
          <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={14}>
            <scrollbox ref={pFollow.ref} scrollY flexGrow={1} verticalScrollbarOptions={VBAR}>
              {profiles.length === 0
                ? <box height={1}>{err
                    ? <text fg={theme.textMuted}>—</text>
                    : <Spinner color={theme.textMuted} label="scanning profiles…" />}
                  </box>
                : profiles.map((p, i) => (
                    <ProfileRow key={p.name} id={pFollow.id(i)} p={p} idx={i} selected={i === pSel}
                      onHover={pHover} onEnter={pEnter} onDelete={pDelete} />
                  ))}
            </scrollbox>
          </box>
          ) : null}
          {showList && showDetail ? <box width={2} /> : null}
          {showDetail ? (
          <box flexDirection="column" flexGrow={2} flexBasis={0} minWidth={0}>
            {selected ? <ProfileDetail p={selected} stats={stats.get(selected.path)} />
              : <box height={1}><text fg={theme.textMuted}>No profiles</text></box>}
          </box>
          ) : null}
        </box>
      </TabShell>
      ) : null}

      {/* ── Delegation ── */}
      {showDeleg ? (
      <TabShell title={`Delegation (${active.length})`}
                focus={pane === "deleg"} grow={2} error={delegErr}>
        <box height={1} flexDirection="row" marginBottom={1}>
          <box flexShrink={0} paddingX={1}
               backgroundColor={deleg?.paused ? theme.warning : theme.backgroundElement}
               onMouseDown={togglePause}>
            <text fg={deleg?.paused ? theme.background : theme.text}>
              {deleg?.paused ? "⏸ paused" : "▶ active"}
            </text>
          </box>
          <box flexGrow={1} />
          <text fg={theme.textMuted}>click to {deleg?.paused ? "resume" : "pause"}</text>
        </box>
        {active.length === 0 ? (
          <box key="empty" flexGrow={1}>
            <text fg={theme.textMuted}>
              {deleg?.paused ? "Paused — new subagents will queue" : "No subagents running  ·  h for history"}
            </text>
          </box>
        ) : (
          <box key="body" flexDirection="column" flexGrow={1} minHeight={0}>
            <scrollbox ref={dFollow.ref} scrollY flexGrow={3} flexBasis={0} verticalScrollbarOptions={VBAR}>
              {active.map((r, i) => {
                const lv = liveMap.get(r.subagent_id)
                const row = lv ? { ...r, tool_count: lv.tool_count } : r
                const h = heat(aggOf.get(r.subagent_id)?.hot ?? 0, hotPeak, HOT.length)
                return <DelegRow key={r.subagent_id} id={dFollow.id(i)} r={row} idx={i}
                  selected={i === dSel} now={now} hot={h}
                  onHover={dHover} onKill={dKill} />
              })}
            </scrollbox>
            <box height={1}><text fg={theme.border}>{"─".repeat(4)}</text></box>
            <box flexGrow={2} flexBasis={0} minHeight={0}>
              {active[dSel]
                ? <DelegDetail r={active[dSel]} live={liveMap.get(active[dSel].subagent_id)}
                    agg={aggOf.get(active[dSel].subagent_id)} now={now} />
                : null}
            </box>
          </box>
        )}
      </TabShell>
      ) : null}
    </box>
    <HintBar raw={footerHint} />
    </box>
  )
})
