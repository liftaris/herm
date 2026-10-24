import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"

const previous = process.env.HERM_GATEWAY_URL
beforeEach(() => { process.env.HERM_GATEWAY_URL = "ws://remote.test/api/ws" })
afterEach(() => {
  if (previous === undefined) delete process.env.HERM_GATEWAY_URL
  else process.env.HERM_GATEWAY_URL = previous
})

describe("explicit remote dashboard background ownership", () => {
  test("switchSession preserves prev while a background process runs", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "agents.list": () => ({ processes: [
        { session_id: "proc_watch", command: "watch", status: "running", uptime: 1 },
      ] }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    await using t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/resume second") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("agents.list") !== undefined)

    expect(gw.calls.some(c => c.method === "session.resume" && c.params.session_id === "second")).toBe(true)
    expect(t.gw.last("session.close")).toBeUndefined()

  })

  test("switchSession preserves prev when background ownership is unknown", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "agents.list": () => { throw new Error("agents unavailable") },
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    await using t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/resume second") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("agents.list") !== undefined)
    expect(gw.calls.some(call => call.method === "session.resume" && call.params.session_id === "second")).toBe(true)
    expect(gw.last("session.close")).toBeUndefined()
  })

  test("/new preserves prev while a background process runs", async () => {
    let n = 0
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/new", "new session"]] }),
      "agents.list": () => ({ processes: [
        { session_id: "proc_watch", command: "watch", status: "running", uptime: 1 },
      ] }),
      "session.create": () => ({ session_id: `sid-${++n}` }),
    })
    await using t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.calls.filter(c => c.method === "session.create").length >= 2)
    await until(t, () => gw.last("agents.list") !== undefined)

    expect(t.gw.last("session.close")).toBeUndefined()

  })

})
