// Regression: /new and session-switch finalize idle outgoing gateway
// sessions via session.close. Without it the gateway leaks one slash_worker
// subprocess + one live AIAgent per hop and leaves the DB row's
// `ended_at IS NULL`, which breaks lineage classification until quit.
// A running background process is the exception: older gateways kill
// terminal(background=true) children from session.close, so Herm preserves
// that live session instead of SIGTERM'ing a watcher.

import { afterAll, describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"
import { openStateDb } from "./fixtures/state-db"
import { resetDb } from "../src/service/sessions-db"

const wipe = () => {
  const db = openStateDb()
  db.run("DELETE FROM messages")
  db.run("DELETE FROM sessions")
  db.close()
  resetDb()
}

const seed = () => {
  const db = openStateDb()
  db.run("DELETE FROM messages")
  db.run("DELETE FROM sessions")
  db.run(`INSERT INTO sessions (id, source, model, billing_provider, started_at, message_count)
    VALUES ('past', 'tui', 'gpt-5.5', 'openai-codex', 1000, 2)`)
  db.close()
  resetDb()
}

afterAll(wipe)

describe("session.close", () => {
  test("/new closes the outgoing session", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/new", "new session"]] }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    // Boot path created (or resumed) → sid is test-sid.
    expect(t.gw.last("session.close")).toBeUndefined()

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("session.close") !== undefined)

    expect(t.gw.last("session.close")?.params.session_id).toBe("test-sid")
    expect(t.gw.last("session.create")).toBeDefined()

    t.destroy()
  })

  test("switchSession closes prev after resume succeeds", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    // Boot resumed "first"; no close yet.
    expect(t.gw.last("session.close")).toBeUndefined()

    // Switch via /resume <sid> — routes through switchSession.
    await act(async () => { await t.keys.typeText("/resume second") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("session.close") !== undefined)

    expect(t.gw.last("session.close")?.params.session_id).toBe("first")
    // Resume landed on the target — close ran only after that.
    const ri = gw.calls.findIndex(c => c.method === "session.resume" && c.params.session_id === "second")
    const ci = gw.calls.findIndex(c => c.method === "session.close")
    expect(ri).toBeGreaterThan(-1)
    expect(ci).toBeGreaterThan(ri)

    t.destroy()
  })

  test("switchSession preserves prev while a background process runs", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "agents.list": () => ({ processes: [
        { session_id: "proc_watch", command: "watch", status: "running", uptime: 1 },
      ] }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/resume second") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("agents.list") !== undefined)

    expect(gw.calls.some(c => c.method === "session.resume" && c.params.session_id === "second")).toBe(true)
    expect(t.gw.last("session.close")).toBeUndefined()

    t.destroy()
  })

  test("switchSession preserves prev when background ownership is unknown", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "agents.list": () => { throw new Error("agents unavailable") },
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/resume second") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("agents.list") !== undefined)
    expect(gw.calls.some(call => call.method === "session.resume" && call.params.session_id === "second")).toBe(true)
    expect(gw.last("session.close")).toBeUndefined()
    t.destroy()
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
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.calls.filter(c => c.method === "session.create").length >= 2)
    await until(t, () => gw.last("agents.list") !== undefined)

    expect(t.gw.last("session.close")).toBeUndefined()

    t.destroy()
  })

  test("switchSession restores ready when pre-response session.info is filtered", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "session.create": () => ({ session_id: "old" }),
      "session.resume": p => {
        gw.push({ type: "session.info", session_id: "new", payload: { session_id: "new", model: "m", tools: {}, skills: {} } })
        return { session_id: "new", resumed: p.session_id, messages: [{ role: "user", text: "hello" }] }
      },
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/resume past") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("session.resume")?.params.session_id === "past")
    await until(t, () => t.frame().includes("Ready") && t.frame().includes("hello"))

    expect(t.frame()).not.toContain("Connecting")
    expect(t.gw.last("session.close")?.params.session_id).toBe("old")

    t.destroy()
  })

  test("switchSession resumes without stored model preconfigure", async () => {
    seed()
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "session.create": () => ({ session_id: "old" }),
      "config.set": () => { throw new Error("unexpected model switch") },
      "session.resume": p => ({
        session_id: "live-past",
        resumed: p.session_id,
        messages: [{ role: "user", text: "hello" }],
        info: {
          model: "gpt-5.5",
          session_id: "live-past",
          tools: {},
          skills: {},
          usage: {
            input: 0,
            output: 0,
            total: 0,
            context_used: 110_000,
            context_max: 256_000,
          },
        },
      }),
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/resume past") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Ready") && t.frame().includes("hello"))

    expect(gw.calls.some(c => c.method === "config.set")).toBe(false)
    expect(gw.last("session.resume")?.params.session_id).toBe("past")
    expect(t.frame()).toContain("110K / 256K")

    t.destroy()
  })

  test("Sessions tab resumes without stored model preconfigure", async () => {
    seed()
    const row = { id: "past", title: "Past", preview: "hello", message_count: 2, started_at: 1000, source: "tui" }
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/sessions", "sessions"]] }),
      "session.create": () => ({ session_id: "old" }),
      "session.list": () => ({ sessions: [row] }),
      "config.set": () => { throw new Error("unexpected model switch") },
      "session.resume": p => ({
        session_id: "live-past",
        resumed: p.session_id,
        messages: [{ role: "user", text: "hello" }],
        info: {
          model: "gpt-5.5",
          session_id: "live-past",
          tools: {},
          skills: {},
          usage: {
            input: 0,
            output: 0,
            total: 0,
            context_used: 110_000,
            context_max: 256_000,
          },
        },
      }),
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/sessions") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Sessions (1)"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Load session?"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => t.frame().includes("Ready") && t.frame().includes("hello"))

    expect(gw.calls.some(c => c.method === "config.set")).toBe(false)
    expect(gw.last("session.resume")?.params.session_id).toBe("past")
    expect(t.frame()).toContain("110K / 256K")
    expect(t.frame()).not.toContain("Connecting")

    t.destroy()
  })

  test("switchSession ignores stale stored model", async () => {
    seed()
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "session.create": () => ({ session_id: "old" }),
      "config.set": () => { throw new Error("unexpected model switch") },
      "session.resume": p => ({
        session_id: "live-past",
        resumed: p.session_id,
        messages: [{ role: "user", text: "hello" }],
      }),
    })
    const t = await mount({ gw, launch: { mode: "new", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/resume past") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Ready") && t.frame().includes("hello"))

    expect(gw.calls.some(c => c.method === "config.set")).toBe(false)
    expect(t.frame()).not.toContain("Stored session model unavailable")
    expect(t.frame()).not.toContain("Failed to resume")
    expect(t.frame()).not.toContain("Connecting")
    expect(gw.last("session.close")?.params.session_id).toBe("old")
    expect(gw.calls.some(c => c.method === "session.resume" && c.params.session_id === "past")).toBe(true)

    await act(async () => { await t.keys.typeText("now live") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    expect(t.gw.last("prompt.submit")?.params.session_id).toBe("live-past")

    t.destroy()
  })

  test("switchSession keeps prev live when resume fails", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "session.resume": p => {
        if (p.session_id === "bad") throw new Error("nope")
        return { session_id: p.session_id, messages: [{ role: "user", text: "old transcript" }] }
      },
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready") && t.frame().includes("old transcript"))

    await act(async () => { await t.keys.typeText("/resume bad") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Failed to resume"))

    // No close — user is still on "first", which must stay live and usable.
    expect(t.gw.last("session.close")).toBeUndefined()
    expect(t.frame()).not.toContain("Connecting")
    expect(t.frame()).toContain("old transcript")

    await act(async () => { await t.keys.typeText("still here") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("prompt.submit") !== undefined)
    expect(t.gw.last("prompt.submit")?.params.session_id).toBe("first")

    t.destroy()
  })

  test("switchSession to self does not close", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "same", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/resume same") })
    act(() => t.keys.pressEnter())
    // Wait for the second resume (first was boot) to land.
    await until(t, () => gw.calls.filter(c => c.method === "session.resume").length >= 2)

    expect(t.gw.last("session.close")).toBeUndefined()

    t.destroy()
  })

  test("live session activation does not close the outgoing session and hydrates inflight", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/sessions", "sessions"]] }),
      "session.active_list": () => ({ sessions: [
        { id: "live-a", title: "Live A", message_count: 2, started_at: 1700000000, status: "working" },
      ]}),
      "session.activate": p => ({
        session_id: p.session_id,
        session_key: "live-key",
        status: "working",
        running: true,
        started_at: 1700000000,
        info: { model: "live-model", session_id: p.session_id, tools: {}, skills: {} },
        messages: [
          { role: "user", text: "older question" },
          { role: "assistant", text: "older answer" },
        ],
        inflight: { user: "new question", assistant: "partial answer", streaming: true },
      }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/sessions") })
    act(() => t.keys.pressEnter())
    await until(t, () => {
      const f = t.frame()
      return f.includes("Sessions (") && f.includes("Live A") && !f.includes("Live Sessions")
    })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("partial answer"))

    expect(t.gw.last("session.activate")?.params.session_id).toBe("live-a")
    expect(t.gw.last("session.close")).toBeUndefined()
    expect(t.frame()).toContain("new question")

    t.destroy()
  })
})
