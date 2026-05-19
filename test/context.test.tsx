import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mountNode } from "./harness"
import { Context } from "../src/tabs/Context"
import type { SessionInfo } from "../src/utils/gateway-types"
import type { Message } from "../src/types/message"

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
    const info: SessionInfo = { model: "gpt-4.1", context_max: 500_000 }
    const t = await mountNode(<Context info={info} />)
    // 500_000 formatted by fmt() → "500k"; surfaces in the status header
    // and the Free-space breakdown row.
    expect(strip(t.frame())).toContain("500k")
    t.destroy()
  })

  test("info.context_max overrides DEFAULT_CTX fallback", async () => {
    // DEFAULT_CTX = 128k; info claims 1M. Gateway must win.
    const info: SessionInfo = { model: "gpt-4o", context_max: 1_000_000 }
    const t = await mountNode(<Context info={info} />)
    const f = strip(t.frame())
    // 1_000_000 formats as "1.0M" via fmt()
    expect(f).toContain("1.0M")
    // Guard: must NOT fall back to 128k
    expect(f).not.toContain("128k")
    t.destroy()
  })

  test("falls back to DEFAULT_CTX when info absent", async () => {
    // No info, no session → DEFAULT_CTX (128k). Verify no crash.
    const t = await mountNode(<Context />)
    expect(strip(t.frame())).toContain("Context")
    t.destroy()
  })

  // In-grid threshold marker (◼ in textMuted past threshold) + ×N badge.
  describe("threshold marker", () => {
    test("renders '×N compressed' badge when compressions > 0", async () => {
      const info: SessionInfo = {
        model: "claude-opus-4-7",
        context_max: 200_000,
        usage: { input: 100, output: 50, total: 150, compressions: 3 },
      }
      const t = await mountNode(<Context info={info} />)
      expect(strip(t.frame())).toContain("×3 compressed")
      t.destroy()
    })

    test("no badge when compressions = 0", async () => {
      const info: SessionInfo = {
        model: "claude-opus-4-7",
        context_max: 200_000,
        usage: { input: 100, output: 50, total: 150, compressions: 0 },
      }
      const t = await mountNode(<Context info={info} />)
      expect(strip(t.frame())).not.toMatch(/×\d/)
      t.destroy()
    })

    test("no badge when usage absent", async () => {
      const info: SessionInfo = { model: "claude-opus-4-7", context_max: 200_000 }
      const t = await mountNode(<Context info={info} />)
      expect(strip(t.frame())).not.toMatch(/×\d/)
      t.destroy()
    })

    test("cells past threshold render ◼ in the grid", async () => {
      const info: SessionInfo = { model: "claude-opus-4-7", context_max: 200_000 }
      const t = await mountNode(<Context info={info} />)
      const f = strip(t.frame())
      // All-free fixture, threshold 0.5 → rows 0-7 are ◻, rows 8-15 are ◼.
      // Assert on a run so the Breakdown legend's lone ◼ can't satisfy it.
      expect(f).toContain("◼ ◼ ◼ ◼")
      expect(f).toContain("◻ ◻ ◻ ◻")
      t.destroy()
    })
  })

  // Categorical palette must never assign the same RGBA to two category ids,
  // on any built-in theme, in either mode. `free` intentionally sits outside
  // the ramp and is allowed to collide with nothing-but-itself.
  describe("categorical palette", () => {
    test("all category ids map to unique RGBA across every built-in theme", async () => {
      const { clr, SLOTS } = await import("../src/tabs/Context")
      const { DEFAULT_THEMES, resolveTheme } = await import("../src/theme")
      const key = (c: { r: number; g: number; b: number }) =>
        `${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)}`
      for (const [name, json] of Object.entries(DEFAULT_THEMES)) {
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
      const { DEFAULT_THEMES, DEFAULT_THEME, resolveTheme } = await import("../src/theme")
      const theme = resolveTheme(DEFAULT_THEMES[DEFAULT_THEME], "dark")
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
    const info: SessionInfo = { model: "test", context_max: 10_000 }
    const legend = (f: string) => f.split("\n").find(l => l.includes(" tok ")) ?? ""

    test("↓ selects first; clamps at last; ← steps back; Esc clears", async () => {
      const t = await mountNode(<Context focused messages={msgs} info={info} />)
      await t.settle()
      expect(legend(strip(t.frame()))).toBe("")

      act(() => t.keys.pressArrow("down"))
      await t.settle()
      expect(legend(strip(t.frame()))).toContain("Conversation")

      // Two segs → three ↓ clamps on Free (list.* clamps, does not wrap)
      act(() => { t.keys.pressArrow("down"); t.keys.pressArrow("down"); t.keys.pressArrow("down") })
      await t.settle()
      expect(legend(strip(t.frame()))).toContain("Free")

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
