import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, mountNode, MockGateway, until } from "./harness"
import { Journey, buildJourneyRows } from "../src/tabs/Journey"
import { TAB_SLASH } from "../src/app/tabs"
import { resolve, LOCAL_COMMANDS } from "../src/app/slashCommands"
import type { LearningFramesResponse } from "../src/context/wire"

const frames = (): LearningFramesResponse => ({
  frames: [{
    reveal: 1,
    date: "2026-06-30",
    visible: 2,
    grid: [[
      ["╭", "dim"],
      ["●", "memory"],
      ["─", "dim"],
      ["◆", "skill"],
      ["╯", "dim"],
    ]],
    labels: [],
  }],
  legend: [{ glyph: "●", style: "memory", label: "memory" }],
  categories: [{ glyph: "◆", color: "#00ffff", label: "skills" }],
  buckets: [{
    index: 0,
    label: "Jun 30",
    date: "2026-06-30",
    skills: 1,
    memories: 1,
    total: 2,
    category: "recent",
    color: "#00ffff",
    nodes: [
      { id: "skill-a", glyph: "◆", label: "Skill", fullLabel: "Skill A", meta: "skill", body: "", style: "skill" },
      { id: "memory:memory:0", glyph: "●", label: "Memory", fullLabel: "Memory card", meta: "MEMORY.md", body: "remember me", style: "memory" },
    ],
  }],
  summary: ["2 learned items"],
  axis: { start: "2026-06-30", end: "2026-06-30" },
  count: 2,
  cols: 80,
  rows: 8,
})

const oldFrames = (): LearningFramesResponse => ({
  ...frames(),
  buckets: [
    frames().buckets![0],
    { ...frames().buckets![0], index: 1, label: "Jul 01", nodes: [
      { id: "memory:memory:1", glyph: "●", label: "New", fullLabel: "Newest memory", meta: "MEMORY.md", body: "new", style: "memory" },
    ] },
  ],
  count: 3,
})

