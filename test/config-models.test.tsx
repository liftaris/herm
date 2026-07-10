import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mountNode, until, MockGateway } from "./harness"
import { Config } from "../src/tabs/Config"
import { readSlots, assign, resetAux, AUX_TASKS, staleAuxForMain } from "../src/config/models"

describe("config/models — slot projection + write lanes", () => {
  test("readSlots: main from model.*, aux from auxiliary.<task>.*", () => {
    const raw = {
      model: { provider: "openrouter", default: "anthropic/claude-opus-4.7" },
      auxiliary: {
        vision: { provider: "google", model: "gemini-2.5-flash" },
        compression: { provider: "auto" },
      },
    }
    const s = readSlots(raw)
    expect(s).toHaveLength(1 + AUX_TASKS.length)
    expect(s[0]).toMatchObject({ kind: "main", provider: "openrouter", model: "anthropic/claude-opus-4.7", auto: false })
    const v = s.find(x => x.key === "vision")!
    expect(v).toMatchObject({ kind: "aux", provider: "google", model: "gemini-2.5-flash", auto: false })
    const c = s.find(x => x.key === "compression")!
    expect(c.auto).toBe(true)
    // Unconfigured slot → auto.
    expect(s.find(x => x.key === "curator")!.auto).toBe(true)
  })

  test("staleAuxForMain returns explicit aux slots pinned to another provider", () => {
    const raw = {
      model: { provider: "anthropic", default: "claude" },
      auxiliary: {
        vision: { provider: "google", model: "gemini" },
        compression: { provider: "anthropic", model: "claude-haiku" },
        session_search: { provider: "auto", model: "" },
      },
    }
    const stale = staleAuxForMain(readSlots(raw), "anthropic")
    expect(stale.map(s => s.key)).toEqual(["vision"])
  })

  test("assign(main) → rpc config.set key=model --global; assign(aux) → 2× cli.exec", async () => {
    const calls: Array<{ m: string; p: unknown }> = []
    const gw = {
      request: async <T,>(m: string, p?: Record<string, unknown>) => {
        calls.push({ m, p })
        if (m === "cli.exec") return { code: 0, output: "" } as T
        return {} as T
      },
    }
    await assign(gw, "main", "anthropic", "claude-opus-4.7")
    expect(calls.at(-1)).toEqual({ m: "config.set",
      p: { key: "model", value: "claude-opus-4.7 --provider anthropic --global", session_id: undefined } })

    calls.length = 0
    await assign(gw, "vision", "google", "gemini-2.5-flash")
    expect(calls.map(c => c.m)).toEqual(["cli.exec", "cli.exec"])
    expect((calls[0].p as { argv: string[] }).argv)
      .toEqual(["config", "set", "auxiliary.vision.provider", "google"])
    expect((calls[1].p as { argv: string[] }).argv)
      .toEqual(["config", "set", "auxiliary.vision.model", "gemini-2.5-flash"])
  })

  test("resetAux('all') writes 2 keys per slot, provider=auto model=''", async () => {
    const argv: string[][] = []
    const gw = {
      request: async <T,>(m: string, p?: Record<string, unknown>) => {
        if (m === "cli.exec") argv.push((p as { argv: string[] }).argv)
        return { code: 0, output: "" } as T
      },
    }
    await resetAux(gw, "all")
    expect(argv).toHaveLength(AUX_TASKS.length * 2)
    expect(argv[0]).toEqual(["config", "set", `auxiliary.${AUX_TASKS[0].key}.provider`, "auto"])
    expect(argv[1]).toEqual(["config", "set", `auxiliary.${AUX_TASKS[0].key}.model`, ""])
  })
})

