import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mountNode, until, MockGateway } from "./harness"
import { useDialog } from "../src/ui/dialog"
import { useGateway } from "../src/context/gateway"
import { openModelPicker } from "../src/dialogs/model-picker"
import type { ModelOptionsResponse } from "../src/context/wire"
import { useEffect } from "react"

const Open = () => {
  const d = useDialog()
  const gw = useGateway()
  useEffect(() => { openModelPicker(d, gw) }, [])
  return null
}

const OpenRefresh = () => {
  const d = useDialog()
  const gw = useGateway()
  useEffect(() => { openModelPicker(d, gw, { refresh: true }) }, [])
  return null
}

const OPTIONS = {
  provider: "anthropic",
  model: "claude-3",
  providers: [
    {
      slug: "anthropic",
      name: "Anthropic",
      is_current: true,
      total_models: 2,
      models: ["claude-3", "claude-4"],
      capabilities: { "claude-4": { fast: true, reasoning: true } },
    },
    { slug: "openai", name: "OpenAI", total_models: 1, models: ["gpt-4"] },
  ],
}

describe("model-picker", () => {
  test("initial open uses normal options and r refreshes with refresh param", async () => {
    const calls: Array<Record<string, unknown>> = []
    const gw = new MockGateway({
      "model.options": p => { calls.push(p); return OPTIONS },
    })
    gw.setSession("sess-abc")
    const t = await mountNode(<Open />, { gw })
    await until(t, () => t.frame().includes("Anthropic"))

    expect(calls).toEqual([{ session_id: "sess-abc", include_unconfigured: true }])
    act(() => t.keys.pressKey("r"))
    await until(t, () => calls.length === 2)
    expect(calls[1]).toMatchObject({ session_id: "sess-abc", refresh: true, include_unconfigured: true })
    expect(t.frame()).toContain("Anthropic")
    t.destroy()
  })

  test("forced refresh open calls model.options with refresh param", async () => {
    const calls: Array<Record<string, unknown>> = []
    const t = await mountNode(<OpenRefresh />, {
      handlers: {
        "model.options": p => { calls.push(p); return OPTIONS },
      },
    })
    await until(t, () => t.frame().includes("Anthropic"))

    expect(calls).toEqual([{ refresh: true, include_unconfigured: true }])
    t.destroy()
  })

  test("forced refresh open surfaces model.options errors", async () => {
    const t = await mountNode(<OpenRefresh />, {
      handlers: { "model.options": () => { throw new Error("catalog unavailable") } },
    })
    await until(t, () => t.frame().includes("catalog unavailable"))
    expect(t.frame()).toContain("Refresh model options")
    t.destroy()
  })

  test("session-scoped by default → config.set sends combined arg with session_id; Tab toggles global", async () => {
    const sets: Array<Record<string, unknown>> = []
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": () => OPTIONS,
        "config.set": (p) => { sets.push(p); return { key: "model", value: p.value } },
      },
    })
    t.gw.setSession("sess-abc")
    await until(t, () => t.frame().includes("Anthropic"))
    expect(t.frame()).toContain("this session")

    // Enter on Anthropic → model step; Enter on claude-3 → apply
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("claude-3"))
    act(() => t.keys.pressEnter()); await t.settle()

    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({
      key: "model",
      value: "claude-3 --provider anthropic",
      session_id: "sess-abc",
    })
    t.destroy()
  })

  test("Tab → global scope omits session_id and appends --global", async () => {
    const sets: Array<Record<string, unknown>> = []
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": () => OPTIONS,
        "config.set": (p) => { sets.push(p); return { key: "model", value: p.value } },
      },
    })
    t.gw.setSession("sess-abc")
    await until(t, () => t.frame().includes("this session"))

    act(() => t.keys.pressTab()); await t.settle()
    expect(t.frame()).toContain("global")

    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("claude-3"))
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()

    expect(sets).toHaveLength(1)
    expect(sets[0].value).toBe("claude-4 --provider anthropic --global")
    expect(sets[0].session_id).toBeUndefined()
    t.destroy()
  })

  test("unauthenticated provider rows show setup metadata and do not advance to empty models", async () => {
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": p => ({
          provider: "openai",
          model: "gpt-4",
          providers: [
            { slug: "openai", name: "OpenAI", total_models: 1, models: ["gpt-4"] },
            p.include_unconfigured === true ? {
              slug: "anthropic",
              name: "Anthropic",
              total_models: 0,
              models: [],
              authenticated: false,
              auth_type: "api_key",
              key_env: "ANTHROPIC_API_KEY",
              warning: "paste ANTHROPIC_API_KEY to activate",
            } : undefined,
          ].filter(p => p !== undefined),
        }),
      },
    })
    await until(t, () => t.frame().includes("Anthropic"))
    expect(t.gw.last("model.options")?.params).toMatchObject({ include_unconfigured: true })
    expect(t.frame()).toContain("Setup required")
    expect(t.frame()).toContain("paste ANTHROPIC_API_KEY to activate")

    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("Paste ANTHROPIC_API_KEY"))
    expect(t.frame()).not.toContain("Switch Model (Anthropic)")
    t.destroy()
  })

  test("api-key setup calls model.save_key and advances to refreshed models", async () => {
    const saves: Array<Record<string, unknown>> = []
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": () => ({
          providers: [
            { slug: "openai", name: "OpenAI", total_models: 1, models: ["gpt-4"] },
            {
              slug: "anthropic",
              name: "Anthropic",
              total_models: 0,
              models: [],
              authenticated: false,
              auth_type: "api_key",
              key_env: "ANTHROPIC_API_KEY",
              warning: "paste ANTHROPIC_API_KEY to activate",
            },
          ],
        }),
        "model.save_key": (p) => {
          saves.push(p)
          return {
            provider: {
              slug: "anthropic",
              name: "Anthropic",
              authenticated: true,
              total_models: 1,
              models: ["claude-opus"],
            },
          }
        },
      },
    })
    await until(t, () => t.frame().includes("Anthropic"))
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("Paste ANTHROPIC_API_KEY"))
    await act(async () => { await t.keys.typeText("sk-test") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("claude-opus"))

    expect(saves).toEqual([{ slug: "anthropic", api_key: "sk-test" }])
    expect(t.gw.calls.filter(c => c.method === "model.options")).toHaveLength(1)
    expect(t.frame()).toContain("Switch Model (Anthropic)")
    t.destroy()
  })

  test("refresh key forces model.options refresh and applies returned providers", async () => {
    const opts = {
      provider: "moa",
      model: "moa/fast",
      providers: [
        { slug: "moa", name: "Mixture of Agents", is_current: true, total_models: 1, models: ["moa/fast"] },
        ...OPTIONS.providers,
      ],
    }
    const calls: Array<Record<string, unknown>> = []
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": (p) => {
          calls.push(p)
          return p.refresh ? opts : { providers: [] }
        },
      },
    })
    await until(t, () => t.frame().includes("Refresh model options"))
    expect(t.frame()).toContain("Refresh model options")

    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("Mixture of Agents"))

    expect(calls).toEqual([
      { include_unconfigured: true },
      { refresh: true, include_unconfigured: true },
    ])
    expect(t.frame()).toContain("Mixture of Agents")
    t.destroy()
  })

  test("stale forced refresh cannot replace newer model options", async () => {
    let stale!: (value: unknown) => void
    let refreshes = 0
    const fresh = {
      providers: [{ slug: "fresh", name: "Fresh Provider", total_models: 1, models: ["fresh/model"] }],
    }
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": p => {
          if (!p.refresh) return OPTIONS
          if (refreshes++ === 0) return new Promise(resolve => { stale = resolve })
          return fresh
        },
      },
    })
    await until(t, () => t.frame().includes("Anthropic"))
    act(() => t.keys.pressKey("r"))
    await until(t, () => refreshes === 1)
    act(() => t.keys.pressKey("r"))
    await until(t, () => refreshes === 2)
    act(() => { t.keys.pressBackspace(); t.keys.pressBackspace() })
    await until(t, () => t.frame().includes("Fresh Provider"))

    stale(OPTIONS)
    await act(async () => { await Bun.sleep(0) })
    await t.settle()
    expect(t.frame()).toContain("Fresh Provider")
    expect(t.frame()).not.toContain("Anthropic")
    t.destroy()
  })

  test("save-key fallback refreshes model options before warning", async () => {
    const calls: Array<Record<string, unknown>> = []
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": (p) => {
          calls.push(p)
          return {
            providers: [
              { slug: "openai", name: "OpenAI", total_models: 1, models: ["gpt-4"] },
              {
                slug: "anthropic",
                name: "Anthropic",
                total_models: calls.length > 1 ? 1 : 0,
                models: calls.length > 1 ? ["claude-sonnet"] : [],
                authenticated: calls.length > 1,
                auth_type: "api_key",
                key_env: "ANTHROPIC_API_KEY",
                warning: calls.length > 1 ? undefined : "paste ANTHROPIC_API_KEY to activate",
              },
            ],
          }
        },
        "model.save_key": () => ({}),
      },
    })
    await until(t, () => t.frame().includes("Anthropic"))
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("Paste ANTHROPIC_API_KEY"))
    await act(async () => { await t.keys.typeText("sk-test") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("claude-sonnet"))

    expect(calls).toEqual([
      { include_unconfigured: true },
      { refresh: true, include_unconfigured: true },
    ])
    t.destroy()
  })

  test("non-api-key unauthenticated providers warn without model.save_key", async () => {
    const saves: Array<Record<string, unknown>> = []
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": () => ({
          providers: [
            { slug: "openai", name: "OpenAI", total_models: 1, models: ["gpt-4"] },
            {
              slug: "google-oauth",
              name: "Google OAuth",
              total_models: 0,
              models: [],
              authenticated: false,
              auth_type: "oauth",
              warning: "run `hermes model` to configure (oauth)",
            },
          ],
        }),
        "model.save_key": (p) => { saves.push(p); return {} },
      },
    })
    await until(t, () => t.frame().includes("Google OAuth"))
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("run `hermes model` to configure (oauth)"))

    expect(saves).toHaveLength(0)
    expect(t.frame()).not.toContain("Switch Model (Google OAuth)")
    t.destroy()
  })

  test("Vertex auth shows setup guidance without API-key prompt", async () => {
    const saves: Array<Record<string, unknown>> = []
    const t = await mountNode(<Open />, {
      handlers: {
        "model.options": () => ({
          providers: [
            { slug: "openai", name: "OpenAI", total_models: 1, models: ["gpt-4"] },
            {
              slug: "vertex",
              name: "Vertex AI",
              total_models: 0,
              models: [],
              authenticated: false,
              auth_type: "vertex",
              key_env: "VERTEX_CREDENTIALS_PATH",
            },
          ],
        }),
        "model.save_key": (p) => { saves.push(p); return {} },
      },
    })
    await until(t, () => t.frame().includes("Vertex AI"))
    expect(t.frame()).toContain("set VERTEX_CREDENTIALS_PATH")
    expect(t.frame()).not.toContain("auth_type=vertex")
    expect(t.frame()).not.toContain("paste VERTEX_CREDENTIALS_PATH")

    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("set VERTEX_CREDENTIALS_PATH"))

    expect(saves).toHaveLength(0)
    expect(t.frame()).not.toContain("Paste VERTEX_CREDENTIALS_PATH")
    expect(t.frame()).not.toContain("Switch Model (Vertex AI)")
    t.destroy()
  })

  test("provider dialog leads with current provider and Enter selects it", async () => {
    const opts = {
      provider: "anthropic",
      model: "claude-3",
      providers: [
        { slug: "openai", name: "OpenAI", total_models: 1, models: ["gpt-4"] },
        { slug: "anthropic", name: "Anthropic", is_current: true, total_models: 2, models: ["claude-3", "claude-4"] },
      ],
    }
    const t = await mountNode(<Open />, {
      handlers: { "model.options": () => opts },
    })
    await until(t, () => t.frame().includes("Anthropic"))
    expect(t.frame().indexOf("Current")).toBeLessThan(t.frame().indexOf("Available"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Switch Model (Anthropic)"))
    expect(t.frame()).toContain("claude-3")
    t.destroy()
  })

  test("model step only marks current model for current provider", async () => {
    const opts = {
      provider: "anthropic",
      model: "shared",
      providers: [
        { slug: "anthropic", name: "Anthropic", is_current: true, total_models: 1, models: ["shared"] },
        { slug: "openai", name: "OpenAI", total_models: 2, models: ["shared", "gpt-4"] },
      ],
    }
    const t = await mountNode(<Open />, {
      handlers: { "model.options": () => opts },
    })
    await until(t, () => t.frame().includes("Anthropic"))

    act(() => t.keys.pressArrow("down"))
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Switch Model (OpenAI)"))

    const row = t.frame().split("\n").find(l => l.includes("shared")) ?? ""
    expect(row).not.toContain("●")
    t.destroy()
  })
  test("accepts provider capability metadata with optional neighbors", () => {
    const opts: ModelOptionsResponse = {
      provider: "fastlabs",
      model: "flash-reasoner",
      providers: [
        {
          slug: "fastlabs",
          name: "Fast Labs",
          total_models: 2,
          authenticated: true,
          auth_type: "api_key",
          key_env: "FASTLABS_API_KEY",
          free_tier: true,
          unavailable_models: ["legacy-slow"],
          models: ["flash-reasoner", "legacy-slow"],
          capabilities: {
            "flash-reasoner": { fast: true, reasoning: true },
            "legacy-slow": {},
          },
          pricing: {
            "flash-reasoner": { input: "$0.20/M", output: "$0.80/M", cache: null, free: false },
          },
        },
        {
          slug: "compat",
          name: "Compat Provider",
          models: ["plain-model"],
        },
      ],
    }

    const provider = opts.providers?.[0]
    const compat = opts.providers?.[1]

    expect(provider?.capabilities?.["flash-reasoner"]?.fast).toBe(true)
    expect(provider?.capabilities?.["flash-reasoner"]?.reasoning).toBe(true)
    expect(provider?.authenticated).toBe(true)
    expect(provider?.pricing?.["flash-reasoner"].cache).toBeNull()
    expect(provider?.unavailable_models).toContain("legacy-slow")
    expect(compat?.capabilities?.["plain-model"]?.fast).toBeUndefined()
    expect(compat?.pricing?.["plain-model"]).toBeUndefined()
  })

  test("model step annotates fast and reasoning capabilities", async () => {
    const t = await mountNode(<Open />, {
      handlers: { "model.options": () => OPTIONS },
    })
    await until(t, () => t.frame().includes("Anthropic"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("claude-4"))

    const claude3 = t.frame().split("\n").find(l => l.includes("claude-3")) ?? ""
    const claude4 = t.frame().split("\n").find(l => l.includes("claude-4")) ?? ""
    expect(claude3).not.toContain("fast")
    expect(claude3).not.toContain("reasoning")
    expect(claude4).toContain("fast · reasoning")
    t.destroy()
  })

})
