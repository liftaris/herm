import { describe, expect, test } from "bun:test"
import { SCHEMA, SCHEMA_KEYS, type ConfigSchemaEntry } from "../src/config/schema"

describe("schema", () => {
  test("has at least 220 keys", () => {
    expect(SCHEMA_KEYS.length).toBeGreaterThanOrEqual(220)
  })

  test("no internal (_-prefixed) keys leak", () => {
    expect(SCHEMA_KEYS.filter(k => k.startsWith("_") || k.includes("._"))).toEqual([])
  })

  test("known keys carry the right type", () => {
    const expect_: Record<string, ConfigSchemaEntry["type"]> = {
      "agent.max_turns": "int",
      "compression.threshold": "float",
      "terminal.docker_volumes": "list",
      "display.show_reasoning": "bool",
      "memory.provider": "str",
      "providers": "dict",
    }
    for (const [k, t] of Object.entries(expect_)) {
      expect(SCHEMA[k], `missing ${k}`).toBeDefined()
      expect(SCHEMA[k].type, k).toBe(t)
    }
  })

  test("kanban profile cap parity keys are present", () => {
    expect(SCHEMA["kanban.default_assignee"]).toMatchObject({
      type: "str",
      default: "",
      group: "kanban",
    })
    expect(SCHEMA["kanban.max_in_progress_per_profile"]).toMatchObject({
      type: "null",
      default: null,
      group: "kanban",
    })
    expect(SCHEMA["kanban.max_in_progress_per_profile"].doc).toContain("Per-profile concurrency cap")
    expect(SCHEMA["kanban.max_in_progress_per_profile"].doc).toContain("positive int")
  })

  test("web extract char limit parity key is present", () => {
    expect(SCHEMA["web.extract_char_limit"]).toMatchObject({
      type: "int",
      default: 15000,
      group: "web",
    })
  })

  test("upstream 05cbddc config keys are present", () => {
    expect(SCHEMA["display.timestamp_format"]).toMatchObject({
      type: "str",
      default: "%H:%M",
      group: "display",
    })
    expect(SCHEMA["secrets.onepassword.enabled"]).toMatchObject({
      type: "bool",
      default: false,
      group: "secrets",
    })
  })

  test("group is first dotted segment (or 'general' for root keys)", () => {
    for (const k of SCHEMA_KEYS) {
      const want = k.includes(".") ? k.split(".")[0] : "general"
      expect(SCHEMA[k].group, k).toBe(want)
    }
  })

  test("effect tier matches classification rules", () => {
    expect(SCHEMA["terminal.backend"].effect).toBe("restart")
    expect(SCHEMA["toolsets"].effect).toBe("restart")
    expect(SCHEMA["agent.max_turns"].effect).toBe("session")
    expect(SCHEMA["agent.reasoning_effort"].effect).toBe("live")
    expect(SCHEMA["compression.threshold"].effect).toBe("live")
  })

  test("user-adds-only extras are present", () => {
    for (const k of ["custom_providers", "mcp_servers", "fallback_model"])
      expect(SCHEMA[k], k).toBeDefined()
  })

  test("docs captured for commented leaves", () => {
    expect(SCHEMA["agent.gateway_timeout"].doc.length).toBeGreaterThan(20)
    expect(SCHEMA["compression.threshold"].doc.length).toBeGreaterThan(5)
  })

  test("upstream config/env refresh keys are present", () => {
    for (const k of [
      "moa.save_traces",
      "moa.trace_dir",
      "gateway.restart_loop_guard.max_restarts",
      "gateway.restart_loop_guard.window_seconds",
      "browser.allow_unsafe_evaluate",
      "vertex.project_id",
      "vertex.region",
      "discord.bots_require_inline_mention",
    ]) expect(SCHEMA[k], k).toBeDefined()

    expect(SCHEMA["custom_providers"]).toMatchObject({ type: "dict" })
    expect(SCHEMA["providers"]).toMatchObject({ type: "dict" })
    expect(SCHEMA["prompt_caching.enabled"]).toBeUndefined()
  })
})
