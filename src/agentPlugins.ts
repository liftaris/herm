import type { Gateway } from "./context/gateway"

export type AgentPluginStatus = "enabled" | "disabled" | "not enabled" | string

export type AgentPlugin = {
  name: string
  version: string
  description: string
  source: string
  status: AgentPluginStatus
}

type LegacyPlugin = {
  name?: string
  version?: string
  description?: string
  source?: string
  status?: string
  enabled?: boolean
}

export type PluginsListResponse = {
  plugins: LegacyPlugin[]
  user_count?: number
  bundled_count?: number
}

export type PluginsToggleRequest = { action: "toggle"; name: string; enable: boolean }

export type ShellResult = { stdout: string; stderr: string; code: number }

const shq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`

const status = (p: LegacyPlugin): AgentPluginStatus => {
  if (typeof p.status === "string" && p.status) return p.status
  if (p.enabled === true) return "enabled"
  if (p.enabled === false) return "disabled"
  return "not enabled"
}

export const normalizeAgentPlugin = (p: LegacyPlugin): AgentPlugin => ({
  name: p.name ?? "",
  version: p.version ?? "",
  description: p.description ?? "",
  source: p.source ?? "unknown",
  status: status(p),
})

export const listAgentPlugins = async (gw: Pick<Gateway, "request">) => {
  const r = await gw.request<PluginsListResponse>("plugins.list", { action: "list" })
  const plugins = (r.plugins ?? []).map(normalizeAgentPlugin)
  return {
    plugins,
    user_count: r.user_count ?? plugins.filter(p => p.source !== "bundled").length,
    bundled_count: r.bundled_count ?? plugins.filter(p => p.source === "bundled").length,
  }
}

export const toggleAgentPlugin = async (gw: Pick<Gateway, "request">, req: PluginsToggleRequest) => {
  const verb = req.enable ? "enable" : "disable"
  const cmd = `hermes plugins ${verb} ${shq(req.name)}`
  const r = await gw.request<ShellResult>("shell.exec", { command: cmd })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim())
  return normalizeAgentPlugin({
    name: req.name,
    status: req.enable ? "enabled" : "disabled",
  })
}
