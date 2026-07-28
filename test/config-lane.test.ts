import { describe, expect, test } from "bun:test"
import { route, toCliString, writeConfig, verifyWrite, maxEffect } from "../src/config/lane"

type Call = { method: string; params: Record<string, unknown> }
const mockGw = (handlers: Record<string, (p: Record<string, unknown>) => unknown>) => {
  const calls: Call[] = []
  return {
    calls,
    request: async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ method, params })
      const h = handlers[method]
      if (!h) throw new Error(`no handler: ${method}`)
      return h(params) as T
    },
  }
}

describe("lane.route", () => {
  test("whitelisted dotted keys → rpc alias", () => {
    expect(route("agent.reasoning_effort")).toEqual({ via: "rpc", alias: "reasoning", toWire: undefined })
    expect(route("model")).toEqual({ via: "rpc", alias: "model", toWire: undefined })
    expect(route("approvals.mode")).toEqual({ via: "rpc", alias: "approval_mode", toWire: undefined })
    const compact = route("display.tui_compact") as { via: "rpc"; alias: string; toWire: (v: unknown) => string }
    expect(compact.alias).toBe("compact")
    expect(compact.toWire(true)).toBe("on")
    expect(compact.toWire(false)).toBe("off")
  })

  test("display.sections.* → details_mode.<section>", () => {
    expect(route("display.sections.thinking")).toEqual({ via: "rpc", alias: "details_mode.thinking" })
  })

  test("list/dict-typed keys → readonly", () => {
    expect(route("terminal.docker_volumes").via).toBe("readonly")
    expect(route("providers").via).toBe("readonly")
    expect(route("mcp_servers").via).toBe("readonly")
  })

  test("everything else → cli", () => {
    expect(route("compression.threshold").via).toBe("cli")
    expect(route("memory.provider").via).toBe("cli")
    expect(route("terminal.backend").via).toBe("cli")
    expect(route("never.heard.of.it").via).toBe("cli")
  })

})

describe("lane.toCliString", () => {
  test("bool → true/false", () => {
    expect(toCliString("display.show_cost", true)).toBe("true")
    expect(toCliString("display.show_cost", false)).toBe("false")
  })
  test("int truncates", () => {
    expect(toCliString("agent.max_turns", 90.7)).toBe("90")
    expect(toCliString("gateway.platform_connect_timeout", 30.9)).toBe("30")
  })
  test("float preserves", () => {
    expect(toCliString("compression.threshold", 0.85)).toBe("0.85")
  })
  test("str passes raw (no numeric coercion in herm)", () => {
    expect(toCliString("terminal.docker_image", "python:3.11")).toBe("python:3.11")
  })
})

describe("lane.writeConfig", () => {
  test("partitions rpc/cli, serializes cli, collects failures and warnings", async () => {
    const order: string[] = []
    const gw = mockGw({
      "config.set": (p) => {
        order.push(`rpc:${p.key}`)
        if (p.key === "model") return { warning: "provider switched to anthropic" }
        return {}
      },
      "cli.exec": (p) => {
        const argv = p.argv as string[]
        order.push(`cli:${argv[2]}`)
        if (argv[2] === "logging.level") return { blocked: false, code: 1, output: "unknown level: LOUD" }
        return { blocked: false, code: 0, output: "✓" }
      },
    })
    const res = await writeConfig(gw, [
      { key: "agent.reasoning_effort", to: "high" },
      { key: "model", to: "claude-opus-4.6" },
      { key: "compression.threshold", to: 0.8 },
      { key: "logging.level", to: "LOUD" },
      { key: "terminal.docker_volumes", to: ["/a:/b"] },
    ])
    // rpc before cli; cli serialized in input order.
    expect(order).toEqual([
      "rpc:reasoning", "rpc:model", "cli:compression.threshold", "cli:logging.level",
    ])
    expect(res.ok.sort()).toEqual(["agent.reasoning_effort", "compression.threshold", "model"])
    expect(res.failed).toEqual([
      { key: "terminal.docker_volumes", err: "structured value — edit in YAML mode" },
      { key: "logging.level", err: "unknown level: LOUD" },
    ])
    expect(res.warnings).toEqual([{ key: "model", msg: "provider switched to anthropic" }])
    // cli lane sends pre-coerced string.
    const thr = gw.calls.find(c => c.method === "cli.exec" && (c.params.argv as string[])[2] === "compression.threshold")
    expect((thr?.params.argv as string[])[3]).toBe("0.8")
  })

  test("rpc rejection surfaces as failure, not throw", async () => {
    const gw = mockGw({
      "config.set": () => { throw new Error("4009 session busy") },
    })
    const res = await writeConfig(gw, [{ key: "model", to: "x" }])
    expect(res.ok).toEqual([])
    expect(res.failed[0]).toMatchObject({ key: "model" })
    expect(res.failed[0].err).toContain("session busy")
  })

  test("tool progress live modes use verbose RPC alias", async () => {
    const gw = mockGw({ "config.set": () => ({}) })
    const res = await writeConfig(gw, [{ key: "display.tool_progress", to: "verbose" }])
    expect(res).toEqual({ ok: ["display.tool_progress"], failed: [], warnings: [] })
    expect(gw.calls).toEqual([
      { method: "config.set", params: { key: "verbose", value: "verbose" } },
    ])
  })

  test("approval mode writes through live canonical RPC alias", async () => {
    const gw = mockGw({ "config.set": () => ({}) })
    const res = await writeConfig(gw, [{ key: "approvals.mode", to: "smart" }])
    expect(res).toEqual({ ok: ["approvals.mode"], failed: [], warnings: [] })
    expect(gw.calls).toEqual([
      { method: "config.set", params: { key: "approval_mode", value: "smart" } },
    ])
  })

  test("tool progress log is never sent to verbose RPC alias", async () => {
    const gw = mockGw({
      "config.set": () => { throw new Error("should not call rpc") },
    })
    const res = await writeConfig(gw, [{ key: "display.tool_progress", to: "log" }])
    expect(gw.calls).toEqual([])
    expect(res.ok).toEqual([])
    expect(res.failed).toEqual([
      { key: "display.tool_progress", err: "log is a gateway-only config-file mode, not a live TUI mode" },
    ])
  })
})

describe("lane.verifyWrite", () => {
  test("reports cli-lane keys whose disk value doesn't match intent", async () => {
    const gw = mockGw({
      "config.get": () => ({ config: { compression: { threshold: 0.5 }, logging: { level: "INFO" } } }),
    })
    const miss = await verifyWrite(gw, [
      { key: "compression.threshold", to: 0.8 },       // mismatch
      { key: "logging.level", to: "INFO" },             // matches
      { key: "agent.reasoning_effort", to: "high" },    // rpc lane → skipped
    ])
    expect(miss).toEqual(["compression.threshold"])
  })
})

describe("lane.maxEffect", () => {
  test("ranks restart > session > live", () => {
    expect(maxEffect(["display.skin"])).toBe("live")
    expect(maxEffect(["display.skin", "agent.max_turns"])).toBe("session")
    expect(maxEffect(["agent.max_turns", "terminal.backend"])).toBe("restart")
    expect(maxEffect([])).toBe("live")
  })
})
