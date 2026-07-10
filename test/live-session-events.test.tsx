import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"

describe("live session event routing", () => {
  test("ignores sibling session stream events after activating another session", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({
        session_id: p.session_id,
        messages: p.session_id === "sid-b"
          ? [{ role: "user", content: "Question B", timestamp: 1 }]
          : [],
      }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => {
      t.gw.push({ type: "message.start", session_id: "sid-b" })
      t.gw.push({ type: "message.delta", session_id: "sid-b", payload: { text: "B is streaming" } })
      t.gw.push({ type: "message.start", session_id: "sid-a" })
      t.gw.push({ type: "message.delta", session_id: "sid-a", payload: { text: "LATE_FROM_A" } })
      t.gw.push({ type: "status.update", session_id: "sid-a", payload: { text: "A is still running", kind: "lifecycle" } })
      t.gw.push({ type: "message.complete", session_id: "sid-a", payload: { text: "DONE_A" } })
    })
    await until(t, () => t.frame().includes("B is streaming"))

    expect(t.frame()).not.toContain("LATE_FROM_A")
    expect(t.frame()).not.toContain("DONE_A")
    expect(t.frame()).not.toContain("A is still running")
    expect(t.frame()).not.toContain("Ready")
    t.destroy()
  })

  test("ignores sibling process notifications while stream events stay scoped", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    act(() => {
      t.gw.push({ type: "message.start", session_id: "sid-b" })
      t.gw.push({ type: "message.delta", session_id: "sid-b", payload: { text: "B is streaming" } })
      t.gw.push({
        type: "status.update",
        session_id: "sid-a",
        payload: {
          kind: "process",
          text: "Background process proc_watch completed (exit code 0).\nCommand: watch-kanban",
        },
      })
    })
    await until(t, () => t.frame().includes("B is streaming"))

    expect(t.frame()).not.toContain("proc_watch")
    expect(t.frame()).not.toContain("watch-kanban")
    t.destroy()
  })

  test("renders MoA references before aggregator answer without aggregating rows", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => {
      t.gw.push({ type: "message.start", session_id: "sid-b" })
      t.gw.push({
        type: "moa.reference",
        session_id: "sid-b",
        payload: { label: "openrouter:openai/gpt-5.5", text: "Paris.", index: 1, count: 2 },
      })
      t.gw.push({
        type: "moa.aggregating",
        session_id: "sid-b",
        payload: { aggregator: "openrouter:anthropic/claude-opus-4.8" },
      })
      t.gw.push({ type: "message.delta", session_id: "sid-b", payload: { text: "The answer is Paris." } })
      t.gw.push({ type: "message.complete", session_id: "sid-b" })
    })
    await until(t, () => t.frame().includes("The answer is Paris."))

    const frame = t.frame()
    expect(frame).toContain("◇ Reference 1/2 — openrouter:openai/gpt-5.5")
    expect(frame).toContain("Paris.")
    expect(frame.indexOf("◇ Reference 1/2")).toBeLessThan(frame.indexOf("The answer is Paris."))
    expect(frame).not.toContain("aggregating with")
    expect(frame).not.toContain("openrouter:anthropic/claude-opus-4.8")
    t.destroy()
  })

  test("sibling background completion clears badge without writing into active transcript", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/background", "run in background"]] }),
      "prompt.background": () => ({ task_id: "bg-42" }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/background do the thing") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("▶ 1"))

    act(() => t.gw.push({
      type: "background.complete",
      session_id: "sid-a",
      payload: { task_id: "bg-42", text: "done elsewhere" },
    }))
    await until(t, () => !t.frame().includes("▶ 1"))

    expect(t.frame()).not.toContain("done elsewhere")
    t.destroy()
  })

  test("session.title updates active title without transcript noise", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({
      type: "session.title",
      payload: { session_id: "sid-b", title: "Generated B" },
    }))
    await until(t, () => /Title\s+Generated B/.test(t.frame()))

    expect(t.frame()).not.toContain("session.title")
    t.destroy()
  })

  test("session.title ignores missing and inactive payloads", async () => {
    const gw = new MockGateway({
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "sid-b", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    act(() => {
      t.gw.push({ type: "session.title", payload: { title: "No ID" } })
      t.gw.push({ type: "session.title", payload: { session_id: "sid-b" } })
      t.gw.push({ type: "session.title", payload: { session_id: "sid-a", title: "Wrong Session" } })
    })
    await t.settle()

    expect(t.frame()).not.toContain("No ID")
    expect(t.frame()).not.toContain("Wrong Session")
    expect(t.frame()).toMatch(/Title\s+—/)
    t.destroy()
  })
})
