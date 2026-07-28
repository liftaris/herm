import { describe, expect, test } from "bun:test"
import { APPROVAL_MODES, SCHEMA, SCHEMA_KEYS, type ConfigSchemaEntry } from "../src/config/schema"

describe("schema", () => {
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

  test("approval schema tracks current Hermes defaults", () => {
    expect([...APPROVAL_MODES]).toEqual(["manual", "smart", "off"])
    expect(SCHEMA["approvals.mode"].default).toBe("smart")
    expect(SCHEMA["approvals.timeout"].default).toBe(300)
    expect(SCHEMA["approvals.smart_policy"].type).toBe("str")
    expect(SCHEMA["approvals.denial_breaker_threshold"].default).toBe(3)
  })

  test("docs captured for commented leaves", () => {
    expect(SCHEMA["agent.gateway_timeout"].doc.length).toBeGreaterThan(20)
    expect(SCHEMA["compression.threshold"].doc.length).toBeGreaterThan(5)
  })

})
