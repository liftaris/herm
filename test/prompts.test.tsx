import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"
import type { GatewayEvent } from "../src/context/wire"

describe("prompts", () => {

  async function expires(ev: GatewayEvent, visible: string, closed: string, method: string) {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({ type: "message.start" }))
    act(() => t.gw.push(ev))
    await until(t, () => t.frame().includes(visible))

    act(() => t.gw.push({
      type: "message.complete",
      payload: { text: "PROMPT_EXPIRED_DONE_SENTINEL", usage: { input: 0, output: 0, total: 0 } },
    }))
    await until(t, () => t.frame().includes("Timed out") && !t.frame().includes(closed))

    act(() => t.keys.pressKey("1"))
    await t.settle()
    expect(t.gw.last(method)).toBeUndefined()
    t.destroy()
  }

  test("clarify: open-ended (no choices) free-text input", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({
      type: "clarify.request",
      payload: { request_id: "q2", question: "explain?", choices: null },
    }))
    await t.settle()
    expect(t.frame()).toContain("explain?")

    await act(async () => { await t.keys.typeText("my custom answer") })
    await t.settle()
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.gw.last("clarify.respond")?.params.answer).toBe("my custom answer")
    t.destroy()
  })


  test("sudo: escape cancels with empty password", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({ type: "sudo.request", payload: { request_id: "su1" } }))
    await t.settle()
    expect(t.frame()).toContain("Sudo required")

    act(() => t.keys.pressEscape())
    await t.settle()
    expect(t.gw.last("sudo.respond")?.params).toMatchObject({ request_id: "su1", password: "" })
    expect(t.frame()).not.toContain("Sudo required")
    t.destroy()
  })

  test("approval response failure keeps the card retryable", async () => {
    let fail = true
    const gw = new MockGateway({
      "approval.respond": () => {
        if (fail) throw new Error("approval wire down")
        return { resolved: true }
      },
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))
    act(() => gw.push({ type: "approval.request", payload: { command: "rm x", description: "delete" } }))
    await until(t, () => t.frame().includes("Permission required"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("approval wire down"))
    expect(t.frame()).toContain("Permission required")

    fail = false
    act(() => t.keys.pressEnter())
    await until(t, () => !t.frame().includes("Permission required"))
    expect(gw.calls.filter(c => c.method === "approval.respond")).toHaveLength(2)
    t.destroy()
  })

  test("clarify response failure keeps the question retryable", async () => {
    let fail = true
    const gw = new MockGateway({
      "clarify.respond": () => {
        if (fail) throw new Error("clarify wire down")
        return { resolved: true }
      },
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))
    act(() => gw.push({
      type: "clarify.request",
      payload: { request_id: "q-retry", question: "retry choice?", choices: ["yes", "no"] },
    }))
    await until(t, () => t.frame().includes("retry choice?"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("clarify wire down"))
    expect(t.frame()).toContain("retry choice?")

    fail = false
    act(() => t.keys.pressEnter())
    await until(t, () => !t.frame().includes("Other (type your answer)"))
    expect(t.frame()).not.toContain("clarify wire down")
    expect(gw.calls.filter(c => c.method === "clarify.respond")).toHaveLength(2)
    t.destroy()
  })

  test("secret response failure preserves the masked value for retry", async () => {
    let fail = true
    const gw = new MockGateway({
      "secret.respond": () => {
        if (fail) throw new Error("secret wire down")
        return { resolved: true }
      },
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))
    act(() => gw.push({
      type: "secret.request",
      payload: { request_id: "s-retry", prompt: "token?", env_var: "TOKEN" },
    }))
    await until(t, () => t.frame().includes("Secret: TOKEN"))
    await act(async () => { await t.keys.typeText("hunter2") })

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("secret wire down"))
    expect(t.frame()).toContain("•".repeat(7))

    fail = false
    act(() => t.keys.pressEnter())
    await until(t, () => !t.frame().includes("Secret: TOKEN"))
    expect(gw.calls.filter(c => c.method === "secret.respond")).toHaveLength(2)
    t.destroy()
  })

  test("clarify prompt expires on message.complete and cannot answer later", async () => {
    await expires({
      type: "clarify.request",
      payload: { request_id: "clarify-exp", question: "EXPIRING_CLARIFY_SENTINEL", choices: ["yes"] },
    }, "EXPIRING_CLARIFY_SENTINEL", "Other (type your answer)", "clarify.respond")
  })

  test("sudo prompt expires on message.complete and cannot answer later", async () => {
    await expires({ type: "sudo.request", payload: { request_id: "sudo-exp" } }, "Sudo required", "Enter your password", "sudo.respond")
  })

  test("secret prompt expires on message.complete and cannot answer later", async () => {
    await expires({
      type: "secret.request",
      payload: { request_id: "secret-exp", prompt: "SECRET_PROMPT_SHOULD_DISAPPEAR", env_var: "EXPIRING_TOKEN" },
    }, "Secret: EXPIRING_TOKEN", "SECRET_PROMPT_SHOULD_DISAPPEAR", "secret.respond")
  })

  test("terminal-read prompt expires on message.complete and cannot answer later", async () => {
    await expires({
      type: "terminal.read.request",
      payload: { request_id: "term-exp", start: 10, count: 20 },
    }, "Terminal read required", "Enter/Esc returns empty", "terminal.read.respond")
  })
})

describe("diagnostics", () => {
  test("errorish gateway.stderr surfaces in transcript", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    const feed: GatewayEvent[] = [
      { type: "gateway.stderr", payload: { line: "DEBUG loaded tools" } },           // benign → hidden
      { type: "gateway.stderr", payload: { line: "Traceback (most recent call last):" } },
      { type: "gateway.stderr", payload: { line: "⚠️  API call failed (HTTP 404)" } },
    ]
    act(() => { for (const ev of feed) t.gw.push(ev) })
    await t.settle()

    const f = t.frame()
    expect(f).toContain("Traceback")
    expect(f).toContain("API call failed")
    expect(f).not.toContain("DEBUG loaded tools")
    t.destroy()
  })

  test("/logs opens dialog showing full stderr tail", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => {
      t.gw.push({ type: "gateway.stderr", payload: { line: "line one benign" } })
      t.gw.push({ type: "gateway.stderr", payload: { line: "line two ERROR: boom" } })
    })
    await t.settle()

    await act(async () => { await t.keys.typeText("/logs") })
    await t.settle()
    act(() => t.keys.pressEnter())
    // stickyStart="bottom" scrollbox: pass 1 measures scrollHeight,
    // pass 2 applies the offset. Two settles, not until() polling.
    await t.settle()
    await t.settle()

    const f = t.frame()
    expect(f).toContain("Gateway Logs")
    // benign line NOT in transcript but IS in logs dialog
    expect(f).toContain("line one benign")
    expect(f).toContain("line two ERROR: boom")
    t.destroy()
  })
})
