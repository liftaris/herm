export type CronJob = {
  id: string
  name: string
  prompt: string
  schedule: string
  enabled: boolean
  state: string
  deliver: string
  repeat?: string
  last_run?: string
  next_run?: string
  last_status?: "ok" | "error"
  last_error?: string
  paused_reason?: string
  provider?: string
  model?: string
  base_url?: string
  no_agent?: boolean
  attach_to_session?: boolean
  skills?: string[]
  context_from?: string[]
  enabled_toolsets?: string[]
  workdir?: string
  script?: string
}

export type RawJob = {
  job_id?: string
  id?: string
  name?: string
  prompt_preview?: string
  prompt?: string
  schedule?: string
  enabled?: boolean
  state?: string
  deliver?: string
  repeat?: string
  last_run_at?: string
  next_run_at?: string
  last_status?: string
  last_delivery_error?: string
  paused_reason?: string
  provider?: string
  model?: string
  base_url?: string
  no_agent?: boolean
  attach_to_session?: boolean
  skills?: string[] | string
  context_from?: string[] | string
  enabled_toolsets?: string[] | string
  workdir?: string
  script?: string
}

export type CronDraft = {
  id: string
  name: string
  schedule: string
  prompt: string
  script: string
  no_agent: boolean
  attach_to_session: boolean
  skills: string
  provider: string
  model: string
  base_url: string
  context_from: string
  enabled_toolsets: string
  workdir: string
  deliver: string
  repeat: string
}

export type CronPayload = Record<string, unknown>
export type CronAction = "add" | "update"

const arr = (value: string[] | string | undefined): string[] | undefined => {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === "string") return split(value)
  return undefined
}

export const split = (value: string): string[] =>
  value.split(/[\n,]/).map(s => s.trim()).filter(Boolean)

export const base = (value: string): string =>
  value.trim().replace(/\/+$/, "")

export const normalize = (j: RawJob): CronJob => ({
  id: j.job_id ?? j.id ?? "",
  name: j.name ?? "",
  prompt: j.prompt ?? j.prompt_preview ?? "",
  schedule: j.schedule ?? "",
  enabled: j.enabled ?? true,
  state: j.state ?? "scheduled",
  deliver: j.deliver ?? "local",
  repeat: j.repeat,
  last_run: j.last_run_at,
  next_run: j.next_run_at,
  last_status: j.last_status === "ok" || j.last_status === "error" ? j.last_status : undefined,
  last_error: j.last_delivery_error,
  paused_reason: j.paused_reason,
  provider: j.provider,
  model: j.model,
  base_url: j.base_url,
  no_agent: j.no_agent,
  attach_to_session: j.attach_to_session,
  skills: arr(j.skills),
  context_from: arr(j.context_from),
  enabled_toolsets: arr(j.enabled_toolsets),
  workdir: j.workdir,
  script: j.script,
})

export const draft = (j?: CronJob): CronDraft => ({
  id: j?.id ?? "",
  name: j?.name ?? "",
  schedule: j?.schedule ?? "",
  prompt: j?.prompt ?? "",
  script: j?.script ?? "",
  no_agent: !!j?.no_agent,
  attach_to_session: !!j?.attach_to_session,
  skills: j?.skills?.join(", ") ?? "",
  provider: j?.provider ?? "",
  model: j?.model ?? "",
  base_url: j?.base_url ?? "",
  context_from: j?.context_from?.join(", ") ?? "",
  enabled_toolsets: j?.enabled_toolsets?.join(", ") ?? "",
  workdir: j?.workdir ?? "",
  deliver: j?.deliver ?? "local",
  repeat: "",
})

export const has = (d: CronDraft): boolean => {
  if (d.no_agent) return d.script.trim().length > 0
  return d.prompt.trim().length > 0 || d.script.trim().length > 0 || split(d.skills).length > 0
}

export const validate = (d: CronDraft): string | null => {
  if (!d.schedule.trim()) return "Schedule is required"
  if (!has(d)) return d.no_agent
    ? "No-agent jobs require a script"
    : "Agent jobs require a prompt, skill, or script"
  if (d.repeat.trim() && (!Number.isInteger(Number(d.repeat.trim())) || Number(d.repeat.trim()) <= 0))
    return "Repeat must be a positive integer"
  if (base(d.base_url)) {
    const ok = URL.canParse(base(d.base_url))
    if (!ok) return "Base URL must be a valid URL"
  }
  return null
}

export const payload = (action: CronAction, d: CronDraft, opts?: { fields?: ReadonlySet<string> }): CronPayload => {
  const out: CronPayload = {
    action,
    name: action === "add" ? d.name.trim() : d.id,
    schedule: d.schedule.trim(),
    prompt: d.prompt.trim(),
  }
  const allowed = (key: string) => opts?.fields === undefined || opts.fields.has(key)
  if (allowed("deliver")) out.deliver = d.deliver.trim() || "local"
  if (allowed("no_agent")) out.no_agent = d.no_agent
  if (allowed("attach_to_session")) out.attach_to_session = d.attach_to_session
  const add = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value
  }
  const scalar = (value: string) => value.trim() || (action === "update" ? "" : undefined)
  const skills = split(d.skills)
  const refs = split(d.context_from)
  const tools = split(d.enabled_toolsets)
  if (allowed("skills") && (action === "update" || skills.length > 0)) add("skills", skills)
  if (allowed("context_from") && (action === "update" || refs.length > 0)) add("context_from", refs)
  if (allowed("enabled_toolsets") && (action === "update" || tools.length > 0)) add("enabled_toolsets", tools)
  if (allowed("provider")) add("provider", scalar(d.provider))
  if (allowed("model")) add("model", scalar(d.model))
  if (allowed("base_url")) add("base_url", base(d.base_url) || (action === "update" ? "" : undefined))
  if (allowed("script")) add("script", scalar(d.script))
  if (allowed("workdir")) add("workdir", scalar(d.workdir))
  if (allowed("repeat")) add("repeat", d.repeat.trim() ? Number(d.repeat.trim()) : action === "update" ? 0 : undefined)
  return out
}

export * as cronModel from "./cron-model"
