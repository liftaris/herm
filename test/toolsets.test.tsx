import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mountNode, until, MockGateway } from "./harness"
import { Toolsets } from "../src/tabs/Toolsets"

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

const SETS = [
  { name: "file", description: "read/write files", tool_count: 7, enabled: true },
  { name: "web", description: "search & fetch", tool_count: 2, enabled: false },
  { name: "hermes-cli", description: "cli platform bundle", tool_count: 38, enabled: true },
  { name: "hermes-discord", description: "discord platform bundle", tool_count: 40, enabled: false },
  { name: "mcp:linear", description: "linear mcp", tool_count: 5, enabled: true },
]

describe("Toolsets tab", () => {
  test("groups by core/platform/mcp with ─ section headers", async () => {
    const gw = new MockGateway({ "toolsets.list": () => ({ toolsets: SETS }) })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (5)"))
    const f = strip(t.frame())
    expect(f).toContain("─ core (2)")
    expect(f).toContain("─ platform bundles (2)")
    expect(f).toContain("─ mcp (1)")
    t.destroy()
  })

  test("renders status glyphs", async () => {
    const gw = new MockGateway({ "toolsets.list": () => ({ toolsets: SETS }) })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (5)"))
    const f = strip(t.frame())
    expect(f).toContain("● file")
    expect(f).toContain("○ web")
    expect(f).toContain("[Space] toggle")
    // no expand affordance now that detail pane is the single surface
    expect(f).not.toMatch(/\bexpand\b/)
    t.destroy()
  })

  test("Space → tools.configure with correct action + names in flat order", async () => {
    const gw = new MockGateway({
      "toolsets.list": () => ({ toolsets: SETS }),
      // Default handler — accepts every name and reflects the flip in
      // enabled_toolsets so herm's reconcile path stays deterministic
      // across successive toggles.
      "tools.configure": p => {
        const on = new Set(SETS.filter(t => t.enabled).map(t => t.name))
        if (p.action === "enable") (p.names as string[]).forEach(n => on.add(n))
        else (p.names as string[]).forEach(n => on.delete(n))
        return { changed: p.names, enabled_toolsets: [...on], missing_servers: [], unknown: [] }
      },
    })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (5)"))

    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    expect(t.gw.last("tools.configure")?.params)
      .toMatchObject({ action: "disable", names: ["file"] })

    act(() => t.keys.pressArrow("down"))
    await t.settle()
    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    expect(t.gw.last("tools.configure")?.params)
      .toMatchObject({ action: "enable", names: ["web"] })

    // ↓ crosses the section header into platform bundles
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    expect(t.gw.last("tools.configure")?.params)
      .toMatchObject({ action: "disable", names: ["hermes-cli"] })
    t.destroy()
  })

  test("available=false → ◌ glyph, Space refuses", async () => {
    const gw = new MockGateway({ "toolsets.list": () => ({ toolsets: [
      { name: "spotify", description: "music", tool_count: 7, enabled: false, available: false },
    ] }) })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (1)"))
    expect(strip(t.frame())).toContain("◌ spotify")
    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    expect(t.gw.last("tools.configure")).toBeUndefined()
    t.destroy()
  })

  // 4no: gateway's tools.configure only persists names in its whitelist
  // (hermes_cli/tools_config.py CONFIGURABLE_TOOLSETS + plugin keys).
  // Platform bundles like hermes-cli land in response.unknown → herm must
  // revert the optimistic flip and surface the reason.
  test("unknown names in response → revert flip + warning toast", async () => {
    const gw = new MockGateway({
      "toolsets.list": () => ({ toolsets: SETS }),
      "tools.configure": p => ({
        changed: [],
        enabled_toolsets: SETS.filter(t => t.enabled).map(t => t.name),
        missing_servers: [],
        unknown: p.names as string[],
      }),
    })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (5)"))

    // navigate to hermes-cli (core:2 + platform:0 = flat index 2)
    for (let i = 0; i < 2; i++) act(() => t.keys.pressArrow("down"))
    await t.settle()
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("not configurable"))

    // still ● (enabled) — revert worked
    const f = strip(t.frame())
    expect(f).toMatch(/●\s+hermes-cli/)
    expect(t.gw.last("tools.configure")?.params).toMatchObject({
      action: "disable", names: ["hermes-cli"],
    })
    t.destroy()
  })

  // 4no: on success, reconcile from response.enabled_toolsets instead of
  // round-tripping toolsets.list (which reads stale agent state).
  test("reconciles list enabled flags from response.enabled_toolsets", async () => {
    let stale = true
    const gw = new MockGateway({
      // Toolsets.list returns STALE data — proves reconcile path is used.
      "toolsets.list": () => ({ toolsets: stale ? SETS : [] }),
      "tools.configure": p => {
        stale = false
        const on = new Set(SETS.filter(t => t.enabled).map(t => t.name))
        if (p.action === "enable") (p.names as string[]).forEach(n => on.add(n))
        else (p.names as string[]).forEach(n => on.delete(n))
        return { changed: p.names, enabled_toolsets: [...on], missing_servers: [], unknown: [] }
      },
    })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (5)"))

    // Toggle `file` off (starts enabled).
    await act(async () => { await t.keys.typeText(" ") })
    await t.settle(); await t.settle()
    const f = strip(t.frame())
    // `file` now ○ — and crucially, `web` is still ○ + `hermes-cli` still ●
    // (proof we reconciled from the response, not from the stale [] list).
    expect(f).toMatch(/○\s+file\b/)
    expect(f).toMatch(/●\s+hermes-cli/)
    t.destroy()
  })

  test("rapid toggles serialize and preserve the newer choice", async () => {
    let first!: (value: unknown) => void
    let second!: (value: unknown) => void
    let requests = 0
    const gw = new MockGateway({
      "toolsets.list": () => ({ toolsets: SETS }),
      "tools.configure": () => new Promise(resolve => {
        if (requests++ === 0) first = resolve
        else second = resolve
      }),
    })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (5)"))

    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    expect(gw.calls.filter(c => c.method === "tools.configure").map(c => c.params.action))
      .toEqual(["disable"])

    first({ changed: ["file"], enabled_toolsets: ["hermes-cli", "mcp:linear"], missing_servers: [], unknown: [] })
    await until(t, () => gw.calls.filter(c => c.method === "tools.configure").length === 2)
    expect(gw.last("tools.configure")?.params.action).toBe("enable")
    second({ changed: ["file"], enabled_toolsets: ["file", "hermes-cli", "mcp:linear"], missing_servers: [], unknown: [] })
    await act(async () => { await Bun.sleep(0) })
    await t.settle()

    expect(strip(t.frame())).toMatch(/●\s+file\b/)
    t.destroy()
  })

  test("failed serialized toggles restore the last authoritative state", async () => {
    let failFirst!: (error: Error) => void
    let failSecond!: (error: Error) => void
    let requests = 0
    const gw = new MockGateway({
      "toolsets.list": () => ({ toolsets: [SETS[0]] }),
      "tools.configure": () => new Promise((_, reject) => {
        if (requests++ === 0) failFirst = reject
        else failSecond = reject
      }),
    })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (1)"))
    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    await act(async () => { await t.keys.typeText(" ") })
    failFirst(new Error("first failed"))
    await until(t, () => requests === 2)
    failSecond(new Error("second failed"))
    await until(t, () => t.frame().includes("second failed"))

    expect(strip(t.frame())).toMatch(/●\s+file\b/)
    t.destroy()
  })

  test("same-frame double toggle preserves the original state", async () => {
    let enabled = true
    const actions: string[] = []
    const gw = new MockGateway({
      "toolsets.list": () => ({ toolsets: [SETS[0]] }),
      "tools.configure": p => {
        actions.push(p.action as string)
        enabled = p.action === "enable"
        return { changed: ["file"], enabled_toolsets: enabled ? ["file"] : [], missing_servers: [], unknown: [] }
      },
    })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (1)"))

    act(() => {
      void t.keys.typeText(" ")
      void t.keys.typeText(" ")
    })
    await until(t, () => actions.length > 0)
    await t.settle()

    expect(actions.at(-1)).toBe("enable")
    expect(strip(t.frame())).toMatch(/●\s+file\b/)
    t.destroy()
  })

  test("stale refresh cannot overwrite a completed toggle", async () => {
    let refresh!: (value: unknown) => void
    let lists = 0
    const gw = new MockGateway({
      "toolsets.list": () => {
        if (lists++ === 0) return { toolsets: SETS }
        return new Promise(resolve => { refresh = resolve })
      },
      "tools.configure": () => ({
        changed: ["file"],
        enabled_toolsets: ["hermes-cli", "mcp:linear"],
        missing_servers: [],
        unknown: [],
      }),
    })
    const t = await mountNode(<Toolsets focused />, { gw })
    await until(t, () => t.frame().includes("Toolsets (5)"))

    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => lists === 2)
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => strip(t.frame()).match(/○\s+file\b/) !== null)
    refresh({ toolsets: SETS })
    await act(async () => { await Bun.sleep(0) })
    await t.settle()

    expect(strip(t.frame())).toMatch(/○\s+file\b/)
    t.destroy()
  })

  test("detail pane shows includes/requirements/tools when wire provides them", async () => {
    const gw = new MockGateway({ "toolsets.list": () => ({ toolsets: [
      { name: "safe", description: "read-only bundle", tool_count: 5, enabled: true,
        includes: ["web", "vision"], requirements: ["EXA_API_KEY"],
        tools: ["web_search", "web_extract", "vision_analyze"] },
    ] }) })
    const t = await mountNode(<Toolsets focused />, { gw, width: 180 })
    await until(t, () => t.frame().includes("Toolsets (1)"))
    const f = strip(t.frame())
    expect(f).toContain("web, vision")
    expect(f).toContain("EXA_API_KEY")
    expect(f).toContain("Tools (3):")
    expect(f).toContain("· web_search")
    t.destroy()
  })

  // o3d: scroll follows selection at the viewport edge. With 30 rows in
  // a short viewport, row-29 is clipped; End key → selection jumps to it
  // and scrollChildIntoView brings it into frame.
  test("scroll follows selection (End reveals last row)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `ts-${String(i).padStart(2, "0")}`, description: "", tool_count: i, enabled: true,
    }))
    const gw = new MockGateway({ "toolsets.list": () => ({ toolsets: many }) })
    const t = await mountNode(<Toolsets focused />, { gw, width: 160, height: 18 })
    await until(t, () => t.frame().includes("Toolsets (30)"))
    expect(strip(t.frame())).not.toContain("ts-29")

    act(() => t.keys.pressKey("END"))
    await t.settle(); await t.settle()
    const f = strip(t.frame())
    expect(f).toContain("▸ ● ts-29")
    expect(f).not.toContain("ts-00")
    t.destroy()
  })
})
