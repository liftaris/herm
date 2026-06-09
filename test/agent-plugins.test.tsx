import { describe, expect, test } from "bun:test"
import { act } from "react"
import { CONFIG_TAB, SUB_TABS, TAB_SLASH } from "../src/app/tabs"
import { AgentPlugins } from "../src/tabs/AgentPlugins"
import { mountNode, until, MockGateway } from "./harness"

describe("Agent Plugins tab", () => {
  test("renders upstream plugin rows and toggles through plugins.manage", async () => {
    const gw = new MockGateway({
      "plugins.manage": p => {
        if (p.action === "toggle") return {
          name: p.name as string,
          version: "1.2.3",
          description: "captures traces",
          source: "user",
          status: p.enable ? "enabled" : "disabled",
        }
        return {
          user_count: 1,
          bundled_count: 1,
          plugins: [
            { name: "langfuse", version: "1.2.3", description: "captures traces", source: "user", status: "disabled" },
            { name: "memory", version: "0.4.0", description: "memory provider", source: "bundled", status: "enabled" },
          ],
        }
      },
    })

    const t = await mountNode(<AgentPlugins focused />, { gw, width: 170, height: 34 })
    await until(t, () => t.frame().includes("langfuse") && t.frame().includes("memory"))

    expect(t.frame()).toContain("Upstream Hermes Agent plugins")
    expect(t.frame()).toContain("user 1")
    expect(t.frame()).toContain("bundled 1")
    expect(t.frame()).toContain("not Herm UI extensions")

    act(() => t.keys.pressEnter())
    await until(t, () => gw.calls.some(c => c.method === "plugins.manage" && c.params.action === "toggle"))
    expect(gw.last("plugins.manage")?.params).toEqual({ action: "toggle", name: "langfuse", enable: true })
    await until(t, () => t.frame().includes("enabled"))
    t.destroy()
  })

  test("/plugins routes to Config Plugins without moving plugin subcommands", () => {
    expect(SUB_TABS[CONFIG_TAB][TAB_SLASH.plugins.sub]).toBe("Plugins")
    expect(TAB_SLASH.plugins).toEqual({ tab: CONFIG_TAB, sub: 5 })
    expect(TAB_SLASH.env).toEqual({ tab: CONFIG_TAB, sub: 3 })
    expect(TAB_SLASH.memory).toEqual({ tab: CONFIG_TAB, sub: 4 })
  })
})
