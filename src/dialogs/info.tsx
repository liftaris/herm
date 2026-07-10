// Small read-only KV dialogs for /status, /usage, /profile.
// /platforms has no structured RPC — it falls through to slash.exec
// and renders as a system line (see UPSTREAM.md).

import { useEffect, useState } from "react"
import type { RGBA } from "@opentui/core"
import { useTheme } from "../theme"
import { KVBlock } from "../ui/kv"
import { fmt, cost } from "../ui/fmt"
import type { DialogContext } from "../ui/dialog"
import type { Gateway } from "../context/gateway"
import type { SessionInfo, SessionUsageResponse } from "../context/wire"
import { listProfiles, activeProfileName } from "../service/hermes-profiles"
import { hermesPath } from "../service/hermes-home"

type Row = [string, string | undefined, RGBA?]

const InfoDialog = (props: { title: string; rows: Row[]; lines?: string[]; note?: string; warning?: string }) => {
  const theme = useTheme().theme
  const body = props.rows.filter(r => r[1] !== undefined)
  return (
    <box flexDirection="column" minWidth={52} gap={1}>
      <box height={1}><text fg={theme.primary}><strong>{props.title}</strong></text></box>
      {props.warning ? <text wrapMode="word" fg={theme.warning}>{props.warning}</text> : null}
      {props.lines?.length
        ? <box flexDirection="column">
            {props.lines.map((line, i) => (
              <box key={i} height={1}><text fg={theme.text}>{line}</text></box>
            ))}
          </box>
        : null}
      <box flexDirection="column"><KVBlock rows={body} /></box>
      {props.note
        ? <box height={1}><text fg={theme.textMuted}>{props.note}</text></box>
        : null}
      <box height={1}><text fg={theme.borderSubtle}>Esc to close</text></box>
    </box>
  )
}

export function openStatus(dialog: DialogContext, info: SessionInfo | null, sid: string) {
  const toolsets = Object.keys(info?.tools ?? {})
  const nTools = Object.values(info?.tools ?? {}).reduce((n, v) => n + v.length, 0)
  const mcp = info?.mcp_servers ?? []
  const up = mcp.filter(s => s.connected).length
  dialog.replace(
    <InfoDialog title="Status" rows={[
      ["Version",  info?.version || "—"],
      ["Model",    info?.model || "—"],
      ["Profile",  activeProfileName()],
      ["Home",     hermesPath("")],
      ["CWD",      info?.cwd || process.cwd()],
      ["Session",  sid || "—"],
      ["Tools",    `${nTools} in ${toolsets.length} toolset${toolsets.length === 1 ? "" : "s"}`],
      ["Skills",   String(Object.values(info?.skills ?? {}).reduce((n, v) => n + v.length, 0))],
      ["MCP",      mcp.length ? `${up}/${mcp.length} connected` : undefined],
    ]} warning={info?.install_warning} />,
  )
}

const UsageDialog = ({ gw }: { gw: Gateway }) => {
  const theme = useTheme().theme
  const [u, setU] = useState<SessionUsageResponse | null>(null)
  const [err, setErr] = useState("")
  useEffect(() => {
    gw.request<SessionUsageResponse>("session.usage")
      .then(setU).catch(e => setErr(e instanceof Error ? e.message : String(e)))
  }, [gw])

  if (err) return <InfoDialog title="Usage" rows={[["Error", err, theme.error]]} />
  if (!u) return <InfoDialog title="Usage" rows={[["", "…"]]} />

  const ctx = u.context_max
    ? `${fmt(u.context_used ?? 0)} / ${fmt(u.context_max)} (${Math.round(u.context_percent ?? 0)}%)`
    : undefined
  return (
    <InfoDialog title="Usage" lines={u.credits_lines} note={u.cost_status === "estimated" ? "cost is estimated" : undefined} rows={[
      ["Model",     u.model || "—"],
      ["API calls", String(u.calls ?? 0)],
      ["Input",     fmt(u.input ?? 0)],
      ["Output",    fmt(u.output ?? 0)],
      ["Cache r/w", (u.cache_read || u.cache_write) ? `${fmt(u.cache_read ?? 0)} / ${fmt(u.cache_write ?? 0)}` : undefined],
      ["Reasoning", u.reasoning ? fmt(u.reasoning) : undefined],
      ["Total",     fmt(u.total ?? 0)],
      ["Context",   ctx],
      ["Cost",      u.cost_usd != null ? cost(u.cost_usd) : undefined, theme.accent],
    ]} />
  )
}

export const openUsage = (dialog: DialogContext, gw: Gateway) =>
  dialog.replace(<UsageDialog gw={gw} />)

const ProfileDialog = () => {
  const [p, setP] = useState<import("../service/hermes-profiles").ProfileInfo | null | undefined>(undefined)
  const active = activeProfileName()
  useEffect(() => {
    listProfiles().then(ps => setP(ps.find(x => x.name === active) ?? null))
      .catch(() => setP(null))
  }, [])
  if (p === undefined) return <InfoDialog title="Profile" rows={[["", "…"]]} />
  return (
    <InfoDialog title="Profile" note={p ? undefined : "profile directory not found"} rows={[
      ["Active",   active],
      ["Home",     p?.path ?? hermesPath("")],
      ["Model",    p?.model ?? "—"],
      ["Provider", p?.provider ?? "—"],
      ["Skills",   p ? String(p.skill_count) : undefined],
      ["Gateway",  p?.gateway_running ? "running" : "stopped"],
      ["Sticky",   p?.is_sticky ? "yes" : undefined],
      ["Alias",    p?.is_default ? undefined : p?.has_alias ? `~/.local/bin/${active}` : "—"],
      [".env",     p?.has_env ? "present" : "—"],
    ]} />
  )
}

export const openProfile = (dialog: DialogContext) =>
  dialog.replace(<ProfileDialog />)
