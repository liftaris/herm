import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"

describe("lazy session startup", () => {
  test("first prompt submits after session.create before session.info", async () => {
    const gw = new MockGateway({
      "session.create": () => ({
        session_id: "lazy-sid",
        info: { model: "lazy-model", session_id: "lazy-sid", tools: {}, skills: {}, lazy: true, desktop_contract: 4 },
      }),
      "prompt.submit": () => ({ status: "streaming" }),
    })
    gw.start = () => {
      gw.ok = true
      gw.push({ type: "gateway.ready" })
    }

    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Connecting") && t.frame().includes("lazy-model"))

    await act(async () => { await t.keys.typeText("hello while lazy") })
    act(() => t.keys.pressEnter())
    await until(t, () => Boolean(t.gw.last("prompt.submit")))

    expect(t.gw.last("prompt.submit")?.params).toMatchObject({
      session_id: "lazy-sid",
      text: "hello while lazy",
    })
    t.destroy()
  })

  test("first skill slash command dispatches after session.create before session.info", async () => {
    const gw = new MockGateway({
      "session.create": () => ({
        session_id: "lazy-sid",
        info: { model: "lazy-model", session_id: "lazy-sid", tools: {}, skills: {}, lazy: true, desktop_contract: 4 },
      }),
      "commands.catalog": () => ({ pairs: [["/review", "Review with skill"]] }),
      "slash.exec": () => { throw new Error("fall through") },
      "command.dispatch": () => ({ type: "skill", name: "review", message: "Load review skill and continue" }),
      "prompt.submit": () => ({ status: "streaming" }),
    })
    gw.start = () => {
      gw.ok = true
      gw.push({ type: "gateway.ready" })
    }

    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Connecting") && t.frame().includes("lazy-model"))
    await until(t, () => Boolean(t.gw.last("commands.catalog")))

    await act(async () => { await t.keys.typeText("/review") })
    act(() => t.keys.pressEnter())
    await until(t, () => Boolean(t.gw.last("prompt.submit")))

    expect(t.gw.last("slash.exec")?.params).toMatchObject({
      session_id: "lazy-sid",
      command: "/review",
    })
    expect(t.gw.last("command.dispatch")?.params).toMatchObject({
      session_id: "lazy-sid",
      name: "review",
    })
    expect(t.gw.last("prompt.submit")?.params).toMatchObject({
      session_id: "lazy-sid",
      text: "Load review skill and continue",
    })
    t.destroy()
  })

  test("queued prompt drains after lazy session.create before session.info", async () => {
    const gw = new MockGateway({
      "session.create": () => ({
        session_id: "lazy-sid",
        info: { model: "lazy-model", session_id: "lazy-sid", tools: {}, skills: {}, lazy: true, desktop_contract: 4 },
      }),
      "prompt.submit": () => ({ status: "streaming" }),
    })
    gw.start = () => {
      gw.ok = true
      gw.push({ type: "gateway.ready" })
    }

    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Connecting") && t.frame().includes("lazy-model"))

    act(() => {
      t.gw.push({ type: "message.start" })
    })
    await until(t, () => t.frame().includes("Type to queue"))

    await act(async () => { await t.keys.typeText("queued while lazy") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("queued while lazy"))
    expect(t.gw.calls.filter(c => c.method === "prompt.submit").length).toBe(0)

    act(() => {
      t.gw.push({ type: "message.complete", payload: { text: "done" } })
    })
    await until(t, () => Boolean(t.gw.last("prompt.submit")))

    expect(t.gw.last("prompt.submit")?.params).toMatchObject({
      session_id: "lazy-sid",
      text: "queued while lazy",
    })
    t.destroy()
  })
})
