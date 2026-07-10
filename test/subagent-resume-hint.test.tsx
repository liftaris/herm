import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until } from "./harness"

describe("subagent resume hint", () => {
  test("session info usage shows idle auto-resume hint", async () => {
    const t = await mount({ handlers: {
      "session.create": () => ({
        session_id: "test-sid",
        info: {
          model: "test-model",
          session_id: "test-sid",
          tools: {},
          skills: {},
          usage: { input: 0, output: 0, total: 0, active_subagents: 1 },
        },
      }),
    } })

    await until(t, () => t.frame().includes("↩ resumes when subagent finishes"))
    t.destroy()
  })

  test("hides idle auto-resume hint for zero and undefined counts", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    expect(t.frame()).not.toContain("resumes when")

    act(() => t.gw.push({
      type: "session.info",
      payload: {
        model: "test-model",
        session_id: "test-sid",
        tools: {},
        skills: {},
        usage: { input: 0, output: 0, total: 0, active_subagents: 0 },
      },
    }))
    await until(t, () => t.frame().includes("Ready"))
    expect(t.frame()).not.toContain("resumes when")
    t.destroy()
  })

  test("pluralizes idle auto-resume hint from live session info", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({
      type: "session.info",
      payload: {
        model: "test-model",
        session_id: "test-sid",
        tools: {},
        skills: {},
        usage: { input: 0, output: 0, total: 0, active_subagents: 3 },
      },
    }))
    await until(t, () => t.frame().includes("↩ resumes when 3 subagents finish"))
    t.destroy()
  })

  test("hides auto-resume hint while streaming", async () => {
    const t = await mount({ handlers: {
      "session.create": () => ({
        session_id: "test-sid",
        info: {
          model: "test-model",
          session_id: "test-sid",
          tools: {},
          skills: {},
          usage: { input: 0, output: 0, total: 0, active_subagents: 2 },
        },
      }),
    } })
    await until(t, () => t.frame().includes("↩ resumes when 2 subagents finish"))

    act(() => t.gw.push({ type: "message.start", session_id: "test-sid" }))
    await until(t, () => !t.frame().includes("resumes when") && !t.frame().includes("Ready"))
    t.destroy()
  })
})
