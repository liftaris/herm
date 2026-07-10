import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"

describe("background/btw completion", () => {
  test("background.complete → assistant-style transcript message", async () => {
    const t = await mount({ width: 140, height: 40 })
    await until(t, () => t.frame().includes("Ready"))

    const body = ["summary line", ...Array.from({ length: 5 }, (_, i) => `detail ${i}`)].join("\n")
    act(() => t.gw.push({ type: "background.complete", payload: { task_id: "bg-1", text: body } }))
    await until(t, () => t.frame().includes("summary line"), 3000)

    const f = t.frame()
    expect(f).toContain("[bg bg-1]")
    expect(f).toContain("summary line")
    expect(f).toContain("detail 4")
    expect(f).not.toContain("Background task complete")
    expect(f).not.toContain("view")
    t.destroy()
  })

  test("btw.complete → transcript marker + toast", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({ type: "btw.complete", payload: { text: "side answer here" } }))
    await t.settle()
    expect(t.frame()).toContain("◈ btw — side answer here")
    expect(t.frame()).toContain("btw")
    t.destroy()
  })

  test("/background register → start line + titled assistant completion", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/background", "run in background"]] }),
      "prompt.background": () => ({ task_id: "bg-42" }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    expect(t.frame()).not.toContain("▶ 1")

    await act(async () => { await t.keys.typeText("/background do the thing") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("▶ 1"))
    expect(t.frame()).toContain("bg bg-42 started")
    expect(t.frame()).not.toContain("· bg bg-42 started")
    expect(t.gw.last("prompt.background")?.params).toMatchObject({ session_id: "test-sid", text: "do the thing" })

    act(() => t.gw.push({ type: "background.complete", payload: { task_id: "bg-42", text: "done" } }))
    await until(t, () => t.frame().includes("done"), 3000)
    expect(t.frame()).not.toContain("▶ 1")
    expect(t.frame()).toContain("[bg bg-42] do the thing")
    expect(t.frame()).toContain("done")
    t.destroy()
  })

  test("/background with no task_id in response does not register", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/background", "run in background"]] }),
      "prompt.background": () => ({}),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/background oops") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("background start failed"))
    expect(t.frame()).not.toContain("▶ 1")
    t.destroy()
  })
})