describe("Config → models category", () => {
  const cfg = {
    model: { provider: "openrouter", default: "anthropic/claude-opus-4.7" },
    auxiliary: { vision: { provider: "google", model: "gemini-2.5-flash" } },
  }
  const opts = {
    providers: [{ slug: "anthropic", name: "Anthropic", models: ["claude-opus-4.7", "claude-sonnet-5"], total_models: 2 }],
    provider: "openrouter", model: "anthropic/claude-opus-4.7",
  }

  test("lists 10 slots; Enter on aux opens picker, pick → cli.exec pair; x resets", async () => {
    const cli: string[][] = []
    const gw = new MockGateway({
      "config.get": () => ({ config: cfg }),
      "model.options": () => opts,
      "cli.exec": (p) => { cli.push(p.argv as string[]); return { code: 0, output: "" } },
    })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("models (13)"))

    // ↓ to 'models', → into slots
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressTab())
    await t.settle()
    const f = t.frame()
    expect(f).toContain("★")
    expect(f).toContain("Main model")
    expect(f).toContain("openrouter · anthropic/claude-opus-4.7")
    expect(f).toContain("Vision")
    expect(f).toContain("google · gemini-2.5-flash")
    expect(f).toContain("auto  (use main model)")
    expect(f).toContain("[Enter] pick  [x] reset  [X] reset-all")

    // ↓ to vision, Enter → picker titled for the slot
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Set auxiliary · Vision"))
    // pick Anthropic → sonnet-5
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("claude-sonnet-5"))
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => cli.length === 2)
    expect(cli[0]).toEqual(["config", "set", "auxiliary.vision.provider", "anthropic"])
    expect(cli[1]).toEqual(["config", "set", "auxiliary.vision.model", "claude-sonnet-5"])

    // x resets the same slot
    cli.length = 0
    await act(async () => { await t.keys.typeText("x") })
    await until(t, () => cli.length === 2)
    expect(cli[0]).toEqual(["config", "set", "auxiliary.vision.provider", "auto"])
    expect(cli[1]).toEqual(["config", "set", "auxiliary.vision.model", ""])
    t.destroy()
  })

  test("main switch warns about stale aux pins and can reset them to auto", async () => {
    const cli: string[][] = []
    const gw = new MockGateway({
      "config.get": () => ({ config: cfg }),
      "model.options": () => ({
        providers: [{ slug: "anthropic", name: "Anthropic", models: ["claude-opus-4.7"], total_models: 1 }],
        provider: "openrouter", model: "anthropic/claude-opus-4.7",
      }),
      "config.set": () => ({}),
      "cli.exec": (p) => { cli.push(p.argv as string[]); return { code: 0, output: "" } },
    })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("models (13)"))
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressTab())
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Set main model"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("claude-opus-4.7"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Auxiliary models still pinned to another provider"))
    expect(t.frame()).toContain("Vision")

    act(() => t.keys.pressEnter())
    await until(t, () => cli.length === 2)
    expect(cli[0]).toEqual(["config", "set", "auxiliary.vision.provider", "auto"])
    expect(cli[1]).toEqual(["config", "set", "auxiliary.vision.model", ""])
    t.destroy()
  })

  test("late main-model assignment cannot replace a newer dialog", async () => {
    let resolve!: (value: unknown) => void
    const gate = new Promise(resolveGate => { resolve = resolveGate })
    const gw = new MockGateway({
      "config.get": () => ({ config: cfg }),
      "model.options": () => ({
        providers: [{ slug: "anthropic", name: "Anthropic", models: ["claude-opus-4.7"], total_models: 1 }],
        provider: "openrouter", model: "anthropic/claude-opus-4.7",
      }),
      "config.set": () => gate,
    })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("models (13)"))
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressTab())
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Set main model"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("claude-opus-4.7"))
    act(() => t.keys.pressEnter())
    await until(t, () => gw.calls.some(c => c.method === "config.set"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Set main model"))
    resolve({})
    await gate
    await t.settle()
    expect(t.frame()).toContain("Set main model")
    expect(t.frame()).not.toContain("Auxiliary models still pinned")
    t.destroy()
  })
})
