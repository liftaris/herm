import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { act } from "react"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mountNode, until, MockGateway } from "./harness"
import { Agents } from "../src/tabs/Agents"
import {
  listProfiles, validateName, activeProfileName, profileNameFrom, stickyDefault, profileStats,
  readDistributionManifest,
} from "../src/service/hermes-profiles"
import type { DelegationRecord, DelegationStatus } from "../src/context/wire"

// ─── fixture ─────────────────────────────────────────────────────────

let ROOT: string
let PREV: string | undefined

const mkProfile = (name: string, cfg: Record<string, unknown>) => {
  const d = name === "default" ? ROOT : join(ROOT, "profiles", name)
  mkdirSync(join(d, "skills"), { recursive: true })
  const body = "model:\n" + Object.entries(cfg).map(([k, v]) => `  ${k}: ${v}`).join("\n") + "\n"
  writeFileSync(join(d, "config.yaml"), body)
  return d
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "herm-agents-"))
  PREV = process.env.HERMES_HOME
  process.env.HERMES_HOME = ROOT
  mkProfile("default", { default: "test-model", provider: "anthropic" })
  writeFileSync(join(ROOT, "SOUL.md"), "# Default Soul\n\nI am default.\nSecond line.")
  writeFileSync(join(ROOT, ".env"), "FOO=bar")
  mkdirSync(join(ROOT, "skills", "a"), { recursive: true })
  writeFileSync(join(ROOT, "skills", "a", "SKILL.md"), "---\nname: a\n---")
  mkProfile("coder", { default: "claude-4", provider: "anthropic" })
})

