/**
 * Hand-curated validation overlay for config fields. Each rule takes
 * the *raw string buffer* as typed (pre-coercion) and returns an error
 * message, or null if valid. Rules run on Enter-commit in the Config
 * tab; a non-null result blocks the commit and renders inline.
 *
 * Schema-derived type coercion (int/float/bool) happens in lane.ts
 * *after* these pass, so rules only need to check semantic bounds,
 * not "is this a number".
 */

import { TOOL_PROGRESS } from "./lane"
import { APPROVAL_MODES } from "./schema"

type Rule = (raw: string) => string | null

const int = (lo: number, hi: number, what = `${lo}–${hi}`): Rule => raw => {
  const n = Number(raw)
  if (!Number.isInteger(n)) return `expected integer ${what}`
  if (n < lo || n > hi) return `expected ${what}`
  return null
}

const intMin = (lo: number, what = `≥ ${lo}`): Rule => raw => {
  const n = Number(raw)
  if (!Number.isInteger(n)) return `expected integer ${what}`
  if (n < lo) return `expected ${what}`
  return null
}

const integer: Rule = raw =>
  Number.isInteger(Number(raw)) ? null : "expected integer"

const float = (lo: number, hi: number): Rule => raw => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return `expected number ${lo}–${hi}`
  if (n < lo || n > hi) return `expected ${lo}–${hi}`
  return null
}

const oneOf = (...opts: string[]): Rule => raw =>
  opts.includes(raw) ? null : `expected one of: ${opts.join(" | ")}`

const nonNeg: Rule = raw => {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? null : "expected ≥ 0"
}

export const RULES: Record<string, Rule> = {
  // ratios
  "compression.threshold": float(0.1, 0.95),
  "compression.target_ratio": float(0.05, 0.9),
  "prompt_caching.cache_ttl": raw =>
    /^\d+[smhd]$/.test(raw.trim()) ? null : "expected duration e.g. 5m, 1h",

  // turn/iteration budgets
  "agent.max_turns": int(1, 10000),
  "agent.max_verify_nudges": int(0, 100),
  "delegation.max_iterations": int(1, 10000),
  "delegation.max_concurrent_children": int(1, 64),
  "delegation.max_spawn_depth": int(1, 3),
  "delegation.max_summary_chars": intMin(0),

  // timeouts (seconds; 0 usually means "disabled")
  "agent.gateway_timeout": nonNeg,
  "agent.gateway_timeout_warning": nonNeg,
  "agent.gateway_notify_interval": nonNeg,
  "agent.restart_drain_timeout": nonNeg,
  "gateway.platform_connect_timeout": integer,
  "delegation.child_timeout_seconds": nonNeg,
  "browser.command_timeout": int(1, 600),
  "approvals.timeout": int(1, 3600),
  "security.tirith_timeout": int(1, 120),

  // retries / limits
  "agent.api_max_retries": int(0, 20),
  "tool_output.max_bytes": int(1024, 10_000_000),
  "tool_output.max_lines": int(10, 100_000),
  "tools.tool_search.max_search_limit": int(1, 50),
  "tools.tool_search.search_default_limit": int(1, 50),
  "tools.tool_search.threshold_pct": int(0, 100),
  "sessions.retention_days": int(1, 3650),
  "sessions.min_interval_hours": int(1, 720),

  // enums the schema doesn't carry
  "agent.service_tier": oneOf("", "fast", "standard"),
  "agent.verify_on_stop": oneOf("auto", "true", "false"),
  "display.busy_input_mode": oneOf("queue", "steer", "interrupt"),
  "display.details_mode": oneOf("hidden", "collapsed", "expanded"),
  "display.thinking_mode": oneOf("collapsed", "truncated", "full"),
  "display.tool_progress": oneOf(...TOOL_PROGRESS),
  "display.final_response_markdown": oneOf("render", "strip", "raw"),
  "logging.level": oneOf("DEBUG", "INFO", "WARNING", "ERROR"),
  "approvals.mode": oneOf(...APPROVAL_MODES),
  "code_execution.mode": oneOf("project", "strict"),
  "onboarding.profile_build": oneOf("ask", "off"),
  "streaming.transport": oneOf("auto", "draft", "edit", "off"),
  "tools.tool_search.enabled": oneOf("auto", "on", "off"),
  "updates.non_interactive_local_changes": oneOf("stash", "discard"),
}

/** Validate a field's buffer. Unknown keys pass. */
export const check = (key: string, raw: string): string | null =>
  RULES[key]?.(raw) ?? null
