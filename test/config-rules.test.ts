import { describe, expect, test } from "bun:test"
import { check, RULES } from "../src/config/rules"
import { SCHEMA } from "../src/config/schema"

describe("rules", () => {
  test("every rule key exists in schema", () => {
    const missing = Object.keys(RULES).filter(k => !SCHEMA[k])
    expect(missing).toEqual([])
  })

  test("every rule accepts its schema default", () => {
    for (const k of Object.keys(RULES)) {
      const def = SCHEMA[k].default
      const msg = check(k, String(def ?? ""))
      expect(msg, `${k} default '${def}' rejected: ${msg}`).toBeNull()
    }
  })

  test("int bounds reject out-of-range and non-integer", () => {
    expect(check("agent.max_turns", "0")).toMatch(/expected/)
    expect(check("agent.max_turns", "1")).toBeNull()
    expect(check("agent.max_turns", "90")).toBeNull()
    expect(check("agent.max_turns", "3.5")).toMatch(/integer/)
    expect(check("agent.max_turns", "abc")).toMatch(/integer/)
  })

  test("float bounds", () => {
    expect(check("compression.threshold", "0.5")).toBeNull()
    expect(check("compression.threshold", "0.05")).toMatch(/expected/)
    expect(check("compression.threshold", "0.99")).toMatch(/expected/)
    expect(check("compression.threshold", "nope")).toMatch(/number/)
  })

  test("oneOf enums", () => {
    expect(check("display.busy_input_mode", "queue")).toBeNull()
    expect(check("display.busy_input_mode", "panic")).toMatch(/one of/)
    expect(check("logging.level", "DEBUG")).toBeNull()
    expect(check("logging.level", "TRACE")).toMatch(/one of/)
  })

  test("tool progress accepts only live TUI modes", () => {
    for (const mode of ["off", "new", "all", "verbose"])
      expect(check("display.tool_progress", mode), mode).toBeNull()
    expect(check("display.tool_progress", "log")).toMatch(/one of/)
  })

  test("approval mode accepts only canonical modes", () => {
    for (const mode of ["manual", "smart", "off"])
      expect(check("approvals.mode", mode), mode).toBeNull()
    for (const mode of ["ask", "yolo", "deny"])
      expect(check("approvals.mode", mode), mode).toMatch(/manual \| smart \| off/)
  })

  test("nonNeg accepts 0", () => {
    expect(check("agent.gateway_timeout", "0")).toBeNull()
    expect(check("agent.gateway_timeout", "-1")).toMatch(/≥/)
  })

  test("disableable gateway timeout accepts negative integers", () => {
    expect(check("gateway.platform_connect_timeout", "-1")).toBeNull()
    expect(check("gateway.platform_connect_timeout", "1.5")).toMatch(/integer/)
  })

  test("child timeout requires non-negative seconds", () => {
    expect(check("delegation.child_timeout_seconds", "0")).toBeNull()
    expect(check("delegation.child_timeout_seconds", "-1")).toMatch(/≥/)
  })

  test("summary limit requires non-negative integer", () => {
    expect(check("delegation.max_summary_chars", "0")).toBeNull()
    expect(check("delegation.max_summary_chars", "24000")).toBeNull()
    expect(check("delegation.max_summary_chars", "-1")).toMatch(/≥/)
    expect(check("delegation.max_summary_chars", "1.9")).toMatch(/integer/)
  })

  test("tool search limits use documented ranges", () => {
    expect(check("tools.tool_search.max_search_limit", "50")).toBeNull()
    expect(check("tools.tool_search.max_search_limit", "51")).toMatch(/1–50/)
    expect(check("tools.tool_search.search_default_limit", "0")).toMatch(/1–50/)
    expect(check("tools.tool_search.threshold_pct", "100")).toBeNull()
    expect(check("tools.tool_search.threshold_pct", "101")).toMatch(/0–100/)
  })

  test("duration pattern", () => {
    expect(check("prompt_caching.cache_ttl", "5m")).toBeNull()
    expect(check("prompt_caching.cache_ttl", "2h")).toBeNull()
    expect(check("prompt_caching.cache_ttl", "5")).toMatch(/duration/)
  })

  test("unknown key passes", () => {
    expect(check("nonexistent.key", "anything")).toBeNull()
  })
})
