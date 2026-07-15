import { describe, expect, it } from "bun:test"
import { act } from "react"
import { mount } from "./harness"

describe("terminal title", () => {
  it("updates title on active/idle transitions and cwd changes including Windows paths", async () => {
    await using t = await mount()
    const calls: string[] = []
    t.renderer.setTerminalTitle = (title: string) => calls.push(title)

    act(() => t.gw.push({ type: "session.info", payload: { model: "test", session_id: "test-sid", cwd: "/home/user/project", tools: {}, skills: {} } }))
    await t.settle()

    act(() => t.gw.push({ type: "message.start" }))
    await t.settle()

    act(() => t.gw.push({ type: "session.info", payload: { model: "test", session_id: "test-sid", cwd: "C:\\Users\\foo\\bar", tools: {}, skills: {} } }))
    await t.settle()

    act(() => t.gw.push({ type: "message.complete", payload: { text: "done" } }))
    await t.settle()

    act(() => t.gw.push({ type: "session.info", payload: { model: "test", session_id: "test-sid", tools: {}, skills: {} } }))
    await t.settle()

    act(() => t.gw.push({ type: "message.start" }))
    await t.settle()

    expect(calls).toEqual([
      "Herm · project",
      "● Herm · project",
      "● Herm · bar",
      "Herm · bar",
      "Herm",
      "● Herm",
    ])
  })
})
