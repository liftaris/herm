import { describe, test, expect, afterEach } from "bun:test"
import { act } from "react"
import { mountNode, until, MockGateway } from "./harness"
import { Config } from "../src/tabs/Config"
import { buildFields, groupOf, sections, GROUPS } from "../src/config"

type H = Awaited<ReturnType<typeof mountNode>>

/** Navigate sidebar to <group>, then fields-pane to the row for <key>. */
const navTo = async (t: H, cfg: Record<string, unknown>, key: string) => {
  const g = groupOf(key)
  // +1 for the synthetic 'models' entry spliced at index 1.
  const gi = GROUPS.indexOf(g) + (GROUPS.indexOf(g) >= 1 ? 1 : 0)
  const rows = sections(g, buildFields(cfg).filter(f => groupOf(f.key) === g))
    .flatMap(s => s.items)
  const ri = rows.findIndex(f => f.key === key)
  if (gi < 0 || ri < 0) throw new Error(`navTo: ${key} not found (group=${g})`)
  act(() => { for (let i = 0; i < gi; i++) t.keys.pressArrow("down") })
  act(() => t.keys.pressTab())
  act(() => { for (let i = 0; i < ri; i++) t.keys.pressArrow("down") })
  await t.settle()
}

describe("Config tab", () => {
  afterEach(() => { delete process.env.HERMES_MANAGED })

  test("load failure surfaces the gateway error", async () => {
    const gw = new MockGateway({ "config.get": () => { throw new Error("config unavailable") } })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("config unavailable"))
    t.destroy()
  })

  test("late initial load cannot erase a local draft", async () => {
    let resolve!: (value: unknown) => void
    const gw = new MockGateway({ "config.get": () => new Promise(done => { resolve = done }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, {}, "terminal.container_persistent")
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("1 unsaved"))

    resolve({ config: { terminal: { container_persistent: false } } })
    await act(async () => { await Bun.sleep(0) })
    await t.settle()
    expect(t.frame()).toContain("1 unsaved")
    expect(t.frame()).toContain("✓ ON")
    t.destroy()
  })

  test("every schema key renders; defaults shown with empty user config", async () => {
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    for (const g of ["general", "agent", "terminal", "compression", "platforms"])
      expect(t.frame()).toContain(g)
    await navTo(t, {}, "compression.threshold")
    expect(t.frame()).toMatch(/threshold\s+0\.5/)
    // Doc line under selected row.
    let lines = t.frame().split("\n")
    let i = lines.findIndex(l => l.includes("▸") && l.includes("threshold"))
    expect(lines[i + 1]).toMatch(/compress when/i)

    t.destroy()
  })

  test("onboarding profile build renders as a selectable general field", async () => {
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, {}, "onboarding.profile_build")
    expect(t.frame()).toMatch(/profile_build\s+ask/)
    expect(t.frame()).toContain("[h/l]")
    const lines = t.frame().split("\n")
    const i = lines.findIndex(l => l.includes("▸") && l.includes("profile_build"))
    expect(lines.slice(i + 1, i + 4).join(" ")).toMatch(/profile-build path/i)
    t.destroy()
  })

  test("new upstream keys render and search with controls", async () => {
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))

    await navTo(t, {}, "agent.verify_on_stop")
    expect(t.frame()).toMatch(/verify_on_stop\s+auto/)
    expect(t.frame()).toContain("[h/l]")
    expect(t.frame()).toMatch(/Verification closure/i)

    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    await act(async () => { await t.keys.typeText("platform_connect_timeout") })
    await until(t, () => t.frame().includes("platform_connect_timeout"))
    expect(t.frame()).toContain("gateway")
    expect(t.frame()).toMatch(/platform_connect_timeout\s+30/)

    act(() => t.keys.pressEscape())
    await t.settle()
    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    await act(async () => { await t.keys.typeText("friendly_tool_labels") })
    await until(t, () => t.frame().includes("friendly_tool_labels"))
    expect(t.frame()).toContain("display")
    expect(t.frame()).toMatch(/✓ ON/)

    act(() => t.keys.pressEscape())
    await t.settle()
    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    await act(async () => { await t.keys.typeText("vertex") })
    await until(t, () => t.frame().includes("project_id") && t.frame().includes("region"))
    expect(t.frame()).toContain("vertex")
    expect(t.frame()).toMatch(/region\s+global/)

    t.destroy()
  })

  test("user-set value shows '·' gutter dot; default doesn't", async () => {
    const cfg = { compression: { threshold: 0.7 } }
    const gw = new MockGateway({ "config.get": () => ({ config: cfg }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, cfg, "compression.threshold")
    const lines = t.frame().split("\n")
    const thr = lines.find(l => l.includes("threshold") && l.includes("0.7"))!
    const ratio = lines.find(l => l.includes("target_ratio"))!
    expect(thr).toMatch(/·\s+▸?\s*threshold/)
    expect(ratio).not.toContain("·")
    t.destroy()
  })

  test("list/dict key is read-only: '<N items>' + 🔒, Enter is a no-op", async () => {
    const cfg = { terminal: { docker_volumes: ["/a:/b", "/c:/d"] } }
    const gw = new MockGateway({ "config.get": () => ({ config: cfg }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, cfg, "terminal.docker_volumes")
    expect(t.frame()).toContain("2 items")
    expect(t.frame()).toContain("🔒")
    expect(t.frame()).toContain("⟳")   // restart-tier glyph on selected row
    act(() => t.keys.pressEnter())
    await t.settle()
    // v1: structured values are locked — no YAML-mode bounce, no edit buf.
    expect(t.frame()).not.toContain("Config · YAML")
    expect(t.frame()).toContain("2 items")
    t.destroy()
  })

  test("toggle dirties; Ctrl+S → cli.exec; restart-tier opens confirm", async () => {
    let cfg: Record<string, unknown> = { terminal: { container_persistent: false } }
    const restarts: string[] = []
    const gw = new MockGateway({
      "config.get": () => ({ config: cfg }),
      "cli.exec": (p) => {
        const [, , k, v] = p.argv as string[]
        if (k === "terminal.container_persistent")
          cfg = { terminal: { container_persistent: v === "true" } }
        return { blocked: false, code: 0, output: "✓" }
      },
    })
    gw.on("restart", mode => { restarts.push(mode) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, cfg, "terminal.container_persistent")
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("1 unsaved"))
    expect(t.frame()).toContain("✓ ON")

    act(() => t.keys.pressKey("s", { ctrl: true }))
    await until(t, () => t.frame().includes("Write 1 change to config.yaml?"))
    expect(t.frame()).toContain("terminal.container_persistent: false → true")

    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => gw.last("cli.exec") !== undefined)
    expect(gw.last("cli.exec")?.params.argv)
      .toEqual(["config", "set", "terminal.container_persistent", "true"])
    expect(gw.last("config.set")).toBeUndefined()

    await until(t, () => t.frame().includes("need a gateway restart"))
    expect(t.frame()).toContain("interrupts any running turn")
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => restarts.length === 1)
    expect(restarts).toEqual(["resume"])
    await t.settle()
    expect(t.frame()).not.toContain("unsaved")
    t.destroy()
  })

  test("readback failure after save surfaces without losing the draft", async () => {
    const cfg = { terminal: { container_persistent: false } }
    let gets = 0
    const gw = new MockGateway({
      "config.get": () => {
        if (gets++ === 0) return { config: cfg }
        throw new Error("readback unavailable")
      },
      "cli.exec": () => ({ blocked: false, code: 0, output: "✓" }),
    })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, cfg, "terminal.container_persistent")
    await act(async () => { await t.keys.typeText(" ") })
    await until(t, () => t.frame().includes("1 unsaved"))
    act(() => t.keys.pressKey("s", { ctrl: true }))
    await until(t, () => t.frame().includes("Write 1 change to config.yaml?"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("readback unavailable"))
    expect(t.frame()).toContain("1 unsaved")
    t.destroy()
  })

  test("Ctrl+S with no changes toasts 'No changes', no dialog", async () => {
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    act(() => t.keys.pressKey("s", { ctrl: true }))
    await until(t, () => t.frame().includes("No changes"))
    expect(t.frame()).not.toContain("Write")
    expect(gw.last("cli.exec")).toBeUndefined()
    t.destroy()
  })

  test("same-frame boolean toggles preserve the original draft", async () => {
    const cfg = { terminal: { container_persistent: false } }
    const gw = new MockGateway({ "config.get": () => ({ config: cfg }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, cfg, "terminal.container_persistent")

    act(() => {
      void t.keys.typeText(" ")
      void t.keys.typeText(" ")
    })
    await t.settle()
    expect(t.frame()).not.toContain("unsaved")
    t.destroy()
  })

  test("same-frame edit and save reads the live draft", async () => {
    const cfg = { terminal: { container_persistent: false } }
    const gw = new MockGateway({ "config.get": () => ({ config: cfg }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, cfg, "terminal.container_persistent")
    act(() => {
      void t.keys.typeText(" ")
      t.keys.pressKey("s", { ctrl: true })
    })
    await until(t, () => t.frame().includes("Write 1 change to config.yaml?"))
    expect(t.frame()).not.toContain("No changes")
    t.destroy()
  })

  // '/' collapses the categories pane; query row sits above the results
  // shell; each hit carries its resolved group badge.
  test("search: single-pane, query row above, group badge per hit", async () => {
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    const panes = () => t.frame().split("\n")
      .filter(l => l.includes("┌")).flatMap(l => l.match(/┌/g)!).length

    expect(panes()).toBe(2)
    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    expect(panes()).toBe(1)
    expect(t.frame()).toContain("Category")
    const lines = t.frame().split("\n")
    expect(lines.findIndex(l => l.includes("┃"))).toBeLessThan(lines.findIndex(l => l.includes("┌")))

    await act(async () => { await t.keys.typeText("threshold") })
    await t.settle()
    expect(t.frame()).toMatch(/compression\s+threshold/)
    expect(t.frame()).not.toContain("max_turns")

    act(() => t.keys.pressEscape())
    await t.settle()
    expect(panes()).toBe(2)
    t.destroy()
  })

  test("inline validation: bad value blocks commit, shows error, clears on fix", async () => {
    const cfg = { agent: { max_turns: 90 } }
    const gw = new MockGateway({ "config.get": () => ({ config: cfg }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("general"))
    await navTo(t, cfg, "agent.max_turns")

    act(() => t.keys.pressEnter())
    await t.settle()
    await act(async () => { for (let i = 0; i < 2; i++) t.keys.pressBackspace() })
    await act(async () => { await t.keys.typeText("0") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("✗ expected"))
    expect(t.frame()).toContain("✗ expected 1–10000")
    expect(t.frame()).not.toContain("unsaved")

    await act(async () => { t.keys.pressBackspace() })
    await act(async () => { await t.keys.typeText("5") })
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.frame()).not.toContain("✗ expected")
    await until(t, () => t.frame().includes("1 unsaved"))
    t.destroy()
  })

  test("managed install: read-only, edits blocked, notice shown", async () => {
    process.env.HERMES_MANAGED = "nixos"
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 48 })
    await until(t, () => t.frame().includes("managed install"))
    expect(t.frame()).toContain("read-only · managed by NixOS")
    expect(t.frame()).toContain("configuration.nix")

    await navTo(t, {}, "terminal.container_persistent")
    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    expect(t.frame()).not.toContain("unsaved")
    expect(t.frame()).toContain("🔒")

    act(() => t.keys.pressKey("s", { ctrl: true }))
    await until(t, () => t.frame().includes("Managed by NixOS"))
    expect(t.frame()).not.toContain("Write")
    expect(gw.last("cli.exec")).toBeUndefined()
    expect(gw.last("config.set")).toBeUndefined()
    t.destroy()
  })

  // 907.9: left pane needs its own scroll-follow ref. With a short viewport,
  // categories past the fold must scroll into view when arrow-nav reaches
  // them — previously the highlight updated but the scrollbox didn't move,
  // making it look like only the right pane was changing.
  test("categories pane scrolls to keep highlight visible", async () => {
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 120, height: 14 })
    await until(t, () => t.frame().includes("general"))

    // Initial state: first category (`general`) visible, last hidden.
    const first = GROUPS[0]
    const last = GROUPS[GROUPS.length - 1]
    expect(t.frame()).toContain(first)
    expect(t.frame()).not.toContain(last)

    // Arrow down through every category. After the last press, the
    // scrollbox must have followed the selection, revealing `last`.
    for (let i = 0; i < GROUPS.length; i++) {
      act(() => t.keys.pressArrow("down"))
    }
    await t.settle(); await t.settle()
    expect(t.frame()).toContain(last)
    t.destroy()
  })

  // 11237112: Tab walks focus categories↔fields; mode-swap moved off Tab
  // to mnemonic `m`. Old pane-swap on ←→ is removed.
  test("Tab walks focus categories↔fields; m toggles form↔yaml mode", async () => {
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("general"))

    // Boot: two panes visible, left pane focused — form mode, not YAML.
    expect(t.frame()).not.toContain("Config · YAML")
    // Footer hint reflects focused pane: boot = categories → advertises Tab→fields.
    expect(t.frame()).toContain("[Tab] fields")

    // Tab → focus moves to fields pane. The right pane's focus border
    // is a visual signal; the hint is a stable string to assert on.
    act(() => t.keys.pressTab()); await t.settle()
    // Footer flips to advertise Tab→categories once fields are focused.
    expect(t.frame()).toContain("[Tab] categories")
    // Field rows are active now; arrow-down moves cursor, not category.
    // Easiest observable: a FieldRow carries a ▸ caret when focus=fields.
    const f = t.frame()
    // First field of `general` is selected; the row has the caret glyph.
    expect(f.split("\n").some(l => /▸.*\w/.test(l) && !l.includes("general"))).toBe(true)

    // Shift+Tab → back to categories.
    act(() => t.keys.pressTab({ shift: true })); await t.settle()
    // Category row now carries the caret.
    expect(t.frame().split("\n").some(l => l.includes("▸") && l.includes("general"))).toBe(true)

    // m toggles mode — enters YAML.
    await act(async () => { await t.keys.typeText("m") })
    await until(t, () => t.frame().includes("Config · YAML"))
    // m again → back to form.
    await act(async () => { await t.keys.typeText("m") })
    await until(t, () => !t.frame().includes("Config · YAML"))
    expect(t.frame()).toContain("general")
    t.destroy()
  })

  test("←→ no longer swaps panes (dropped in favor of Tab)", async () => {
    const gw = new MockGateway({ "config.get": () => ({ config: {} }) })
    const t = await mountNode(<Config focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("general"))
    // Boot: categories pane focused (caret on 'general').
    expect(t.frame().split("\n").some(l => l.includes("▸") && l.includes("general"))).toBe(true)
    // → should be a no-op now; caret stays on 'general' in categories.
    act(() => t.keys.pressArrow("right")); await t.settle()
    expect(t.frame().split("\n").some(l => l.includes("▸") && l.includes("general"))).toBe(true)
    t.destroy()
  })
})
