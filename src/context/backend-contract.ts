export const MIN_BACKEND_CONTRACT = 4
export const MAX_BACKEND_CONTRACT = 5

export type BackendContractReason = "missing" | "malformed" | "older" | "supported" | "newer"

export type BackendContract = {
  minContract: number
  maxContract: number
  observedContract?: number
  sourceRevision?: string
  version?: string
  releaseDate?: string
  updateBehind?: number | null
  updateCommand?: string
  supported: boolean
  reason: BackendContractReason
}

const BOOT = new Set([
  "session.create",
  "session.resume",
  "session.activate",
])

const READ = new Set([
  "agents.list",
  "commands.catalog",
  "complete.path",
  "complete.slash",
  "config.get",
  "context.list",
  "delegation.status",
  "input.detect_drop",
  "learning.detail",
  "learning.frames",
  "model.options",
  "paste.collapse",
  "rollback.diff",
  "rollback.list",
  "session.active_list",
  "session.context_breakdown",
  "session.history",
  "session.list",
  "session.title",
  "session.usage",
  "skills.manage",
  "spawn_tree.list",
  "spawn_tree.load",
  "toolsets.list",
])

function obj(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
  return null
}

function text(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const v = raw.trim()
  return v || undefined
}

function revision(raw: Record<string, unknown>): string | undefined {
  return text(raw.source_revision)
    ?? text(raw.source_rev)
    ?? text(raw.revision)
    ?? text(raw.commit)
    ?? text(raw.git_sha)
}

export function backendContract(raw: unknown): BackendContract {
  const r = obj(raw)
  const n = r?.desktop_contract
  const version = text(r?.version)
  const releaseDate = text(r?.release_date)
  const updateCommand = text(r?.update_command)
  const updateBehind = typeof r?.update_behind === "number" || r?.update_behind === null
    ? r.update_behind
    : undefined
  const base = {
    minContract: MIN_BACKEND_CONTRACT,
    maxContract: MAX_BACKEND_CONTRACT,
    sourceRevision: r ? revision(r) : undefined,
    version,
    releaseDate,
    updateBehind,
    updateCommand,
  }

  if (!r || n === undefined || n === null) return { ...base, supported: false, reason: "missing" }
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n))
    return { ...base, supported: false, reason: "malformed" }
  if (n < MIN_BACKEND_CONTRACT)
    return { ...base, observedContract: n, supported: false, reason: "older" }
  if (n > MAX_BACKEND_CONTRACT)
    return { ...base, observedContract: n, supported: false, reason: "newer" }
  return { ...base, observedContract: n, supported: true, reason: "supported" }
}

export function contractMessage(state: BackendContract): string {
  const seen = state.observedContract === undefined ? state.reason : String(state.observedContract)
  const rev = state.sourceRevision ? ` · rev ${state.sourceRevision}` : ""
  const update = state.updateCommand ? ` Update with: ${state.updateCommand}` : ""
  if (state.reason === "newer")
    return `Hermes backend contract ${seen} is newer than Herm supports (${state.minContract}-${state.maxContract})${rev}. Update Herm before sending mutating commands.`
  if (state.reason === "older")
    return `Hermes backend contract ${seen} is older than Herm requires (${state.minContract})${rev}.${update}`
  if (state.reason === "malformed")
    return `Hermes backend contract payload is malformed; Herm requires ${state.minContract}-${state.maxContract} before mutating commands.${update}`
  return `Hermes backend contract is missing; Herm requires ${state.minContract}-${state.maxContract} before mutating commands.${update}`
}

export function mutates(method: string, params: Record<string, unknown> = {}): boolean {
  if (BOOT.has(method)) return false
  if (method === "session.title") return "title" in params
  if (method === "skills.manage") return params.action !== "list" && params.action !== "search"
  if (method === "cron.manage") return params.action !== "list"
  if (READ.has(method)) return false
  return true
}

export function contractError(method: string, state: BackendContract, params: Record<string, unknown> = {}): Error | null {
  if (!mutates(method, params)) return null
  if (state.supported) return null
  return new Error(`${contractMessage(state)} Blocked ${method}.`)
}

export * as backend from "./backend-contract"
