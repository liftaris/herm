import { z } from "zod"

export const creation = z.object({ sources: z.array(z.string()), parameters: z.array(z.string()) })
export type Creation = z.infer<typeof creation>
export type Subscription = { id: string; generation: number }

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
  const parsed = z.object({ session_id: z.string(), subscription_id: z.string(), stored_session_id: z.string().nullish(), execution_generation: z.number().int(), messages: z.array(z.record(z.string(), z.unknown())).optional(), display_messages: z.array(z.record(z.string(), z.unknown())).optional() }).passthrough().parse(value)
  subscriptions.set(parsed.session_id, { id: parsed.subscription_id, generation: parsed.execution_generation })
  const messages = parsed.display_messages ?? parsed.messages?.map(row => ({ ...row, text: text(row.content), name: row.tool_name }))
  return { ...parsed, session_key: parsed.stored_session_id ?? parsed.session_id, messages, info: metadata(parsed.info) }
}

export function metadata(value: unknown) {
  const info = z.record(z.string(), z.unknown()).nullish().parse(value)
  return info ? Object.fromEntries(Object.entries(info).filter(([, value]) => value !== null)) : undefined
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
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(env.HERMES_TUI_CLIENT_ENV))
    if (!parsed.success) throw new Error("invalid HERMES_TUI_CLIENT_ENV")
    options.client_env = parsed.data
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
