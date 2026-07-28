import { describe, expect, test } from "bun:test"
import { act } from "react"
import * as preferences from "../src/context/preferences"
import { MockGateway, mount, until } from "./harness"

describe("session identity", () => {
  test("live routing stays live while reconnect and process-loss resume use durable id", async () => {
    let n = 0
    const gw = new MockGateway({
      "session.create": () => ({
        session_id: "live-create",
        stored_session_id: "dur-create",
        info: { model: "m", session_id: "live-create", stored_session_id: "dur-create", tools: {}, skills: {} },
      }),
      "session.resume": p => ({
        session_id: `live-resume-${++n}`,
        resumed: p.session_id,
        session_key: p.session_id,
        messages: [],
        info: { model: "m", session_id: `live-resume-${n}`, stored_session_id: p.session_id as string, tools: {}, skills: {} },
      }),
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => gw.last("session.create") !== undefined)

    expect(preferences.get("lastSessionId")).toBe("dur-create")

    await act(async () => { await t.keys.typeText("hello") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("prompt.submit") !== undefined)
    expect(gw.last("prompt.submit")?.params.session_id).toBe("live-create")

    act(() => gw.push({ type: "gateway.ready" }))
    await until(t, () => gw.calls.some(c => c.method === "session.resume" && c.params.session_id === "dur-create"))
    expect(gw.calls.filter(c => c.method === "session.resume").at(-1)?.params.session_id).toBe("dur-create")

    act(() => {
      gw.emit("exit", 1)
      gw.push({ type: "gateway.ready" })
    })
    await until(t, () => gw.calls.filter(c => c.method === "session.resume" && c.params.session_id === "dur-create").length >= 2)
    expect(gw.calls.filter(c => c.method === "session.resume").at(-1)?.params.session_id).toBe("dur-create")

    t.destroy()
  })

  test("session.info durable rotation updates the next resume target", async () => {
    const gw = new MockGateway({
      "session.create": () => ({
        session_id: "live-a",
        stored_session_id: "dur-a",
        info: { model: "m", session_id: "live-a", stored_session_id: "dur-a", tools: {}, skills: {} },
      }),
      "session.resume": p => ({
        session_id: "live-b",
        resumed: p.session_id,
        session_key: p.session_id,
        messages: [],
        info: { model: "m", session_id: "live-b", stored_session_id: p.session_id as string, tools: {}, skills: {} },
      }),
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => gw.last("session.create") !== undefined)

    act(() => gw.push({
      type: "session.info",
      session_id: "live-a",
      payload: { model: "m", session_id: "live-a", stored_session_id: "dur-b", tools: {}, skills: {} },
    }))
    await until(t, () => preferences.get("lastSessionId") === "dur-b")

    act(() => gw.push({ type: "gateway.ready" }))
    await until(t, () => gw.calls.some(c => c.method === "session.resume" && c.params.session_id === "dur-b"))
    expect(gw.last("session.resume")?.params.session_id).toBe("dur-b")

    t.destroy()
  })
})
