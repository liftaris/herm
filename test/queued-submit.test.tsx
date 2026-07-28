import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"
import { tmpHome } from "./fixture/home"

function info() {
  return { model: "test-model", session_id: "test-sid", tools: {}, skills: {} }
}

const stale = "stale queued prompt"

async function fill(t: Awaited<ReturnType<typeof mount>>) {
  act(() => t.gw.push({ type: "message.start" }))
  await until(t, () => t.frame().includes("Type to queue"))
  await act(async () => { await t.keys.typeText(stale) })
  act(() => t.keys.pressEnter())
  await until(t, () => t.frame().includes(`⏸ 1. ${stale}`))
}

const submitted = (gw: MockGateway) =>
  gw.calls.filter(c => c.method === "prompt.submit" && c.params.text === stale)

function loc(t: Awaited<ReturnType<typeof mount>>, text: string) {
  const rows = t.frame().split("\n")
  const y = rows.findIndex(r => r.includes(text))
  expect(y).toBeGreaterThan(-1)
  return { x: rows[y].indexOf(text), y }
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

  test("/new clears queued prompts before the replacement session can drain them", async () => {
    let n = 0
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/new", "new session"]] }),
      "session.create": () => ({ session_id: `sid-${++n}` }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))
    await fill(t)

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => n === 2 && t.frame().includes("Ready"))
    await t.settle()

    expect(submitted(gw)).toHaveLength(0)
    expect(t.frame()).not.toContain(stale)
    t.destroy()
  })

  test("/resume clears queued prompts before the resumed session can drain them", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/resume", "resume session"]] }),
      "session.resume": p => ({ session_id: p.session_id, messages: [] }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready"))
    await fill(t)

    await act(async () => { await t.keys.typeText("/resume second") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("session.resume")?.params.session_id === "second" && t.frame().includes("Ready"))
    await t.settle()

    expect(submitted(gw)).toHaveLength(0)
    expect(t.frame()).not.toContain(stale)
    await act(async () => { await t.keys.typeText("fresh second") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("prompt.submit")?.params.text === "fresh second")
    expect(gw.last("prompt.submit")?.params.session_id).toBe("second")
    t.destroy()
  })

  test("live activation clears queued prompts before the activated session can drain them", async () => {
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/sessions", "sessions"]] }),
      "session.active_list": () => ({ sessions: [
        { id: "live-a", title: "Live A", message_count: 1, started_at: 1700000000, status: "idle" },
      ]}),
      "session.activate": p => ({
        session_id: p.session_id,
        status: "idle",
        running: false,
        info: { model: "live-model", session_id: p.session_id, tools: {}, skills: {} },
        messages: [{ role: "user", text: "live seed" }],
      }),
    })
    const t = await mount({ gw, launch: { mode: "resume", sid: "first", splash: false } })
    await until(t, () => t.frame().includes("Ready"))
    await fill(t)

    await act(async () => { await t.keys.typeText("/sessions") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Live A"))
    const live = loc(t, "▸ Live A")
    await act(async () => { await t.mouse.click(live.x, live.y) })
    await until(t, () => gw.last("session.activate")?.params.session_id === "live-a" && t.frame().includes("live seed"))
    await t.settle()

    expect(submitted(gw)).toHaveLength(0)
    expect(t.frame()).not.toContain(stale)
    await act(async () => { await t.keys.typeText("fresh live") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("prompt.submit")?.params.text === "fresh live")
    expect(gw.last("prompt.submit")?.params.session_id).toBe("live-a")
    t.destroy()
  })

  test("profile switch clears queued prompts before the new profile can drain them", async () => {
    await using h = await tmpHome({
      files: {
        "config.yaml": "model:\n  default: test-model\n  provider: anthropic\n",
        "profiles/coder/config.yaml": "model:\n  default: coder-model\n  provider: anthropic\n",
      },
    })
    const gw = new MockGateway({
      "commands.catalog": () => ({ pairs: [["/profiles", "profiles"]] }),
    })
    const t = await mount({ gw, width: 200 })
    await until(t, () => t.frame().includes("Ready"))
    await fill(t)

    await act(async () => { await t.keys.typeText("/profiles") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Profiles (2)") && t.frame().includes("coder"))
    const row = loc(t, "coder")
    await act(async () => { await t.mouse.click(row.x, row.y) })
    await until(t, () => t.frame().includes("Profile · coder"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Switch to 'coder'?"))
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => process.env.HERMES_HOME === `${h.path}/profiles/coder` && t.frame().includes("Ready"))
    await t.settle()

    expect(submitted(gw)).toHaveLength(0)
    expect(t.frame()).not.toContain(stale)
    t.destroy()
  })
})