afterEach(() => {
  process.env.HERMES_HOME = PREV
  try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ─── hermes-profiles.ts ──────────────────────────────────────────────

describe("hermes-profiles", () => {
  test("listProfiles reads root + profiles/, strips H1 from soul preview", async () => {
    const ps = await listProfiles()
    expect(ps.map(p => p.name)).toEqual(["default", "coder"])
    const def = ps[0]
    expect(def.is_default).toBe(true)
    expect(def.is_active).toBe(true)
    expect(def.is_sticky).toBe(false)
    expect(def.model).toBe("test-model")
    expect(def.provider).toBe("anthropic")
    expect(def.has_env).toBe(true)
    expect(def.skill_count).toBe(1)
    // H1 heading stripped.
    expect(def.soul_preview).not.toContain("# Default Soul")
    expect(def.soul_preview.startsWith("I am default.")).toBe(true)
    // Source provenance.
    expect(def.sources.config.file).toBe(join(ROOT, "config.yaml"))
    expect(def.sources.soul.label).toBe("SOUL.md")
    expect(ps[1].is_active).toBe(false)
    expect(ps[1].model).toBe("claude-4")
    expect(activeProfileName()).toBe("default")
  })

  test("activeProfileName when running under a named profile", async () => {
    process.env.HERMES_HOME = join(ROOT, "profiles", "coder")
    expect(activeProfileName()).toBe("coder")
    const ps = await listProfiles()
    expect(ps.find(p => p.name === "coder")?.is_active).toBe(true)
    expect(ps.find(p => p.name === "default")?.is_active).toBe(false)
  })

  test("is_active honors gateway-reported home over process env", async () => {
    // Herm's process runs under default, but the gateway says 'coder'.
    expect(profileNameFrom(join(ROOT, "profiles", "coder"))).toBe("coder")
    const ps = await listProfiles(join(ROOT, "profiles", "coder"))
    expect(ps.find(p => p.name === "coder")?.is_active).toBe(true)
    expect(ps.find(p => p.name === "default")?.is_active).toBe(false)
  })

  test("sticky default read from <root>/active_profile", async () => {
    expect(stickyDefault()).toBeNull()
    writeFileSync(join(ROOT, "active_profile"), "coder\n")
    expect(stickyDefault()).toBe("coder")
    const ps = await listProfiles()
    expect(ps.find(p => p.name === "coder")?.is_sticky).toBe(true)
    expect(ps.find(p => p.name === "default")?.is_sticky).toBe(false)
  })

  test("validateName", () => {
    expect(validateName("ok-name_1", ["x"])).toBeNull()
    expect(validateName("Bad", [])).toMatch(/must match/)
    expect(validateName("coder", ["coder"])).toBe("already exists")
    expect(validateName("default", [])).toBe("reserved name")
  })

  test("profileStats reads state.db + cron/jobs.json + herm/tui.json; nulls when absent", async () => {
    // Bare profile: no state.db, no cron, no herm dir → nulls.
    const bare = await profileStats(join(ROOT, "profiles", "coder"))
    expect(bare).toEqual({ sessions: null, messages: null, crons: null, prefs: null })

    // Seed default with a state.db and jobs.json.
    const { Database } = await import("bun:sqlite")
    const db = new Database(join(ROOT, "state.db"))
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, message_count INT)")
    db.run("INSERT INTO sessions VALUES ('a', 4), ('b', 0), ('c', 7)")
    db.close()
    mkdirSync(join(ROOT, "cron"), { recursive: true })
    writeFileSync(join(ROOT, "cron", "jobs.json"),
      JSON.stringify({ jobs: [{ id: "j1" }, { id: "j2" }] }))
    mkdirSync(join(ROOT, "herm"), { recursive: true })
    writeFileSync(join(ROOT, "herm", "tui.json"),
      JSON.stringify({ theme: "liminal", eikon: "herm", keys: { "list.new": "a" } }))

    const s = await profileStats(ROOT)
    expect(s.sessions).toBe(2)   // message_count > 0
    expect(s.messages).toBe(11)
    expect(s.crons).toBe(2)
    expect(s.prefs).toEqual({ theme: "liminal", eikon: "herm", keys: 1 })

    // Array-shaped jobs.json also supported.
    writeFileSync(join(ROOT, "cron", "jobs.json"), JSON.stringify([{ id: "j1" }]))
    expect((await profileStats(ROOT)).crons).toBe(1)
  })

  test("readDistributionManifest: absent → null; populated → normalized manifest", async () => {
    const dir = join(ROOT, "profiles", "coder")

    // No distribution.yaml → null.
    expect(readDistributionManifest(dir)).toBeNull()

    // Full manifest → normalized shape with defaults applied.
    writeFileSync(join(dir, "distribution.yaml"), [
      "name: acme-coder",
      "version: 1.2.3",
      "description: Coding profile",
      "hermes_requires: \">=0.5\"",
      "author: Acme",
      "license: MIT",
      "source: https://github.com/acme/coder",
      "installed_at: 2026-05-10T12:00:00Z",
      "env_requires:",
      "  - name: ACME_KEY",
      "    description: API key",
      "  - name: ACME_OPTIONAL",
      "    required: false",
      "    default: fallback",
      "distribution_owned:",
      "  - skills/",
      "  - SOUL.md",
      "",
    ].join("\n"))
    const m = readDistributionManifest(dir)
    expect(m).not.toBeNull()
    expect(m!.name).toBe("acme-coder")
    expect(m!.version).toBe("1.2.3")
    expect(m!.hermes_requires).toBe(">=0.5")
    expect(m!.license).toBe("MIT")
    expect(m!.source).toBe("https://github.com/acme/coder")
    expect(m!.installed_at).toBe("2026-05-10T12:00:00Z")
    expect(m!.env_requires).toEqual([
      { name: "ACME_KEY", description: "API key", required: true, default: null },
      { name: "ACME_OPTIONAL", description: "", required: false, default: "fallback" },
    ])
    expect(m!.distribution_owned).toEqual(["skills", "SOUL.md"])

    // Missing name → rejected (null).
    writeFileSync(join(dir, "distribution.yaml"), "version: 1.0.0\n")
    expect(readDistributionManifest(dir)).toBeNull()

    // Parse-fail (invalid yaml) → null, does not throw.
    writeFileSync(join(dir, "distribution.yaml"), "name: [unterminated\n")
    expect(() => readDistributionManifest(dir)).not.toThrow()
    expect(readDistributionManifest(dir)).toBeNull()
  })

  test("listProfiles surfaces distribution on profiles that have a manifest", async () => {
    // default has no manifest; coder does.
    writeFileSync(join(ROOT, "profiles", "coder", "distribution.yaml"),
      "name: acme-coder\nversion: 0.9.0\n")
    const ps = await listProfiles()
    const def = ps.find(p => p.name === "default")!
    const coder = ps.find(p => p.name === "coder")!
    expect(def.distribution).toBeNull()
    expect(coder.distribution?.name).toBe("acme-coder")
    expect(coder.distribution?.version).toBe("0.9.0")
    // Source provenance for FileLink.
    expect(coder.sources.distribution.file)
      .toBe(join(ROOT, "profiles", "coder", "distribution.yaml"))
    expect(coder.sources.distribution.label).toBe("distribution.yaml")
  })
})

// ─── Agents tab ──────────────────────────────────────────────────────

const T0 = () => Date.now() / 1000 - 95
// Intentionally out of tree order to exercise preorder().
const RECS = (): DelegationRecord[] => [
  { subagent_id: "s2", parent_id: "s1", depth: 1, goal: "sub: scan repo",
    model: "haiku", started_at: T0(), tool_count: 2 },
  { subagent_id: "s1", parent_id: null, depth: 0, goal: "root: refactor",
    model: "sonnet", started_at: T0(), tool_count: 7 },
  { subagent_id: "s3", parent_id: null, depth: 0, goal: "root: docs",
    model: "sonnet", started_at: T0(), tool_count: 1 },
]
const STATUS = (over: Partial<DelegationStatus> = {}): DelegationStatus => ({
  active: RECS(), paused: false, max_spawn_depth: 2, max_concurrent_children: 3, ...over,
})

describe("Agents tab", () => {
  test("delegation load failure is visible", async () => {
    const gw = new MockGateway({
      "delegation.status": () => { throw new Error("delegation unavailable") },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("delegation unavailable"))
    t.destroy()
  })

  test("late delegation poll cannot replace a newer snapshot", async () => {
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const stale = STATUS({ active: [{ ...RECS()[0], goal: "stale delegation" }] })
    const gw = new MockGateway({
      "delegation.status": () => calls++ === 0 ? gate.then(() => stale) : STATUS({ active: [] }),
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => calls === 1)
    act(() => gw.push({ type: "subagent.start", payload: { subagent_id: "new", task_index: 0, goal: "new" } }))
    await until(t, () => calls === 2 && t.frame().includes("Delegation (0)"))

    release()
    await gate
    await t.settle()
    expect(t.frame()).not.toContain("stale delegation")
    t.destroy()
  })

  test("loads profiles (fs) + delegation (RPC), preorder sort; is_active from gateway", async () => {
    const gw = new MockGateway({
      "delegation.status": () => STATUS(),
      // Gateway claims 'coder' is the active home, regardless of herm's env.
      "config.get": p => p.key === "profile"
        ? { home: join(ROOT, "profiles", "coder"), display: "coder" }
        : p.key === "full" ? { config: {} } : {},
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    const f = t.frame()
    expect(f).toContain("default")
    expect(f).toContain("coder")
    expect(f).toContain(" you")
    // Active row == coder (gateway's home), not default (process env).
    const rowCoder = f.split("\n").find(l => /▸?\s+coder/.test(l))!
    expect(rowCoder).toContain("you")
    // <markdown> resolves tree-sitter async — wait for body to paint.
    await until(t, () => t.frame().includes("I am default."))
    expect(t.frame()).not.toContain("# Default Soul")
    // FileLinks render labels.
    expect(f).toContain("config.yaml")
    expect(f).toContain("SOUL.md")
    expect(f).toContain("Delegation (3)")
    expect(f).toContain("root: refactor")
    expect(f).toContain("· sub: scan repo")
    expect(f).toContain("1m35s")
    expect(f.indexOf("root: refactor")).toBeLessThan(f.indexOf("sub: scan repo"))
    expect(f.indexOf("sub: scan repo")).toBeLessThan(f.indexOf("root: docs"))
    expect(t.gw.last("delegation.status")).toBeDefined()
    expect(t.gw.last("config.get")?.params.key).toBe("profile")
    // Lazy stats: no state.db in fixture → Sessions row shows dash.
    await until(t, () => /Sessions\s+—/.test(t.frame()))
    t.destroy()
  })

  test("sticky default badged in row + title", async () => {
    writeFileSync(join(ROOT, "active_profile"), "coder\n")
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw: new MockGateway(), width: 200 })
    await until(t, () => t.frame().includes("★"))
    const f = t.frame()
    expect(f).toContain("★ coder")
    const row = f.split("\n").find(l => l.includes("coder") && l.includes("★"))
    expect(row).toBeDefined()
    t.destroy()
  })

  test("distribution badge in row + Distribution block in detail", async () => {
    writeFileSync(join(ROOT, "profiles", "coder", "distribution.yaml"), [
      "name: acme-coder",
      "version: 1.2.3",
      "hermes_requires: '>=2.0'",
      "source: https://github.com/acme/coder",
      "installed_at: '2025-01-15T10:30:00Z'",
      "env_requires:",
      "  - name: ACME_KEY",
      "    required: true",
      "  - name: ACME_OPT",
      "    required: false",
      "",
    ].join("\n"))
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw: new MockGateway(), width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))
    const f = t.frame()
    // Badge on coder row, not on default.
    const rowCoder = f.split("\n").find(l => /▸?\s+coder/.test(l))!
    const rowDefault = f.split("\n").find(l => /▸?\s+default\s/.test(l))!
    expect(rowCoder).toContain("⬢")
    expect(rowDefault).not.toContain("⬢")
    // Arrow down to select coder so its detail pane renders.
    await act(async () => { await t.keys.pressArrow("down") })
    await until(t, () => t.frame().includes("Distribution"))
    const g = t.frame()
    expect(g).toContain("Distribution")
    expect(g).toContain("acme-coder")
    expect(g).toContain("v1.2.3")
    expect(g).toContain("Hermes >=2.0")
    expect(g).toContain("https://github.com/acme/coder")
    expect(g).toContain("1 required, 1 optional")
    t.destroy()
  })

  test("↓ selects, detail follows; d on active/default is no-op; d on other confirms → shell.exec; running-gateway warn", async () => {
    writeFileSync(join(ROOT, "profiles", "coder", "gateway.pid"), String(process.pid))
    const gw = new MockGateway({
      "shell.exec": () => ({ stdout: "deleted", stderr: "", code: 0 }),
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    await act(async () => { await t.keys.typeText("d") })
    await t.settle()
    expect(t.frame()).not.toContain("Delete Profile?")

    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("claude-4"))

    await act(async () => { await t.keys.typeText("d") })
    await until(t, () => t.frame().includes("Delete Profile?"))
    expect(t.frame()).toContain("'coder'")
    expect(t.frame()).toContain("gateway is running")

    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(t.gw.last("shell.exec")?.params.command).toBe("hermes profile delete coder -y")
    t.destroy()
  })

  test("n opens create dialog; validates; Enter → hermes profile create via shell.exec", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const c = p.command as string
        cmds.push(c)
        // Simulate the CLI actually scaffolding so the reload sees 3.
        const m = c.match(/^hermes profile create (\S+)/)
        if (m) mkProfile(m[1], { default: "x" })
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Profile"))
    expect(t.frame()).toContain("(fresh)")
    expect(t.frame()).toContain("type a name")
    expect(t.frame()).toContain("[x] shell alias")

    for (const c of "coder") await act(async () => { await t.keys.typeText(c) })
    await until(t, () => t.frame().includes("already exists"))
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(cmds.length).toBe(0)

    for (const c of "-v2") await act(async () => { await t.keys.typeText(c) })
    await until(t, () => t.frame().includes("Enter create"))
    // Tab to clone field, ↓ to pick 'default'.
    act(() => t.keys.pressTab())
    act(() => t.keys.pressArrow("down"))
    // Tab to alias field, Space to toggle off.
    act(() => t.keys.pressTab())
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("[ ] shell alias"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profiles (3)"))
    expect(cmds[0]).toBe("hermes profile create coder-v2 --clone --clone-from default --no-alias")
    expect(existsSync(join(ROOT, "profiles", "coder-v2"))).toBe(true)
    t.destroy()
  })

  test("Enter opens profile action menu; set sticky → shell.exec", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("claude-4"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profile · coder"))
    expect(t.frame()).toContain("SOUL.md")
    expect(t.frame()).toContain("Set as sticky default")
    expect(t.frame()).toContain("Export")
    // 'coder' has no .env → option list is: SOUL.md, config.yaml,
    // Directory, Set sticky, Export, Delete. Delete may sit below the
    // scrollbox fold; presence of the Manage group is enough here.

    // Cursor to "Set as sticky default" and select it.
    for (let k = 0; k < 3; k++) act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => cmds.length > 0)
    expect(cmds[0]).toBe("hermes profile use coder")
    t.destroy()
  })

  test("Tab switches pane; k (agents.kill) and d (list.delete) both → subagent.interrupt", async () => {
    let killed = ""
    const gw = new MockGateway({
      "delegation.status": () => STATUS(),
      "subagent.interrupt": p => { killed = p.subagent_id as string; return { found: true } },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Delegation (3)"))

    act(() => t.keys.pressTab())
    await t.settle()

    // First row after preorder is s1; k → confirm → interrupt.
    await act(async () => { await t.keys.typeText("k") })
    await until(t, () => t.frame().includes("Interrupt subagent?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(killed).toBe("s1")

    // list.delete alias reaches the same action.
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    await act(async () => { await t.keys.typeText("d") })
    await until(t, () => t.frame().includes("Interrupt subagent?"))
    expect(t.frame()).not.toContain("Delete Profile?")
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(killed).toBe("s2")
    t.destroy()
  })

  test("narrow width: single pane, Tab swaps; Enter swaps list↔detail inside Profiles", async () => {
    const gw = new MockGateway({ "delegation.status": () => STATUS() })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 80 })
    await until(t, () => t.frame().includes("Profiles (2)"))
    expect(t.frame()).not.toContain("Delegation (")
    expect(t.frame()).toContain("[Tab] ↔ delegation")
    expect(t.frame()).toContain("[Enter] detail")
    // Detail column (path/model) hidden at 80 cols.
    expect(t.frame()).not.toContain("test-model")

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("test-model"))
    expect(t.frame()).toContain("[Enter] actions")
    expect(t.frame()).toContain("[Esc] back")
    // Second Enter from detail opens the action menu.
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profile · default"))
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("Profile · default"))
    act(() => t.keys.pressEscape())
    await until(t, () => t.frame().includes("[Enter] detail"))

    act(() => t.keys.pressTab())
    await until(t, () => t.frame().includes("Delegation (3)"))
    expect(t.frame()).not.toContain("Profiles (")
    // Hint carries the tree summary when agents are live.
    expect(t.frame()).toMatch(/d\d · \d+ age/)

    act(() => t.resize(200, 48))
    await t.settle()
    await until(t, () => t.frame().includes("Profiles (2)") && t.frame().includes("Delegation (3)"))
    t.destroy()
  })

  test("s on non-active row → confirm → onSwitchProfile; active row no-ops", async () => {
    const gw = new MockGateway({ "delegation.status": () => STATUS() })
    const got: Array<[string, string]> = []
    const t = await mountNode(
      <Agents focused sessionId="test-sid"
              onSwitchProfile={(h, n) => got.push([h, n])} />,
      { gw },
    )
    await until(t, () => t.frame().includes("Profiles (2)"))
    expect(t.frame()).toContain("[s] switch")

    // Row 0 is active — `s` should not open the confirm.
    await act(async () => { await t.keys.typeText("s") })
    await t.settle()
    expect(t.frame()).not.toContain("Switch to")
    expect(got).toHaveLength(0)

    // Row 1 ("coder") — confirm fires with the profile's path.
    act(() => t.keys.pressArrow("down"))
    await act(async () => { await t.keys.typeText("s") })
    await until(t, () => t.frame().includes("Switch to 'coder'?"))
    await act(async () => { await t.keys.typeText("y") })
    await t.settle()
    expect(got).toEqual([[join(ROOT, "profiles", "coder"), "coder"]])
    t.destroy()
  })

  test("empty delegation shows placeholder; paused pill toggles via delegation.pause", async () => {
    let paused = true
    const gw = new MockGateway({
      "delegation.status": () => STATUS({ active: [], paused }),
      "delegation.pause": (p) => { paused = !!p.paused; return { paused } },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw })
    await until(t, () => t.frame().includes("Delegation (0)"))
    expect(t.frame()).toContain("⏸ paused")
    expect(t.frame()).toContain("new subagents will queue")

    // Click the pill → resume.
    const y = t.frame().split("\n").findIndex(l => l.includes("⏸ paused"))
    const x = t.frame().split("\n")[y].indexOf("⏸") + 1
    await act(async () => { await t.mouse.pressDown(x, y) })
    await until(t, () => t.frame().includes("▶ active"))
    expect(gw.last("delegation.pause")?.params.paused).toBe(false)
    expect(t.frame()).toContain("Delegation resumed")
    t.destroy()
  })

  // ── Install distribution flow ─────────────────────────────────────

  test("i opens install dialog; preview clone → confirm → hermes profile install", async () => {
    // Stub shell.exec so `git clone` writes a real distribution.yaml into
    // the tmp dir the dialog just mkdtemp'd. This exercises the true
    // readDistributionManifest() path rather than mocking around it.
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const c = p.command as string
        cmds.push(c)
        const m = c.match(/^git clone .* '([^']+)' '([^']+)'/)
        if (m && m[2]) {
          writeFileSync(join(m[2], "distribution.yaml"),
            [
              "name: anpicasso-chrome",
              "version: \"0.2.0\"",
              "description: Chrome profile distribution",
              "author: anpicasso",
              "license: MIT",
              "hermes_requires: \">=0.12.0\"",
              "distribution_owned:",
              "  - SOUL.md",
              "  - skills",
              "env_requires:",
              "  - name: CHROME_API_KEY",
              "    description: Browser key",
              "    required: true",
              "  - name: CHROME_DEBUG",
              "    required: false",
              "",
            ].join("\n"))
          return { stdout: "", stderr: "", code: 0 }
        }
        const inst = c.match(/^hermes profile install '([^']+)'/)
        if (inst) mkProfile("anpicasso-chrome", { default: "x" })
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    // Step 1 — open dialog
    await act(async () => { await t.keys.typeText("i") })
    await until(t, () => t.frame().includes("Install Distribution"))
    expect(t.frame()).toContain("git URL")

    // Type a source and submit → triggers clone
    for (const c of "github.com/anpicasso/hermes-plugin-chrome-profiles") {
      await act(async () => { await t.keys.typeText(c) })
    }
    act(() => t.keys.pressEnter())

    // Step 2 → Step 3 — preview confirm appears with manifest data
    await until(t, () => t.frame().includes("anpicasso-chrome"))
    const f = t.frame()
    expect(f).toContain("v0.2.0")
    expect(f).toContain("Chrome profile distribution")
    expect(f).toContain("anpicasso")
    expect(f).toContain("hermes >=0.12.0")
    expect(f).toContain("github.com/anpicasso/hermes-plugin-chrome-profiles")
    expect(f).toContain("SOUL.md, skills")
    expect(f).toContain("CHROME_API_KEY")   // required env listed
    expect(f).toContain("1 optional")

    // Confirm (Enter submits the form; nav spec § Dialogs)
    act(() => t.keys.pressEnter())
    await t.settle()

    const installCmd = cmds.find(c => c.startsWith("hermes profile install"))
    expect(installCmd).toBe("hermes profile install 'github.com/anpicasso/hermes-plugin-chrome-profiles' -y")
    // Env-var toast surfaces the required names.
    await until(t, () => t.frame().includes("CHROME_API_KEY"))
    expect(t.frame()).toContain("Env vars needed")
    t.destroy()
  })

  test("install dialog: --alias toggle + --name override produce the right flags", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const c = p.command as string
        cmds.push(c)
        const m = c.match(/^git clone .* '([^']+)' '([^']+)'/)
        if (m && m[2]) {
          writeFileSync(join(m[2], "distribution.yaml"),
            "name: coderv2\nversion: \"1.0.0\"\ndescription: Coder distro\n")
          return { stdout: "", stderr: "", code: 0 }
        }
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    await act(async () => { await t.keys.typeText("i") })
    await until(t, () => t.frame().includes("Install Distribution"))
    for (const c of "https://example.com/dist.git") {
      await act(async () => { await t.keys.typeText(c) })
    }
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("coderv2"))

    // Tab walks fields: name → alias. Space toggles on alias.
    act(() => t.keys.pressTab())
    await until(t, () => t.frame().includes("[ ] create shell wrapper"))
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("[x] create shell wrapper"))

    // Shift+Tab back to name field, then type the override.
    act(() => t.keys.pressTab({ shift: true }))
    await t.settle()
    for (const c of "coder-local") {
      await act(async () => { await t.keys.typeText(c) })
    }
    await t.settle()

    // Enter submits from the name field (<input> onSubmit fires the same
    // path as the global dialog.accept).
    act(() => t.keys.pressEnter())
    await t.settle()

    const installCmd = cmds.find(c => c.startsWith("hermes profile install"))
    expect(installCmd).toBe("hermes profile install 'https://example.com/dist.git' -y --name 'coder-local' --alias")
    t.destroy()
  })

  test("install dialog: clone failure shows error, no install shelled", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const c = p.command as string
        cmds.push(c)
        if (c.startsWith("git clone")) return { stdout: "", stderr: "fatal: repository not found", code: 128 }
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    await act(async () => { await t.keys.typeText("i") })
    await until(t, () => t.frame().includes("Install Distribution"))
    for (const c of "bogus-source") {
      await act(async () => { await t.keys.typeText(c) })
    }
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Clone failed"))
    expect(t.frame()).toContain("repository not found")

    // Dismiss error — no install call should have fired.
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(cmds.find(c => c.startsWith("hermes profile install"))).toBeUndefined()
    t.destroy()
  })

  test("install dialog: manifest missing → 'Not a distribution' error", async () => {
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const c = p.command as string
        cmds.push(c)
        // Clone "succeeds" but the cloned dir has no distribution.yaml.
        if (c.startsWith("git clone")) return { stdout: "", stderr: "", code: 0 }
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    await act(async () => { await t.keys.typeText("i") })
    await until(t, () => t.frame().includes("Install Distribution"))
    for (const c of "https://example.com/not-a-dist.git") {
      await act(async () => { await t.keys.typeText(c) })
    }
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Not a distribution"))
    expect(t.frame()).toContain("distribution.yaml")
    expect(cmds.find(c => c.startsWith("hermes profile install"))).toBeUndefined()
    t.destroy()
  })
  test("distribution menu: Info opens read-only dialog; Update → shell.exec with --force-config toggle", async () => {
    writeFileSync(join(ROOT, "profiles", "coder", "distribution.yaml"), [
      "name: acme-coder",
      "version: 1.2.3",
      "description: Coding profile",
      "hermes_requires: '>=2.0'",
      "author: Acme Corp",
      "license: MIT",
      "source: https://github.com/acme/coder",
      "installed_at: '2025-01-15T10:30:00Z'",
      "env_requires:",
      "  - name: ACME_KEY",
      "    description: Primary API token",
      "    required: true",
      "  - name: ACME_OPT",
      "    description: Optional override",
      "    required: false",
      "    default: fallback",
      "distribution_owned:",
      "  - skills/",
      "  - SOUL.md",
      "",
    ].join("\n"))
    const cmds: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "ok", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw, width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))

    // Select coder (has the manifest), open the action menu.
    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("⬢"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profile · coder"))
    expect(t.frame()).toContain("Info")
    expect(t.frame()).toContain("Update")

    // Filter to Info (title match).
    for (const c of "info") await act(async () => { await t.keys.typeText(c) })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Distribution · coder"))
    const info = t.frame()
    expect(info).toContain("acme-coder")
    expect(info).toContain("v1.2.3")
    expect(info).toContain("Hermes >=2.0")
    expect(info).toContain("Acme Corp")
    expect(info).toContain("MIT")
    expect(info).toContain("https://github.com/acme/coder")
    expect(info).toContain("Required")
    expect(info).toContain("ACME_KEY")
    expect(info).toContain("Primary API token")
    expect(info).toContain("Optional")
    expect(info).toContain("ACME_OPT")
    expect(info).toContain("default: fallback")
    expect(info).toContain("skills, SOUL.md")

    // Close info, reopen menu, pick Update.
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("Distribution · coder"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profile · coder"))
    for (const c of "update") await act(async () => { await t.keys.typeText(c) })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Update distribution?"))
    expect(t.frame()).toContain("'coder' · v1.2.3 · https://github.com/acme/coder")
    expect(t.frame()).toContain("[ ] --force-config")
    expect(t.frame()).not.toContain("active profile")

    // Tab is a no-op on single-checkbox confirm dialogs.
    act(() => t.keys.pressTab()); await t.settle()
    expect(t.frame()).toContain("[ ] --force-config")

    // Toggle force, confirm.
    act(() => t.keys.pressKey(" "))
    await until(t, () => t.frame().includes("[x] --force-config"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => cmds.length > 0)
    expect(cmds[0]).toBe("hermes profile update coder -y --force-config")
    await until(t, () => t.frame().includes("Updated 'coder'"))
    t.destroy()
  })

  test("update on the active profile warns + triggers rehome on success", async () => {
    writeFileSync(join(ROOT, "profiles", "coder", "distribution.yaml"),
      "name: acme-coder\nversion: 0.9.0\nsource: https://github.com/acme/coder\n")
    const cmds: string[] = []
    const switched: Array<[string, string]> = []
    const gw = new MockGateway({
      "shell.exec": p => { cmds.push(p.command as string); return { stdout: "ok", stderr: "", code: 0 } },
      "config.get": p => p.key === "profile"
        ? { home: join(ROOT, "profiles", "coder"), display: "coder" }
        : { config: {} },
    })
    const t = await mountNode(
      <Agents focused sessionId="test-sid"
              onSwitchProfile={(h, n) => switched.push([h, n])} />,
      { gw, width: 200 },
    )
    await until(t, () => t.frame().includes("Profiles (2)"))
    // coder is the active row (gateway reports so); select it.
    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("⬢"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profile · coder (active)"))
    for (const c of "update") await act(async () => { await t.keys.typeText(c) })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Update distribution?"))
    expect(t.frame()).toContain("active profile")
    expect(t.frame()).toContain("gateway will re-spawn")

    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => cmds.length > 0)
    expect(cmds[0]).toBe("hermes profile update coder -y")
    await until(t, () => switched.length > 0)
    expect(switched).toEqual([[join(ROOT, "profiles", "coder"), "coder"]])
    t.destroy()
  })

  test("active profile update reconnects when the gateway exits mid-command", async () => {
    writeFileSync(join(ROOT, "profiles", "coder", "distribution.yaml"),
      "name: acme-coder\nversion: 0.9.0\nsource: https://github.com/acme/coder\n")
    const switched: Array<[string, string]> = []
    const gw = new MockGateway({
      "shell.exec": () => { throw new Error("gateway exited (0)") },
      "config.get": p => p.key === "profile"
        ? { home: join(ROOT, "profiles", "coder"), display: "coder" }
        : { config: {} },
    })
    const t = await mountNode(
      <Agents focused sessionId="test-sid"
              onSwitchProfile={(home, name) => switched.push([home, name])} />,
      { gw, width: 200 },
    )
    await until(t, () => t.frame().includes("Profiles (2)"))
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profile · coder (active)"))
    for (const c of "update") await act(async () => { await t.keys.typeText(c) })
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Update distribution?"))
    await act(async () => { await t.keys.typeText("y") })

    await until(t, () => switched.length > 0)
    expect(switched).toEqual([[join(ROOT, "profiles", "coder"), "coder"]])
    t.destroy()
  })

  test("active profile update does not reconnect after an ordinary command failure", async () => {
    writeFileSync(join(ROOT, "profiles", "coder", "distribution.yaml"),
      "name: acme-coder\nversion: 0.9.0\nsource: https://github.com/acme/coder\n")
    const switched: Array<[string, string]> = []
    const gw = new MockGateway({
      "shell.exec": () => ({ stdout: "", stderr: "permission denied", code: 1 }),
      "config.get": p => p.key === "profile"
        ? { home: join(ROOT, "profiles", "coder"), display: "coder" }
        : { config: {} },
    })
    const t = await mountNode(
      <Agents focused sessionId="test-sid"
              onSwitchProfile={(home, name) => switched.push([home, name])} />,
      { gw, width: 200 },
    )
    await until(t, () => t.frame().includes("Profiles (2)"))
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profile · coder (active)"))
    for (const c of "update") await act(async () => { await t.keys.typeText(c) })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Update distribution?"))
    await act(async () => { await t.keys.typeText("y") })

    await until(t, () => t.frame().includes("permission denied"))
    expect(switched).toEqual([])
    t.destroy()
  })

  test("distribution menu entries absent on profiles without a manifest", async () => {
    const t = await mountNode(<Agents focused sessionId="test-sid" />, { gw: new MockGateway(), width: 200 })
    await until(t, () => t.frame().includes("Profiles (2)"))
    // default has no distribution.yaml.
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profile · default"))
    // No Info/Update titles in the dialog-select body.
    const f = t.frame()
    expect(f).not.toMatch(/^\s*[▸ ]\s*Info\b/m)
    expect(f).not.toMatch(/^\s*[▸ ]\s*Update\b/m)
    t.destroy()
  })
})
