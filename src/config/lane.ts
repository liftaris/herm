import { SCHEMA, type ConfigSchemaEntry, type ConfigEffect } from "./schema"
//
// `config.set` on the gateway accepts a short whitelist of ALIAS keys,
// not dotted paths (anything else → 4002). Several of these mutate the
// live agent in place (reasoning effort, model, tool verbosity, …), so
// routing those through the RPC lane is what makes Config-tab edits
// apply to the running conversation without a new session.

type RpcAlias = {
  alias: string
  /** Map the schema-typed value to the wire value the alias expects. */
  toWire?: (v: unknown) => string
}

const onOff = (v: unknown) => (v ? "on" : "off")

export const TOOL_PROGRESS = ["off", "new", "all", "verbose"] as const
const progress = new Set<string>(TOOL_PROGRESS)
const progressErr = "log is a gateway-only config-file mode, not a live TUI mode"

export const RPC_ALIAS: Record<string, RpcAlias> = {
  model: { alias: "model" },
  provider: { alias: "model" },
  "agent.service_tier": { alias: "fast" },
  "agent.reasoning_effort": { alias: "reasoning" },
  "display.show_reasoning": { alias: "reasoning", toWire: v => (v ? "show" : "hide") },
  // Upstream messaging gateways support `display.tool_progress=log`, but
  // stock TUI `config.set verbose` only live-applies these four modes.
  "display.tool_progress": { alias: "verbose" },
  "display.busy_input_mode": { alias: "busy" },
  "display.details_mode": { alias: "details_mode" },
  "display.thinking_mode": { alias: "thinking_mode" },
  "display.tui_compact": { alias: "compact", toWire: onOff },
  "display.tui_statusbar": { alias: "statusbar" },
  "display.tui_mouse": { alias: "mouse", toWire: onOff },
  "display.skin": { alias: "skin" },
  "display.personality": { alias: "personality" },
  custom_prompt: { alias: "prompt" },
}

export type Lane =
  | { via: "rpc"; alias: string; toWire?: (v: unknown) => string }
  | { via: "cli" }
  | { via: "readonly" }

export const route = (key: string): Lane => {
  const a = RPC_ALIAS[key]
  if (a) return { via: "rpc", alias: a.alias, toWire: a.toWire }
  if (key.startsWith("display.sections."))
    return { via: "rpc", alias: `details_mode.${key.slice("display.sections.".length)}` }
  const s = SCHEMA[key]
  if (s && (s.type === "list" || s.type === "dict")) return { via: "readonly" }
  return { via: "cli" }
}
//
// `hermes config set` parses the string argv[2] with heuristics
// (true/false/on/off/yes/no → bool, all-digits → int, digits.digits →
// float, else raw string). We pre-format so the heuristic lands on the
// schema's declared type — in particular, a str-typed field whose
// value *looks* numeric stays a string by going through the cli raw.

export const toCliString = (key: string, v: unknown): string => {
  const t: ConfigSchemaEntry["type"] = SCHEMA[key]?.type ?? "str"
  if (t === "bool") return v ? "true" : "false"
  if (t === "int") return String(Math.trunc(Number(v)))
  if (t === "float") return String(Number(v))
  return String(v ?? "")
}

export type Diff = { key: string; to: unknown }
export type WriteResult = {
  ok: string[]
  failed: { key: string; err: string }[]
  warnings: { key: string; msg: string }[]
}

type Gw = {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

/** Apply a batch of config edits, routing each through its lane. RPC
 *  calls run first (they may refuse with a structured error and carry
 *  optional `warning`), then cli calls run serially — each one rewrites
 *  the whole config file, so Promise.all would last-write-wins. */
export const writeConfig = async (gw: Gw, diffs: Diff[]): Promise<WriteResult> => {
  const ok: string[] = []
  const failed: WriteResult["failed"] = []
  const warnings: WriteResult["warnings"] = []
  const blocked = diffs.filter(d => d.key === "display.tool_progress" && !progress.has(String(d.to ?? "")))
  for (const d of blocked) failed.push({ key: d.key, err: progressErr })
  const safe = diffs.filter(d => !blocked.includes(d))

  const rpc = safe.filter(d => route(d.key).via === "rpc")
  const cli = safe.filter(d => route(d.key).via === "cli")
  const ro = safe.filter(d => route(d.key).via === "readonly")
  for (const d of ro) failed.push({ key: d.key, err: "structured value — edit in YAML mode" })

  for (const d of rpc) {
    const lane = route(d.key) as Extract<Lane, { via: "rpc" }>
    const value = lane.toWire ? lane.toWire(d.to) : String(d.to ?? "")
    try {
      const res = await gw.request<{ warning?: string }>("config.set", { key: lane.alias, value })
      ok.push(d.key)
      if (res?.warning) warnings.push({ key: d.key, msg: res.warning })
    } catch (e) {
      failed.push({ key: d.key, err: e instanceof Error ? e.message : String(e) })
    }
  }

  for (const d of cli) {
    try {
      const res = await gw.request<{ code: number; output: string; blocked?: boolean; hint?: string }>(
        "cli.exec", { argv: ["config", "set", d.key, toCliString(d.key, d.to)], timeout: 30 },
      )
      if (res.blocked) failed.push({ key: d.key, err: res.hint ?? "blocked" })
      else if (res.code !== 0) failed.push({ key: d.key, err: res.output.split("\n")[0] || `exit ${res.code}` })
      else ok.push(d.key)
    } catch (e) {
      failed.push({ key: d.key, err: e instanceof Error ? e.message : String(e) })
    }
  }

  return { ok, failed, warnings }
}

const EFFECT_RANK: Record<ConfigEffect, number> = { live: 0, session: 1, restart: 2 }

export const maxEffect = (keys: string[]): ConfigEffect =>
  keys.reduce<ConfigEffect>((acc, k) => {
    const e = SCHEMA[k]?.effect ?? "live"
    return EFFECT_RANK[e] > EFFECT_RANK[acc] ? e : acc
  }, "live")

const get = (obj: Record<string, unknown>, path: string): unknown => {
  let cur: unknown = obj
  for (const p of path.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[p]
    else return undefined
  }
  return cur
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** After a write, compare intended values against a fresh config.get.
 *  RPC-aliased keys are skipped — several aliases write to a different
 *  dotted path than the one edited (e.g. reasoning:show →
 *  display.show_reasoning), so a literal readback would false-positive. */
export const verifyWrite = async (gw: Gw, applied: Diff[]): Promise<string[]> => {
  const res = await gw.request<{ config?: Record<string, unknown> }>("config.get", { key: "full" })
  const cfg = res.config ?? {}
  const miss: string[] = []
  for (const d of applied) {
    if (route(d.key).via !== "cli") continue
    if (!eq(get(cfg, d.key), d.to)) miss.push(d.key)
  }
  return miss
}
