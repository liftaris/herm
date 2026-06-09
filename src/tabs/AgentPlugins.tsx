import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useGateway } from "../context/gateway"
import { type AgentPlugin, listAgentPlugins, toggleAgentPlugin } from "../agentPlugins"
import { useListKeys, useFollow } from "../keys"
import { useTheme } from "../theme"
import { useDialog } from "../ui/dialog"
import { HintBar } from "../ui/hint"
import { KVBlock } from "../ui/kv"
import { TabShell } from "../ui/shell"
import { useToast } from "../ui/toast"
import { Col, Hdr, VBAR } from "../ui/table"

type Section = { source: string; items: AgentPlugin[] }

const enabled = (p: AgentPlugin) => p.status === "enabled"
const canToggle = (p: AgentPlugin) => p.status === "enabled" || p.status === "disabled" || p.status === "not enabled"
const statusLabel = (p: AgentPlugin) => p.status || "unknown"

const group = (list: AgentPlugin[]): Section[] => {
  const by = new Map<string, AgentPlugin[]>()
  for (const p of list) {
    const key = p.source || "unknown"
    by.set(key, [...(by.get(key) ?? []), p])
  }
  return [...by.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([source, items]) => ({ source, items }))
}

const rank = (source: string) =>
  source === "user" ? 0
  : source === "bundled" ? 1
  : 2

const statusFg = (theme: ReturnType<typeof useTheme>["theme"], p: AgentPlugin) =>
  enabled(p) ? theme.success
  : p.status === "disabled" || p.status === "not enabled" ? theme.textMuted
  : theme.warning

const Row = memo((props: {
  id: string
  plugin: AgentPlugin
  selected: boolean
  busy: boolean
  onSelect: () => void
  onHover: () => void
}) => {
  const theme = useTheme().theme
  const p = props.plugin
  const glyph = props.busy ? "◒" : enabled(p) ? "●" : "○"
  return (
    <box id={props.id} flexDirection="row" height={1}
         backgroundColor={props.selected ? theme.backgroundElement : undefined}
         onMouseDown={props.onSelect} onMouseMove={props.onHover}>
      <Col w={2} fg={props.selected ? theme.primary : theme.text}>{props.selected ? "▸ " : "  "}</Col>
      <Col w={2} fg={statusFg(theme, p)}>{`${glyph} `}</Col>
      <Col grow min={10} fg={props.selected ? theme.accent : theme.text}>{p.name}</Col>
      <Col w={10} fg={theme.info}>{p.version || "—"}</Col>
      <Col w={13} fg={theme.textMuted}>{statusLabel(p)}</Col>
      <Col w={10} fg={theme.textMuted}>{p.source || "unknown"}</Col>
    </box>
  )
})

const DetailPanel = memo((props: { plugin: AgentPlugin; busy: boolean }) => {
  const theme = useTheme().theme
  const p = props.plugin
  const action = enabled(p) ? "Disable" : "Enable"
  return (
    <box flexDirection="column" padding={1} border borderColor={theme.border}
         backgroundColor={theme.backgroundPanel} width="42%">
      <box height={1}><text fg={theme.accent}><strong>{p.name}</strong></text></box>
      <box height={1}><text fg={theme.textMuted}>Upstream Hermes Agent plugin</text></box>
      <box height={1} />
      <KVBlock rows={[
        ["Status", statusLabel(p), statusFg(theme, p)],
        ["Version", p.version || undefined, theme.info],
        ["Source", p.source || undefined, theme.text],
      ]} />
      <box height={1} />
      <box minHeight={1}>
        <text wrapMode="word" fg={theme.text}>{p.description || "No description"}</text>
      </box>
      <box height={1} />
      <box minHeight={2}>
        <text wrapMode="word" fg={theme.textMuted}>These are upstream Python/agent plugins, not Herm UI-extension plugins. A restart or reload may be required for changes to take effect.</text>
      </box>
      <box height={1} />
      <box height={1}>
        <text fg={canToggle(p) ? theme.text : theme.textMuted}>{props.busy ? "Applying…" : canToggle(p) ? `${action}: Space/Enter` : "Toggle unavailable"}</text>
      </box>
    </box>
  )
})

