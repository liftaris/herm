import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mountNode, until, MockGateway } from "./harness"
import { Context, contextBreakdown, contextMeter, remoteSegments } from "../src/tabs/Context"
import { build } from "../src/service/context-segments"
import type { SessionInfo } from "../src/context/wire"
import type { Message, Usage } from "../src/types/message"
import type { HermesConfig } from "../src/service/hermes-home"

// Strip ANSI so regex matches the visual text, not escape codes.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("Context tab", () => {
  // Regression: Context used to infinite-loop when mounted without a stable
  // `messages` prop — the `= []` default on every render triggered a
  // messages-dep useEffect → setWire → re-render storm. Now guarded via a
  // module-level frozen NO_MESSAGES reference.
  test("mounts without infinite-loop when messages prop absent", async () => {
    const t = await mountNode(<Context />)
    expect(t.frame().length).toBeGreaterThan(0)
    t.destroy()
  })

  // info.context_max (from gateway session.usage) overrides the hardcoded
  // CTX table fallback, so contexts on models not in CTX render
  // proportionally correctly.
  test("uses info.context_max for ctxLen", async () => {
    const info: SessionInfo = { model: "gpt-4.1", context_max: 500_000, context_used: 25_000 }
    const t = await mountNode(<Context info={info} />)
    // 500_000 formatted by fmt() → "500k"; surfaces in the status header
    // and the Free-space breakdown row.
    expect(strip(t.frame())).toContain("500k")
    t.destroy()
  })

  test("info.context_max overrides DEFAULT_CTX fallback", async () => {
    // DEFAULT_CTX = 128k; info claims 1M. Gateway must win.
    const info: SessionInfo = { model: "gpt-4o", context_max: 1_000_000, context_used: 50_000 }
    const t = await mountNode(<Context info={info} />)
    const f = strip(t.frame())
    // 1_000_000 formats as "1.0M" via fmt()
    expect(f).toContain("1.0M")
    // Guard: must NOT fall back to 128k
    expect(f).not.toContain("128k")
    t.destroy()
  })

  test("shows unavailable state when live used is absent", async () => {
    const messages: Message[] = [
      { id: "m1", role: "assistant", timestamp: 0, parts: [{ type: "text", content: "a", streaming: false }], usage: { input: 40_000, output: 10, total: 40_010 } },
      { id: "m2", role: "assistant", timestamp: 1, parts: [{ type: "text", content: "b", streaming: false }], usage: { input: 50_000, output: 10, total: 50_010 } },
    ]
    const t = await mountNode(<Context messages={messages} info={{ model: "test", context_max: 100_000 }} />)
    const f = strip(t.frame())
    expect(f).toContain("live usage unavailable")
    expect(f).toContain("~Conversation")
    expect(f).not.toContain("90k / 100k")
    expect(f).not.toContain("Context · 90k")
    t.destroy()
  })

  test("uses app-level live usage before cumulative message input", async () => {
    const messages: Message[] = [
      { id: "m1", role: "assistant", timestamp: 0, parts: [{ type: "text", content: "a", streaming: false }], usage: { input: 40_000, output: 10, total: 40_010 } },
      { id: "m2", role: "assistant", timestamp: 1, parts: [{ type: "text", content: "b", streaming: false }], usage: { input: 50_000, output: 10, total: 50_010 } },
    ]
    const usage: Usage = { input: 90_000, output: 20, total: 90_020, context_used: 12_000, context_max: 100_000 }
    const t = await mountNode(<Context messages={messages} usage={usage} info={{ model: "test", context_max: 100_000 }} />)
    const f = strip(t.frame())
    expect(f).toContain("Context · 12k / 100k (12%)")
    expect(f).not.toContain("90k / 100k")
    expect(f).toContain("Free — 88k")
    t.destroy()
  })

  test("maps session.context_breakdown categories to context segments", () => {
    const remote = contextBreakdown({
      categories: [
        { id: "tool_definitions", label: "Tool definitions", tokens: 2000, color: "red" },
        { id: "mcp", label: "MCP", tokens: 500, color: "blue" },
        { id: "conversation", label: "Conversation", tokens: 1000, color: "green" },
      ],
      context_max: 20_000,
      context_percent: 25,
      context_used: 5000,
      estimated_total: 3500,
      model: "test",
    })
    expect(remote).not.toBeNull()
    const local = build({ contextLength: 20_000, usedTokens: 5000, sections: [], conversationTokens: 1, tools: [] })
    const got = remoteSegments(remote!, local)
    expect(got.map(s => s.id)).toEqual(["system_tools", "mcp_tools", "conversation", "unknown", "free"])
    expect(got.find(s => s.id === "system_tools")?.tokens).toBe(2000)
    expect(got.find(s => s.id === "mcp_tools")?.tokens).toBe(500)
    expect(got.find(s => s.id === "unknown")?.tokens).toBe(1500)
    expect(got.find(s => s.id === "free")?.tokens).toBe(15_000)
  })

  test("uses session.context_breakdown payload when available", async () => {
    const gw = new MockGateway({
      "session.context_breakdown": () => ({
        categories: [
          { id: "tool_definitions", label: "Tool definitions", tokens: 2000, color: "red" },
          { id: "mcp", label: "MCP", tokens: 500, color: "blue" },
          { id: "conversation", label: "Conversation", tokens: 1000, color: "green" },
        ],
        context_max: 20_000,
        context_percent: 25,
        context_used: 5000,
        estimated_total: 3500,
        model: "test",
      }),
    })
    const t = await mountNode(<Context info={{ session_id: "s1", model: "test", context_max: 10_000, context_used: 1000 }} />, { gw })
    await until(t, () => strip(t.frame()).includes("Context · 5.0k / 20k (25%)"))
    const f = strip(t.frame())
    expect(gw.last("session.context_breakdown")?.params).toEqual({ session_id: "s1" })
    expect(f).toContain("Context · 5.0k / 20k (25%)")
    expect(f).toContain("System Tools — 2.0k")
    expect(f).toContain("MCP Tools — 500")
    expect(f).toContain("Conversation — 1.0k")
    expect(f).toContain("Free — 15k")
    t.destroy()
  })

  test("falls back to local estimate when context_breakdown errors", async () => {
    const gw = new MockGateway({ "session.context_breakdown": () => { throw new Error("old gateway") } })
    const t = await mountNode(<Context info={{ session_id: "s1", model: "test", context_max: 10_000, context_used: 1000 }} />, { gw })
    await until(t, () => gw.last("session.context_breakdown") !== undefined)
    const f = strip(t.frame())
    expect(gw.last("session.context_breakdown")?.params).toEqual({ session_id: "s1" })
    expect(f).toContain("Context · 1.0k / 10k (10%)")
    expect(f).toContain("Free — 9.0k")
    t.destroy()
  })

  test("uses resumed session.info usage before top-level context fields", async () => {
    const info: SessionInfo = {
      model: "test",
      context_used: 70_000,
      context_max: 100_000,
      usage: { input: 1, output: 2, total: 3, context_used: 22_000, context_max: 80_000 },
    }
    const t = await mountNode(<Context info={info} />)
    const f = strip(t.frame())
    expect(f).toContain("Context · 22k / 80k (28%)")
    expect(f).toContain("Free — 58k")
    t.destroy()
  })

  test("uses session.info tools without legacy session JSON snapshots", async () => {
    const info: SessionInfo = {
      model: "test",
      context_max: 10_000,
      context_used: 1000,
      tools: { builtin: ["terminal"], mcp: ["mcp_search"] },
    }
    const t = await mountNode(<Context info={info} />)
    await t.settle()
    const f = strip(t.frame())
    expect(f).toContain("System Tools")
    expect(f).toContain("MCP Tools")
    t.destroy()
  })

  test("empty live tools do not fall back to legacy tool snapshots", async () => {
    const t = await mountNode(<Context info={{ model: "test", context_max: 10_000, context_used: 1000, tools: {} }} />)
    const f = strip(t.frame())
    expect(f).not.toContain("System Tools")
    expect(f).not.toContain("MCP Tools")
    t.destroy()
  })

  test("config-only max fallback does not fabricate live usage", async () => {
    const cfg = { model: { context_length: 64_000 } } as HermesConfig
    expect(contextMeter(undefined, undefined, cfg)).toEqual({ max: 64_000, used: undefined })
    expect(contextMeter(undefined, undefined, { model: { context_length: 0 } } as HermesConfig)).toEqual({ max: 128_000, used: undefined })
    expect(contextMeter(undefined, undefined, { model: { context_length: -1 } } as HermesConfig)).toEqual({ max: 128_000, used: undefined })

    const t = await mountNode(<Context />)
    const f = strip(t.frame())
    expect(f).toContain("limit 128k")
    expect(f).toContain("live usage unavailable")
    expect(f).not.toContain("Context · 0 / 128k")
    t.destroy()
  })

  // In-grid threshold marker (◼ in textMuted past threshold) + ×N badge.
  describe("threshold marker", () => {
    test("renders '×N compressed' badge when compressions > 0", async () => {
      const info: SessionInfo = {
        model: "claude-opus-4-7",
        context_max: 200_000,
        usage: { input: 100, output: 50, total: 150, context_used: 40_000, context_max: 200_000, compressions: 3 },
      }
      const t = await mountNode(<Context info={info} />)
      expect(strip(t.frame())).toContain("×3 compressed")
      t.destroy()
    })

    test("no badge when compressions = 0", async () => {
      const info: SessionInfo = {
        model: "claude-opus-4-7",
        context_max: 200_000,
        usage: { input: 100, output: 50, total: 150, context_used: 40_000, context_max: 200_000, compressions: 0 },
      }
      const t = await mountNode(<Context info={info} />)
      expect(strip(t.frame())).not.toMatch(/×\d/)
      t.destroy()
    })

    test("no badge when usage absent", async () => {
      const info: SessionInfo = { model: "claude-opus-4-7", context_max: 200_000, context_used: 40_000 }
      const t = await mountNode(<Context info={info} />)
      expect(strip(t.frame())).not.toMatch(/×\d/)
      t.destroy()
    })

    test("cells past threshold render ◼ in the grid", async () => {
      const info: SessionInfo = { model: "claude-opus-4-7", context_max: 200_000, context_used: 40_000 }
      const t = await mountNode(<Context info={info} />)
      const f = strip(t.frame())
      // All-free fixture, threshold 0.5 → rows 0-7 are ◻, rows 8-15 are ◼.
      // Assert on a run so the Breakdown legend's lone ◼ can't satisfy it.
      expect(f).toContain("◼ ◼ ◼ ◼")
      expect(f).toContain("◻ ◻ ◻ ◻")
      t.destroy()
    })

    test("drilled groups hide full-window compression markers", async () => {
      const info: SessionInfo = {
        model: "claude-opus-4-7",
        context_max: 200_000,
        usage: {
          input: 100,
          output: 50,
          total: 150,
          context_used: 40_000,
          context_max: 200_000,
          compressions: 3,
        },
        system_prompt: "# Project Context\n" + "project context ".repeat(100) + "\nConversation started:",
      }
      const t = await mountNode(<Context focused info={info} />)
      act(() => t.keys.pressArrow("down"))
      act(() => t.keys.pressEnter())
      await t.settle()

      const f = strip(t.frame())
      expect(f).toContain("Breakdown · System Prompt")
      expect(f).not.toContain("×3 compressed")
      expect(f).not.toContain("Beyond compression threshold")
      t.destroy()
    })
  })

  // Categorical palette must never assign the same RGBA to two category ids,
  // on any built-in theme, in either mode. `free` intentionally sits outside
  // the ramp and is allowed to collide with nothing-but-itself.
  describe("categorical palette", () => {
    test("all category ids map to unique RGBA across every built-in theme", async () => {
      const { clr, SLOTS } = await import("../src/tabs/Context")
      const { NAMES, load, resolveTheme } = await import("../src/theme")
      const key = (c: { r: number; g: number; b: number }) =>
        `${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)}`
      for (const name of NAMES) {
        const json = await load(name)
        for (const mode of ["dark", "light"] as const) {
          const theme = resolveTheme(json, mode)
          const seen = new Map<string, string>()
          for (const id of SLOTS) {
            const k = key(clr(id, theme))
            if (seen.has(k)) {
              throw new Error(`${name}/${mode}: '${id}' collides with '${seen.get(k)}' at ${k}`)
            }
            seen.set(k, id)
          }
        }
      }
    })

    test("unknown id falls through to 'other' slot", async () => {
      const { clr } = await import("../src/tabs/Context")
      const { DEFAULT_THEME, load, resolveTheme } = await import("../src/theme")
      const theme = resolveTheme(await load(DEFAULT_THEME), "dark")
      expect(clr("does_not_exist", theme)).toEqual(clr("other", theme))
    })
  })

  // Grid keyboard nav routes through list.* (rebind-aware) with ←/→
  // as tab-local aliases. With an empty sandbox (no system prompt, no
  // tools) top-level segments reduce to Conversation + Free. Asserts
  // target the focus legend line (` tok `), the only selection-driven
  // surface — the breakdown rows render `◼ Conversation` regardless.
  describe("keyboard nav", () => {
    const msgs: Message[] = [{
      id: "m1", role: "user", timestamp: 0,
      parts: [{ type: "text", content: "hello world ".repeat(50), streaming: false }],
      usage: { input: 200, output: 0, total: 200 },
    }]
    const info: SessionInfo = { model: "test", context_max: 10_000, context_used: 1000 }
    const legend = (f: string) => f.split("\n").find(l => l.includes(" tok ")) ?? ""

    test("↓ selects first; clamps at last; ← steps back; Esc clears", async () => {
      const t = await mountNode(<Context focused messages={msgs} info={info} />)
      await t.settle()
      expect(legend(strip(t.frame()))).toBe("")

      act(() => t.keys.pressArrow("down"))
      await t.settle()
      expect(legend(strip(t.frame()))).toContain("Conversation")

      // Three segs → two ↓ lands on Unknown / Provider Overhead.
      act(() => { t.keys.pressArrow("down"); t.keys.pressArrow("down") })
      await t.settle()
      expect(legend(strip(t.frame()))).toContain("Unknown / Provider Overhead")

      // ← alias behaves like list.up
      act(() => t.keys.pressArrow("left"))
      await t.settle()
      expect(legend(strip(t.frame()))).toContain("Conversation")

      // Enter on leaf with no children: no drill, selection holds
      act(() => t.keys.pressEnter())
      await t.settle()
      expect(legend(strip(t.frame()))).toContain("Conversation")
      expect(strip(t.frame())).toContain("Esc back")

      act(() => t.keys.pressEscape())
      await t.settle()
      expect(strip(t.frame())).not.toContain("Esc back")
      expect(legend(strip(t.frame()))).toBe("")
      t.destroy()
    })

    test("ignores keys when not focused", async () => {
      const t = await mountNode(<Context messages={msgs} info={info} />)
      act(() => t.keys.pressArrow("down"))
      await t.settle()
      expect(legend(strip(t.frame()))).toBe("")
      t.destroy()
    })
  })
})
