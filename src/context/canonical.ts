export type Creation = { sources: string[]; parameters: string[] }
export type Subscription = { id: string; generation: number }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string")
}

export function creation(value: unknown): Creation {
  if (!record(value) || !strings(value.sources) || !strings(value.parameters)) throw new Error("invalid runtime.describe session_create")
  return { sources: value.sources, parameters: value.parameters }
}

export function prepare(method: string, original: Record<string, unknown>, contract: Creation | null, subscriptions: Map<string, Subscription>) {
  const params = method === "session.create" ? { ...launch(), ...original } : { ...original }
  if (method === "session.create") {
    delete params.session_id
    params.source = "tui"
    params.request_id ??= crypto.randomUUID()
    if (!contract?.sources.includes("tui")) throw new Error("runtime.describe does not advertise session.create source tui")
    const unsupported = Object.keys(params).filter(key => !contract.parameters.includes(key))
    if (unsupported.length) throw new Error(`session.create unsupported parameters: ${unsupported.join(", ")}`)
  }
  if (method === "session.activate" || method === "session.resume") {
    method = "session.resume"
    params.display_projection = true
  }
  if (method === "session.close") {
    method = "session.detach"
    const subscription = subscriptions.get(String(params.session_id))
    if (!subscription) throw new Error(`no subscription for session ${params.session_id}`)
    params.subscription_id = subscription.id
  }
  if (method === "session.interrupt") {
    const subscription = subscriptions.get(String(params.session_id))
    if (!subscription) throw new Error(`no subscription for session ${params.session_id}`)
    params.execution_generation = subscription.generation
  }
  if (method === "prompt.submit") params.input_id ??= crypto.randomUUID()
  return { method, params }
}

export function snapshot(method: string, value: unknown, subscriptions: Map<string, Subscription>): unknown {
  if (method !== "session.create" && method !== "session.resume") return value
  if (!record(value) || typeof value.session_id !== "string" || typeof value.subscription_id !== "string"
    || typeof value.execution_generation !== "number" || !Number.isInteger(value.execution_generation)
    || value.stored_session_id != null && typeof value.stored_session_id !== "string"
    || value.messages !== undefined && (!Array.isArray(value.messages) || !value.messages.every(record))
    || value.display_messages !== undefined && (!Array.isArray(value.display_messages) || !value.display_messages.every(record)))
    throw new Error(`invalid ${method} snapshot`)
  subscriptions.set(value.session_id, { id: value.subscription_id, generation: value.execution_generation })
  const messages = value.display_messages ?? value.messages?.map(row => ({ ...row, text: text(row.content), name: row.tool_name }))
  return { ...value, session_key: value.stored_session_id ?? value.session_id, messages, info: metadata(value.info) }
}

export function metadata(value: unknown) {
  if (value == null) return undefined
  if (!record(value)) throw new Error("invalid session.info metadata")
  return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== null))
}

function text(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map(part => {
    if (typeof part === "string") return part
    if (!part || typeof part !== "object") return ""
    if ("text" in part && typeof part.text === "string") return part.text
    return "type" in part && String(part.type).includes("image") ? "[image]" : ""
  }).filter(Boolean).join("\n")
}

function launch(): Record<string, unknown> {
  const env = process.env
  const options: Record<string, unknown> = Object.fromEntries(Object.entries({
    cwd: env.HERMES_CWD || process.cwd(), model: env.HERMES_MODEL, provider: env.HERMES_TUI_PROVIDER,
  }).filter(([, value]) => value))
  if (env.HERMES_TUI_TOOLSETS) options.toolsets = env.HERMES_TUI_TOOLSETS.split(",")
  if (env.HERMES_TUI_SKILLS) options.skills = [...new Set(env.HERMES_TUI_SKILLS.split(/[,\n]/).map(name => name.trim()).filter(Boolean))]
  if (env.HERMES_TUI_CLIENT_ENV) {
    const parsed: unknown = JSON.parse(env.HERMES_TUI_CLIENT_ENV)
    if (!record(parsed) || Object.values(parsed).some(value => typeof value !== "string")) throw new Error("invalid HERMES_TUI_CLIENT_ENV")
    options.client_env = parsed
  }
  if (env.HERMES_TUI_MAX_TURNS) {
    const turns = Number(env.HERMES_TUI_MAX_TURNS)
    options.max_turns = Number.isInteger(turns) ? turns : env.HERMES_TUI_MAX_TURNS.trim()
  }
  for (const [field, value] of Object.entries({
    yolo: env.HERMES_YOLO_MODE, ignore_rules: env.HERMES_IGNORE_RULES,
    safe_mode: env.HERMES_SAFE_MODE, ignore_user_config: env.HERMES_IGNORE_USER_CONFIG,
    checkpoints: env.HERMES_TUI_CHECKPOINTS, pass_session_id: env.HERMES_TUI_PASS_SESSION_ID,
    accept_hooks: env.HERMES_ACCEPT_HOOKS,
  })) if (["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "")) options[field] = true
  return options
}

export * as canonical from "./canonical"
