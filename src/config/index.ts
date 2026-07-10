import { SKINS } from "../context/skin"
import { SCHEMA, SCHEMA_KEYS, type ConfigEffect } from "./schema"
import { route, TOOL_PROGRESS } from "./lane"

export type FieldType = "boolean" | "select" | "number" | "string" | "readonly"

export type Field = {
  key: string
  label: string
  type: FieldType
  value: unknown
  /** True when the user's config.yaml has this key; false when
   *  falling through to the schema default. */
  set: boolean
  doc: string
  effect: ConfigEffect
  options?: string[]
}

// Enum-valued string fields the schema doesn't carry options for.
// Kept minimal — most enums are validated by rules.ts on commit; these
// are the ones worth cycling with [h/l] instead of free-typing.
const SELECTS: Record<string, string[]> = {
  "terminal.backend": ["local", "docker", "ssh", "modal", "daytona", "singularity", "vercel_sandbox"],
  "tts.provider": ["edge", "elevenlabs", "openai", "neutts", "xai", "mistral"],
  "display.skin": [...SKINS],
  "logging.level": ["DEBUG", "INFO", "WARNING", "ERROR"],
  "agent.reasoning_effort": ["", "none", "minimal", "low", "medium", "high", "xhigh"],
  "agent.verify_on_stop": ["auto", "true", "false"],
  "display.busy_input_mode": ["queue", "steer", "interrupt"],
  "display.details_mode": ["hidden", "collapsed", "expanded"],
  "display.thinking_mode": ["collapsed", "truncated", "full"],
  "display.tool_progress": [...TOOL_PROGRESS],
  "approvals.mode": ["manual", "ask", "yolo", "deny"],
  "onboarding.profile_build": ["ask", "off"],
  "streaming.transport": ["auto", "draft", "edit", "off"],
  "tools.tool_search.enabled": ["auto", "on", "off"],
  "updates.non_interactive_local_changes": ["stash", "discard"],
}

const get = (obj: Record<string, unknown>, path: string): unknown => {
  let cur: unknown = obj
  for (const p of path.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[p]
    else return undefined
  }
  return cur
}

const classify = (key: string, t: string): FieldType => {
  if (route(key).via === "readonly") return "readonly"
  if (SELECTS[key]) return "select"
  if (t === "bool") return "boolean"
  if (t === "int" || t === "float") return "number"
  return "string"
}

const labelOf = (key: string): string => {
  const raw = SCHEMA[key]?.group ?? key.split(".")[0]
  return key.startsWith(`${raw}.`) ? key.slice(raw.length + 1) : key
}

/** Build the full field model: every schema key, value = user-set
 *  else default, plus any user keys the schema doesn't know about
 *  (so surprises in config.yaml still surface). */
export const buildFields = (user: Record<string, unknown>): Field[] => {
  const seen = new Set<string>()
  const out: Field[] = []

  for (const key of SCHEMA_KEYS) {
    const s = SCHEMA[key]
    const uv = get(user, key)
    const set = uv !== undefined
    out.push({
      key,
      label: labelOf(key),
      type: classify(key, s.type),
      value: set ? uv : s.default,
      set,
      doc: s.doc,
      effect: s.effect,
      options: SELECTS[key],
    })
    seen.add(key)
  }

  // Unknown user keys (future agent version, hand-edits, plugins).
  const walk = (obj: Record<string, unknown>, prefix = "") => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === "object" && !Array.isArray(v)) {
        // Don't recurse into a dict that's itself a known readonly leaf.
        if (SCHEMA[key]?.type === "dict") { seen.add(key); continue }
        walk(v as Record<string, unknown>, key)
        continue
      }
      if (seen.has(key)) continue
      out.push({
        key,
        label: labelOf(key),
        type: Array.isArray(v) ? "readonly"
          : typeof v === "boolean" ? "boolean"
          : typeof v === "number" ? "number"
          : "string",
        value: v, set: true, doc: "", effect: "live",
      })
    }
  }
  walk(user)

  return out
}

// Small/satellite groups fold into a parent. This is a UX decision,
// not derivable from source — keeps the sidebar to ~18 entries instead
// of 34 with a dozen 1-field groups.
const MERGE: Record<string, string> = {
  approvals: "security", privacy: "security", secrets: "security",
  checkpoints: "agent", context: "agent", cron: "agent", network: "agent",
  model_catalog: "general", onboarding: "general",
  human_delay: "display", dashboard: "display", gateway: "display",
  desktop: "display", voice: "display",
  tool_output: "agent", prompt_caching: "compression", code_execution: "terminal",
  computer_use: "agent", goals: "agent", lsp: "agent", tool_loop_guardrails: "agent",
  web: "agent", x_search: "agent", tools: "agent", streaming: "display",
  vertex: "general",
  slack: "platforms", telegram: "platforms", mattermost: "platforms",
  discord: "platforms", whatsapp: "platforms", matrix: "platforms",
}

export const rawGroupOf = (key: string): string =>
  SCHEMA[key]?.group ?? (key.includes(".") ? key.split(".")[0] : "general")

export const groupOf = (key: string): string => {
  const raw = rawGroupOf(key)
  return MERGE[raw] ?? raw
}

export type Section = { head: string | null; items: Field[] }

/** Chunk a merged-group field list by its raw (pre-merge) groups so the
 *  UI can render sub-headers. Single-chunk → head=null. Multi-chunk →
 *  the self-named chunk (raw === merged name) floats to the front. */
export const sections = (group: string, fields: Field[]): Section[] => {
  const by = new Map<string, Field[]>()
  for (const f of fields) {
    const r = rawGroupOf(f.key)
    if (!by.has(r)) by.set(r, [])
    by.get(r)!.push(f)
  }
  if (by.size <= 1) return [{ head: null, items: fields }]
  const order = [...by.keys()].sort((a, b) =>
    a === group ? -1 : b === group ? 1 : a.localeCompare(b))
  return order.map(r => ({ head: r, items: by.get(r)! }))
}

/** Distinct groups in schema after merging, 'general' pinned first. */
export const GROUPS: string[] = (() => {
  const g = new Set<string>(["general"])
  for (const k of SCHEMA_KEYS) g.add(groupOf(k))
  return [...g]
})()

export const EFFECT_GLYPH: Record<ConfigEffect, string> = {
  live: "", session: "↻", restart: "⟳",
}
