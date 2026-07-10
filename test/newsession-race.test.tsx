// Regression: /new must clear the gateway's active sid before
// session.create lands. Without the reset, events arriving in the
// window between reset() and the new setSession(id) get auto-attributed
// to the outgoing session (stale-sid race). Mirrors switchProfile,
// which already clears via gw.setSession("") before respawn.

import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"

describe("newSession stale-sid reset", () => {
  test("/new clears gateway sid so session.create does not auto-inject the outgoing id", async () => {
    let n = 0
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/new", "new session"]] }),
      "session.create": () => ({ session_id: `sid-${++n}` }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    // Boot established sid-1 via session.create.
    expect(gw.calls.find(c => c.method === "session.create")?.params.session_id).toBeUndefined()

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.calls.filter(c => c.method === "session.create").length >= 2)

    // The second session.create (from /new) must NOT carry the outgoing
    // sid. If the reset is missing, gateway-client's auto-injection
    // will have stamped session_id: "sid-1" onto the merged params.
    const creates = gw.calls.filter(c => c.method === "session.create")
    expect(creates.length).toBe(2)
    expect(creates[1]?.params.session_id).toBeUndefined()

    // session.close still finalizes the outgoing session — it passes
    // prev explicitly, so the gateway-level sid clear doesn't affect it.
    await until(t, () => gw.last("session.close") !== undefined)
    expect(gw.last("session.close")?.params.session_id).toBe("sid-1")
    await until(t, () => t.frame().includes("Ready"))

    t.destroy()
  })

  test("failed /new keeps the outgoing session active and visible", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/new", "new session"]] }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
      "session.create": () => { throw new Error("create exploded") },
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "old-sid", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("create exploded"))

    expect(gw.last("session.close")).toBeUndefined()
    const creates = gw.calls.filter(c => c.method === "session.create")
    expect(creates.at(-1)?.params.session_id).toBeUndefined()
    await act(async () => { await t.keys.typeText("still here") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("prompt.submit")?.params.text === "still here")
    expect(gw.last("prompt.submit")?.params.session_id).toBe("old-sid")
    t.destroy()
  })

  test("late title sync cannot overwrite a newer session", async () => {
    let n = 0
    let resolveTitle!: (value: unknown) => void
    const title = new Promise(resolve => { resolveTitle = resolve })
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/new", "new session"]] }),
      "session.create": () => ({ session_id: `sid-${++n}` }),
      "session.title": () => title,
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    const clock = globalThis.setTimeout
    const fast = (handler: () => void, ms?: number) => clock(handler, ms === 1_200 ? 0 : ms)
    globalThis.setTimeout = fast as unknown as typeof setTimeout
    try {
      act(() => gw.push({ type: "message.complete", session_id: "sid-1", payload: { status: "complete" } }))
      await until(t, () => gw.calls.some(c => c.method === "session.title"))
    } finally {
      globalThis.setTimeout = clock
    }

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => n === 2 && t.frame().includes("Ready"))
    resolveTitle({ title: "Old session title", session_key: "sid-1" })
    await act(async () => { await Bun.sleep(0) })
    await t.settle()
    expect(t.frame()).not.toContain("Old session title")
    t.destroy()
  })

  test("overlapping /new commands create only one replacement session", async () => {
    let calls = 0
    let resolve!: (value: unknown) => void
    const gate = new Promise(resolveGate => { resolve = resolveGate })
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/new", "new session"]] }),
      "session.create": () => {
        if (++calls === 1) return { session_id: "old-sid" }
        return gate
      },
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => calls === 2)
    await act(async () => { await t.keys.typeText("leaked prompt") })
    act(() => t.keys.pressEnter())
    await act(async () => { await Bun.sleep(0) })
    expect(gw.last("prompt.submit")).toBeUndefined()
    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await act(async () => { await Bun.sleep(0) })
    expect(calls).toBe(2)

    resolve({ session_id: "new-sid" })
    await until(t, () => t.frame().includes("Ready"))
    t.destroy()
  })

  test("initial session boot failure surfaces the gateway error", async () => {
    const gw = new MockGateway({
      "session.create": () => { throw new Error("boot exploded") },
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Failed to start session: boot exploded"))
    expect(gw.last("prompt.submit")).toBeUndefined()
    t.destroy()
  })

  test("/new recovers when initial boot has no session id", async () => {
    let calls = 0
    const gw = new MockGateway({
      "session.create": () => {
        calls++
        if (calls === 1) throw new Error("boot exploded")
        return { session_id: "recovered-sid" }
      },
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Failed to start session: boot exploded"))

    await act(async () => { await t.keys.typeText("/new") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Start a new session?"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => calls === 2 && t.frame().includes("Ready"))
    expect(gw.last("prompt.submit")).toBeUndefined()
    t.destroy()
  })
})
