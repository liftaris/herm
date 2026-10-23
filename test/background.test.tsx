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
    expect(f).toContain("summary line")
    expect(f).toContain("detail 4")
    t.destroy()
  })

  test("btw.complete → transcript marker + toast", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({ type: "btw.complete", payload: { text: "side answer here" } }))
    await t.settle()
    expect(t.frame()).toContain("side answer here")
    t.destroy()
  })

  test("/bg register → start line + titled assistant completion", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/bg", "run in background"]] }),
      "prompt.background": () => ({ task_id: "bg-42" }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/bg do the thing") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.background") !== undefined)
    expect(t.gw.last("prompt.background")?.params).toMatchObject({ session_id: "test-sid", text: "do the thing" })

    act(() => t.gw.push({ type: "background.complete", payload: { task_id: "bg-42", text: "done" } }))
    await until(t, () => t.frame().includes("done"), 3000)
    t.destroy()
  })
})
