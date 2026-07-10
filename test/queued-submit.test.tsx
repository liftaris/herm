import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"

function info() {
  return { model: "test-model", session_id: "test-sid", tools: {}, skills: {} }
}

describe("queued prompt submit", () => {
  test("accepted submit can be interrupted before message.start without resubmitting", async () => {
    const gw = new MockGateway({
      "session.interrupt": () => ({ status: "interrupted" }),
      "prompt.submit": () => ({ status: "streaming" }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("slow boot") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("starting agent"))
    expect(t.frame()).toContain("esc×2 cancel")

    act(() => t.keys.pressEscape())
    await until(t, () => t.frame().includes("esc again to cancel"))
    expect(gw.calls.filter(c => c.method === "session.interrupt")).toHaveLength(0)

    act(() => t.keys.pressEscape())
    await until(t, () => gw.calls.filter(c => c.method === "session.interrupt").length === 1)

    act(() => gw.push({ type: "session.info", payload: { ...info(), running: false } }))
    await until(t, () => t.frame().includes("Ready"))

    expect(gw.calls.filter(c => c.method === "prompt.submit")).toHaveLength(1)
    t.destroy()
  })

  test("queued input while starting waits for post-cancel idle", async () => {
    let n = 0
    const gw = new MockGateway({
      "config.get": p => p.key === "busy" ? { value: "interrupt" } : {},
      "session.interrupt": () => ({ status: "interrupted" }),
      "prompt.submit": () => {
        n += 1
        return { status: "streaming" }
      },
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("slow boot") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("starting agent"))

    await act(async () => { await t.keys.typeText("after cancel") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("⏸ 1. after cancel"))

    act(() => t.keys.pressEscape())
    await t.settle()
    act(() => t.keys.pressEscape())
    await until(t, () => gw.calls.filter(c => c.method === "session.interrupt").length === 2)
    expect(gw.calls.filter(c => c.method === "prompt.submit")).toHaveLength(1)

    act(() => gw.push({ type: "session.info", payload: { ...info(), running: false } }))
    await until(t, () => gw.calls.filter(c => c.method === "prompt.submit").length === 2)

    expect(n).toBe(2)
    expect(gw.last("prompt.submit")?.params.text).toBe("after cancel")
    t.destroy()
  })

  test("rapid submit queues behind accepted prompt before message.start", async () => {
    let release!: () => void
    const first = new Promise<{ status: string }>(resolve => {
      release = () => resolve({ status: "streaming" })
    })
    const gw = new MockGateway({
      "prompt.submit": () => first,
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("message A") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.calls.filter(c => c.method === "prompt.submit").length === 1)

    await act(async () => { await t.keys.typeText("message B") })
    act(() => t.keys.pressEnter())
    await t.settle()

    expect(gw.calls.filter(c => c.method === "prompt.submit")).toHaveLength(1)
    expect(t.frame()).toContain("⏸ 1. message B")

    act(() => release())
    await until(t, () => t.frame().includes("message A"))
    act(() => gw.push({ type: "message.start" }))
    act(() => gw.push({ type: "message.complete", payload: { status: "complete", text: "done" } }))
    await until(t, () => gw.calls.filter(c => c.method === "prompt.submit").length === 2)

    expect(gw.last("prompt.submit")?.params.text).toBe("message B")
    t.destroy()
  })

  test("interrupt-mode queue waits for session.info before draining", async () => {
    const gw = new MockGateway({
      "config.get": p => p.key === "busy" ? { value: "interrupt" } : {},
      "session.interrupt": () => ({ status: "interrupted" }),
      "prompt.submit": () => ({ status: "streaming" }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    act(() => gw.push({ type: "message.start" }))
    await until(t, () => t.frame().includes("Type to queue"))

    await act(async () => { await t.keys.typeText("stop l4") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("stop l4"))

    expect(gw.calls.filter(c => c.method === "session.interrupt")).toHaveLength(1)

    act(() => gw.push({ type: "message.complete", payload: { status: "interrupted", text: "" } }))
    await t.settle()
    expect(gw.calls.filter(c => c.method === "prompt.submit")).toHaveLength(0)

    act(() => gw.push({ type: "session.info", payload: info() }))
    await until(t, () => gw.calls.filter(c => c.method === "prompt.submit").length === 1)

    expect(gw.last("prompt.submit")?.params).toMatchObject({
      session_id: "test-sid",
      text: "stop l4",
    })
    t.destroy()
  })

  test("session-busy submit rejection requeues and retries", async () => {
    let tries = 0
    const gw = new MockGateway({
      "config.get": p => p.key === "busy" ? { value: "interrupt" } : {},
      "session.interrupt": () => ({ status: "interrupted" }),
      "prompt.submit": () => {
        tries += 1
        if (tries === 1) throw new Error("session busy")
        return { status: "streaming" }
      },
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    act(() => gw.push({ type: "message.start" }))
    await until(t, () => t.frame().includes("Type to queue"))
    await act(async () => { await t.keys.typeText("retry after settle") })
    act(() => t.keys.pressEnter())

    act(() => gw.push({ type: "message.complete", payload: { status: "interrupted", text: "" } }))
    await t.settle()
    expect(gw.calls.filter(c => c.method === "prompt.submit")).toHaveLength(0)

    act(() => gw.push({ type: "session.info", payload: info() }))
    await until(t, () => gw.calls.filter(c => c.method === "prompt.submit").length === 2, 2500)

    expect(tries).toBe(2)
    expect(gw.last("prompt.submit")?.params.text).toBe("retry after settle")
    expect(t.frame()).toContain("retry after settle")
    t.destroy()
  })
})