describe("Journey", () => {
  test("builds chronological slice and item rows with gaps", () => {
    const data = frames()
    const rows = buildJourneyRows([data.buckets![0], { ...data.buckets![0], index: 1, label: "Jul 01" }])
    expect(rows.map(r => r.kind)).toEqual(["slice", "node", "node", "gap", "slice", "node", "node"])
  })

  test("renders learning frames and opens detail through RPC", async () => {
    const gw = new MockGateway({
      "learning.frames": () => frames(),
      "learning.detail": p => ({ ok: true, kind: "memory", id: p.id, label: "Memory card", content: "full memory body" }),
    })
    await using t = await mountNode(<Journey focused />, { gw, width: 120, height: 36 })
    await until(t, () => t.frame().includes("Journey · 2 learned items"))

    expect(t.frame()).toContain("Jun 30")
    expect(t.frame()).toContain("Memory card")
    expect(t.gw.last("learning.frames")?.params.frames).toBe(2)

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("full memory body"))
    expect(t.gw.last("learning.detail")?.params.id).toBe("memory:memory:0")
  })

  test("uses shared list keys and keeps selection visible", async () => {
    const many = frames()
    const nodes = Array.from({ length: 24 }, (_, i) => ({
      id: `memory:memory:${i}`,
      glyph: "●",
      label: `Memory ${i}`,
      fullLabel: `Memory card ${i}`,
      meta: "MEMORY.md",
      body: `body ${i}`,
      style: "memory",
    }))
    many.buckets = [{ ...many.buckets![0], nodes, total: nodes.length, memories: nodes.length, skills: 0 }]
    many.count = nodes.length
    const gw = new MockGateway({ "learning.frames": () => many })

    await using t = await mountNode(<Journey focused />, { gw, width: 100, height: 20 })
    await until(t, () => t.frame().includes("▸   └─ ● Memory card 23"))

    act(() => t.keys.pressKey("HOME"))
    await until(t, () => t.frame().includes("▸ Jun 30"))
    await act(async () => { await t.keys.pressKeys(["\x1B[6~"]) })
    await until(t, () => t.frame().includes("▸   ├─ ● Memory card 8"))
    act(() => t.keys.pressKey("END"))
    await until(t, () => t.frame().includes("▸   └─ ● Memory card 23"))
  })

  test("moves backward across bucket gaps", async () => {
    const gw = new MockGateway({ "learning.frames": () => oldFrames() })

    await using t = await mountNode(<Journey focused />, { gw, width: 120, height: 36 })
    await until(t, () => t.frame().includes("▸   └─ ● Newest memory"))

    act(() => t.keys.pressArrow("up"))
    await until(t, () => t.frame().includes("▸ Jul 01"))
    act(() => t.keys.pressArrow("up"))
    await until(t, () => t.frame().includes("▸   └─ ● Memory card"))
  })

  test("mouse hover selects and mouse down opens detail", async () => {
    const gw = new MockGateway({
      "learning.frames": () => frames(),
      "learning.detail": p => ({ ok: true, kind: "skill", id: p.id, label: "Skill A", content: "skill detail" }),
    })
    await using t = await mountNode(<Journey focused />, { gw, width: 120, height: 36 })
    await until(t, () => t.frame().includes("Skill A"))
    const y = t.frame().split("\n").findIndex(l => l.includes("Skill A"))

    await act(async () => { await t.mouse.moveTo(6, y) })
    await until(t, () => t.frame().includes("▸   ├─ ◆ Skill A"))
    await act(async () => { await t.mouse.pressDown(6, y) })
    await until(t, () => t.frame().includes("skill detail"))
    expect(t.gw.last("learning.detail")?.params.id).toBe("skill-a")
  })

  test("detail pane receives Tab focus and keyboard scrolling", async () => {
    const content = Array.from({ length: 30 }, (_, i) => `detail line ${i}`).join("\n")
    const gw = new MockGateway({
      "learning.frames": () => frames(),
      "learning.detail": p => ({ ok: true, kind: "memory", id: p.id, label: "Memory card", content }),
    })
    await using t = await mountNode(<Journey focused />, { gw, width: 120, height: 22 })
    await until(t, () => t.frame().includes("Memory card"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("detail line 0"))
    act(() => t.keys.pressKey("tab"))
    await until(t, () => !t.frame().includes("Esc close"))
    await act(async () => { await t.keys.pressKeys(["\x1B[6~"]) })
    await until(t, () => t.frame().includes("detail line 14") || t.frame().includes("detail line 15"))
    act(() => t.keys.pressEscape())
    await until(t, () => t.frame().includes("Esc close"))
  })

  test("opens on the newest learned node", async () => {
    const gw = new MockGateway({
      "learning.frames": () => oldFrames(),
      "learning.detail": p => ({ ok: true, kind: "memory", id: p.id, label: "Newest memory", content: "newest detail" }),
    })
    await using t = await mountNode(<Journey focused />, { gw, width: 120, height: 36 })
    await until(t, () => t.frame().includes("Newest memory"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("newest detail"))
    expect(t.gw.last("learning.detail")?.params.id).toBe("memory:memory:1")
  })

  test("shows empty and RPC-error states", async () => {
    await using empty = await mountNode(<Journey focused />, {
      gw: new MockGateway({ "learning.frames": () => ({ ...frames(), count: 0, buckets: [] }) }),
    })
    await until(empty, () => empty.frame().includes("No learning yet"))

    await using fail = await mountNode(<Journey focused />, {
      gw: new MockGateway({ "learning.frames": () => { throw new Error("learning.frames failed") } }),
    })
    await until(fail, () => fail.frame().includes("learning.frames failed"))
  })

  test("ignores stale frame responses after resize", async () => {
    const pending: Array<(value: LearningFramesResponse) => void> = []
    const gw = new MockGateway({
      "learning.frames": () => new Promise<LearningFramesResponse>(resolve => pending.push(resolve)),
    })
    await using t = await mountNode(<Journey focused />, { gw, width: 100, height: 24 })
    await until(t, () => pending.length === 1)

    t.resize(140, 36)
    await until(t, () => pending.length === 2)
    await act(async () => { pending[1]!(oldFrames()); await Promise.resolve() })
    await until(t, () => t.frame().includes("Newest memory"))

    await act(async () => { pending[0]!(frames()); await Promise.resolve() })
    await t.settle()
    expect(t.frame()).toContain("Newest memory")
  })

  test("delete uses confirm dialog and refreshes after mutation", async () => {
    let n = 0
    const gw = new MockGateway({
      "learning.frames": () => { n++; return frames() },
      "learning.delete": p => ({ ok: true, message: `deleted ${p.id}` }),
    })
    await using t = await mountNode(<Journey focused />, { gw })
    await until(t, () => t.frame().includes("Memory card"))

    act(() => t.keys.pressKey("d"))
    await until(t, () => t.frame().includes("Delete Memory?"))
    act(() => t.keys.pressKey("y"))
    await until(t, () => n > 1)
    expect(t.gw.last("learning.delete")?.params.id).toBe("memory:memory:0")
  })

  test("slash aliases route to the native Journey surface", async () => {
    expect(TAB_SLASH.journey).toEqual({ tab: 1, sub: 3 })
    expect(TAB_SLASH.learning).toEqual({ tab: 1, sub: 3 })
    expect(TAB_SLASH["memory-graph"]).toEqual({ tab: 1, sub: 3 })
    expect(resolve(LOCAL_COMMANDS, "learning")).toMatchObject({ hit: { name: "journey" } })
    expect(resolve(LOCAL_COMMANDS, "journey")).toMatchObject({ hit: { target: "local" } })

    await using t = await mount({
      handlers: { "learning.frames": () => frames() },
      width: 130,
      height: 40,
    })
    await until(t, () => t.frame().includes("Ready"))
    await act(async () => { await t.keys.typeText("/journey") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Journey · 2 learned items"))
    expect(t.gw.last("slash.exec")).toBeUndefined()
  })
})
