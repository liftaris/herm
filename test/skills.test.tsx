import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mkdirSync, writeFileSync } from "node:fs"
import { mountNode, until, MockGateway } from "./harness"
import { hermesPath } from "../src/service/hermes-home"
import { Skills } from "../src/tabs/Skills"

describe("Skills tab", () => {
  test("list failure surfaces instead of rendering an unexplained empty tab", async () => {
    const gw = new MockGateway({
      "skills.manage": () => { throw new Error("skills exploded") },
    })
    const t = await mountNode(<Skills focused />, { gw })
    await until(t, () => t.frame().includes("skills exploded"))
    t.destroy()
  })

  test("renders installed skills without native Map.groupBy", async () => {
    const group = Map.groupBy
    Map.groupBy = undefined as unknown as typeof Map.groupBy
    try {
      const gw = new MockGateway({
        "skills.manage": p => p.action === "list"
          ? { skills: { general: ["local-skill"] } } : {},
      })
      const t = await mountNode(<Skills focused />, { gw, width: 160 })
      await until(t, () => t.frame().includes("Skills (1)"))
      expect(t.frame()).toContain("local-skill")
      t.destroy()
    } finally {
      Map.groupBy = group
    }
  })

  test("stale list response cannot replace a newer refresh", async () => {
    let stale!: (value: unknown) => void
    let lists = 0
    const gw = new MockGateway({
      "skills.manage": p => {
        if (p.action !== "list") return {}
        if (lists++ === 0) return { skills: { general: ["initial"] } }
        if (lists === 2) return new Promise(resolve => { stale = resolve })
        return { skills: { general: ["fresh"] } }
      },
    })
    const t = await mountNode(<Skills focused />, { gw, width: 160 })
    await until(t, () => t.frame().includes("initial"))
    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => lists === 2)
    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => t.frame().includes("fresh"))

    stale({ skills: { general: ["stale"] } })
    await act(async () => { await Bun.sleep(0) })
    await t.settle()
    expect(t.frame()).toContain("fresh")
    expect(t.frame()).not.toContain("stale")
    t.destroy()
  })

  test("enriches description/tags from SKILL.md frontmatter on disk", async () => {
    const dir = hermesPath("skills/general/local-skill")
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/SKILL.md`,
      "---\nname: local-skill\ndescription: A test skill description\ntags: [alpha, beta]\n---\n\nbody")
    const gw = new MockGateway({
      "skills.manage": p => p.action === "list"
        ? { skills: { general: ["local-skill"] } } : {},
    })
    const t = await mountNode(<Skills focused />, { gw, width: 160 })
    await until(t, () => t.frame().includes("Skills (1)"))
    // Description is detail-pane only (no list column).
    expect(t.frame().split("\n").find(l => l.includes("local-skill"))!)
      .not.toContain("A test skill description")
    expect(t.frame()).toContain("A test skill description")
    expect(t.frame()).toMatch(/Tags\s+alpha, beta/)
    t.destroy()
  })

  test("/ searches hub, Enter→confirm→install reloads", async () => {
    const installed: string[] = []
    const gw = new MockGateway({
      "skills.manage": p => {
        if (p.action === "list") return { skills: { general: ["local-skill"] } }
        if (p.action === "search") return {
          results: [
            { name: `hub-${p.query}`, description: "remote pkg" },
            { name: "other-pkg", description: "second" },
          ],
        }
        if (p.action === "install") { installed.push(p.query as string); return { ok: true } }
        return {}
      },
    })
    const t = await mountNode(<Skills focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("Skills (1)"))
    expect(t.frame()).toContain("local-skill")

    await act(async () => { await t.keys.typeText("/") })
    await until(t, () => t.frame().includes("Hub Search"))

    await act(async () => { await t.keys.typeText("net") })
    await until(t, () => t.frame().includes("hub-net"))
    expect(t.frame()).toContain("remote pkg")

    const last = t.gw.last("skills.manage")
    expect(last?.params.action).toBe("search")
    expect(last?.params.query).toBe("net")

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Install skill?"))
    expect(t.frame()).toContain("hub-net")

    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => installed.length > 0)
    expect(installed).toEqual(["hub-net"])
    await until(t, () => t.frame().includes("Installed hub-net"))
    // search exited, list reloaded
    await until(t, () => t.frame().includes("Skills (1)"))
    t.destroy()
  })

  test("hub search shows metadata and installs by canonical identifier", async () => {
    const installed: string[] = []
    const gw = new MockGateway({
      "skills.manage": p => {
        if (p.action === "list") return { skills: {} }
        if (p.action === "search") return {
          results: [{
            name: "display-name",
            description: "remote pkg",
            identifier: "github:owner/repo/skills/display-name",
            source: "github",
            trust_level: "trusted",
          }],
        }
        if (p.action === "install") { installed.push(p.query as string); return { ok: true } }
        return {}
      },
    })
    const t = await mountNode(<Skills focused />, { gw, width: 180, height: 40 })
    await until(t, () => t.frame().includes("Skills (0)"))

    await act(async () => { await t.keys.typeText("/") })
    await until(t, () => t.frame().includes("Hub Search"))
    await act(async () => { await t.keys.typeText("net") })
    await until(t, () => t.frame().includes("display-name"))
    const lines = t.frame().split("\n")
    const y = lines.findIndex(l => l.includes("display-name"))
    await act(async () => { await t.mouse.pressDown(lines[y].indexOf("display-name"), y) })
    await until(t, () => t.frame().includes("Install skill?"))

    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => installed.length > 0)
    expect(installed).toEqual(["github:owner/repo/skills/display-name"])
    t.destroy()
  })

  test("hub search drops stale responses", async () => {
    let hold!: (v: unknown) => void
    const gw = new MockGateway({
      "skills.manage": p => {
        if (p.action === "list") return { skills: {} }
        if (p.action === "search") return p.query === "a"
          ? new Promise(r => { hold = r })
          : { results: [{ name: "fresh-ab", description: "" }] }
        return {}
      },
    })
    const t = await mountNode(<Skills focused />, { gw })
    await until(t, () => t.frame().includes("Skills (0)"))

    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    await act(async () => { await t.keys.typeText("a") })
    await until(t, () => !!hold)
    await act(async () => { await t.keys.typeText("b") })
    await until(t, () => t.frame().includes("fresh-ab"))

    await act(async () => { hold({ results: [{ name: "STALE", description: "" }] }) })
    await t.settle()
    expect(t.frame()).toContain("fresh-ab")
    expect(t.frame()).not.toContain("STALE")
    t.destroy()
  })

  test("h opens curator history pane; listCuratorRuns reads run.json counts", async () => {
    const { listCuratorRuns } = await import("../src/service/hermes-home")
    const base = hermesPath("logs/curator/20260430-120000")
    mkdirSync(base, { recursive: true })
    writeFileSync(`${base}/run.json`, JSON.stringify({
      started_at: "2026-04-30T12:00:00Z",
      counts: { before: 50, after: 42, archived_this_run: 8,
        consolidated_this_run: 3, added_this_run: 1 },
    }))
    writeFileSync(`${base}/REPORT.md`, "# Curator run\n\nsome report body")

    const runs = listCuratorRuns()
    expect(runs[0].id).toBe("20260430-120000")
    expect(runs[0].before).toBe(50)
    expect(runs[0].archived).toBe(8)
    expect(runs[0].consolidated).toBe(3)

    const gw = new MockGateway({
      "skills.manage": p => p.action === "list" ? { skills: { general: ["sk"] } } : {},
    })
    const t = await mountNode(<Skills focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("Skills (1)"))
    expect(t.frame()).not.toContain("Curator History")

    await act(async () => { await t.keys.typeText("h") })
    await until(t, () => t.frame().includes("Curator History"))
    expect(t.frame()).toContain("50→42")
    expect(t.frame()).toContain("arch 8")
    expect(t.frame()).toContain("cons 3")

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("some report body"))

    await act(async () => { await t.keys.typeText("h") })
    await until(t, () => !t.frame().includes("Curator History"))
    t.destroy()
  })

  test("indexCuratorLineage: per-skill events across runs; DetailPanel renders (c8w.2)", async () => {
    const { indexCuratorLineage } = await import("../src/service/hermes-home")
    const a = hermesPath("logs/curator/20260420-100000")
    const b = hermesPath("logs/curator/20260425-100000")
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true })
    writeFileSync(`${a}/run.json`, JSON.stringify({
      started_at: "2026-04-20T10:00:00Z",
      consolidated: [
        { name: "foo-v2", into: "foo", reason: "dedupe" },
        { name: "foo-old", into: "foo" },
      ],
      added: ["foo"],
    }))
    writeFileSync(`${b}/run.json`, JSON.stringify({
      started_at: "2026-04-25T10:00:00Z",
      state_transitions: [{ name: "foo", from: "active", to: "stale" }],
      pruned: [{ name: "bar", reason: "unused" }],
    }))

    const idx = indexCuratorLineage()
    const foo = idx.get("foo")!
    // newest-first: transition (04-25) then absorbed+added (04-20)
    expect(foo[0]).toMatchObject({ kind: "transition", from: "active", to: "stale" })
    expect(foo.find(e => e.kind === "absorbed")).toMatchObject({
      kind: "absorbed", sources: ["foo-v2", "foo-old"],
    })
    expect(foo.find(e => e.kind === "added")).toBeDefined()
    expect(idx.get("foo-v2")![0]).toMatchObject({ kind: "merged", into: "foo", reason: "dedupe" })
    expect(idx.get("bar")![0]).toMatchObject({ kind: "pruned", reason: "unused" })
    expect(idx.has("unknown")).toBe(false)

    // Integration: DetailPanel shows the block for selected skill.
    mkdirSync(hermesPath("skills/general/foo"), { recursive: true })
    writeFileSync(hermesPath("skills/general/foo/SKILL.md"),
      "---\nname: foo\ndescription: test\n---\n")
    const gw = new MockGateway({
      "skills.manage": p => p.action === "list" ? { skills: { general: ["foo"] } } : {},
    })
    const t = await mountNode(<Skills focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("Curator lineage"))
    const f = t.frame()
    expect(f).toContain("active → stale")
    expect(f).toContain("absorbed")
    expect(f).toContain("foo-v2")
    expect(f).toContain("created by curator")
    t.destroy()
  })
})