export const AgentPlugins = memo((props: { focused?: boolean }) => {
  const theme = useTheme().theme
  const gw = useGateway()
  const dialog = useDialog()
  const toast = useToast()
  const [plugins, setPlugins] = useState<AgentPlugin[]>([])
  const [counts, setCounts] = useState({ user: 0, bundled: 0 })
  const [sel, setSel] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const secs = group(plugins)
  const flat = secs.flatMap(s => s.items)
  const live = useRef({ flat, sel })
  live.current = { flat, sel }

  const load = useCallback(() => {
    setLoading(true)
    listAgentPlugins(gw)
      .then(r => {
        setPlugins(r.plugins)
        setCounts({ user: r.user_count, bundled: r.bundled_count })
        setSel(s => Math.max(0, Math.min(s, Math.max(0, r.plugins.length - 1))))
        setErr(null)
      })
      .catch(e => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [gw])

  useEffect(() => { load() }, [load])

  const toggle = useCallback(() => {
    const p = live.current.flat[live.current.sel]
    if (!p || busy) return
    if (!canToggle(p)) {
      toast.show({ variant: "warning", message: `${p.name} cannot be toggled` })
      return
    }
    const enable = !enabled(p)
    setBusy(p.name)
    const req = { action: "toggle", name: p.name, enable } as const
    toggleAgentPlugin(gw, req)
      .then(plugin => {
        setPlugins(prev => prev.map(x => x.name === p.name ? { ...x, ...plugin } : x))
        setErr(null)
        toast.show({
          variant: "success",
          message: `${plugin.name} ${enabled(plugin) ? "enabled" : "disabled"}. Restart or reload may be required.`,
        })
      })
      .catch(e => {
        const msg = e instanceof Error ? e.message : String(e)
        setErr(msg)
        toast.show({ variant: "error", message: msg })
      })
      .finally(() => setBusy(null))
  }, [gw, toast, busy])

  const follow = useFollow("agent-plugin")
  const keys = useListKeys({
    active: () => !!props.focused && !dialog.open(),
    count: flat.length,
    setSel,
    ...follow.opts,
    onToggle: toggle,
    onActivate: toggle,
    onRefresh: () => { load(); toast.show({ variant: "info", message: "Reloading agent plugins", duration: 1000 }) },
  })
  const selected = flat[sel] ?? null

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <box flexDirection="row" flexGrow={1} minWidth={0}>
        <TabShell title={`Agent Plugins (${flat.length})`} error={err}>
          <box minHeight={2} flexShrink={0}>
            <text wrapMode="word" fg={theme.textMuted}>Upstream Hermes Agent plugins · user {String(counts.user)} · bundled {String(counts.bundled)} · not Herm UI extensions</text>
          </box>
          <box height={1} flexShrink={0}>
            <text fg={theme.textMuted}>A restart or reload may be required for changes to take effect.</text>
          </box>
          <box height={1} />
          <Hdr>
            <Col w={4} fg={theme.textMuted}>{""}</Col>
            <Col grow min={10} fg={theme.textMuted} bold>Name</Col>
            <Col w={10} fg={theme.textMuted} bold>Version</Col>
            <Col w={13} fg={theme.textMuted} bold>Status</Col>
            <Col w={10} fg={theme.textMuted} bold>Source</Col>
          </Hdr>
          {loading ? (
            <box key="loading" flexGrow={1} padding={2}>
              <text fg={theme.textMuted}>Loading agent plugins…</text>
            </box>
          ) : flat.length === 0 ? (
            <box key="empty" flexGrow={1} padding={2}>
              <text fg={theme.textMuted}>No upstream agent plugins found</text>
            </box>
          ) : (
            <scrollbox key="list" ref={follow.ref} scrollY flexGrow={1} verticalScrollbarOptions={VBAR}>
              {secs.reduce<{ base: number; out: ReactNode[] }>((acc, s) => {
                acc.out.push(
                  <box key={`§${s.source}`} height={1} marginTop={acc.base > 0 ? 1 : 0}>
                    <text fg={theme.textMuted}>─ {s.source || "unknown"} ({s.items.length}) </text>
                  </box>
                )
                s.items.forEach((p, j) => {
                  const i = acc.base + j
                  acc.out.push(
                    <Row key={`${p.source}:${p.name}`} id={follow.id(i)} plugin={p}
                         selected={i === sel} busy={busy === p.name}
                         onSelect={() => setSel(i)} onHover={() => setSel(i)} />
                  )
                })
                acc.base += s.items.length
                return acc
              }, { base: 0, out: [] }).out}
            </scrollbox>
          )}
        </TabShell>
        {selected ? <DetailPanel plugin={selected} busy={busy === selected.name} /> : null}
      </box>
      <HintBar pairs={[
        ["↑↓", "nav"],
        [keys.print("list.toggle"), "toggle"],
        [keys.print("list.refresh"), "refresh"],
      ]} />
    </box>
  )
})
