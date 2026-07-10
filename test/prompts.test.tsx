import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"
import type { GatewayEvent } from "../src/context/wire"

describe("prompts", () => {
  test("approval: digit quick-pick sends matching choice", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({ type: "approval.request", payload: { command: "ls", description: "list" } }))
    await t.settle()
    expect(t.frame()).toContain("△ Permission required")
    expect(t.frame()).toContain("$ ls")

    act(() => t.keys.pressKey("2"))
    await t.settle()
    expect(t.gw.last("approval.respond")?.params.choice).toBe("session")
    expect(t.frame()).not.toContain("Permission required")
    t.destroy()
  })

  test("approval: ←/→ pill nav wraps; Enter sends selected", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({ type: "approval.request", payload: { command: "x", description: "" } }))
    await t.settle()
    expect(t.frame()).toContain("Shell command")

    act(() => t.keys.pressArrow("left"))   // wraps to deny
    act(() => t.keys.pressArrow("left"))   // → always
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.gw.last("approval.respond")?.params.choice).toBe("always")
    t.destroy()
  })

  test("clarify: choice list, Enter sends selected choice", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({
      type: "clarify.request",
      payload: { request_id: "q1", question: "pick one", choices: ["alpha", "beta"] },
    }))
    await t.settle()
    expect(t.frame()).toContain("pick one")
    expect(t.frame()).toContain("alpha")

    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.gw.last("clarify.respond")?.params).toMatchObject({ request_id: "q1", answer: "beta" })
    t.destroy()
  })

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

  test("secret: value masked in frame, submitted on Enter, empty on Escape", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({
      type: "secret.request",
      payload: { request_id: "s1", prompt: "api key?", env_var: "X_KEY" },
    }))
    await t.settle()
    expect(t.frame()).toContain("X_KEY")

    await act(async () => { await t.keys.typeText("hunter2") })
    await t.settle()
    // value must NOT appear in the rendered frame
    expect(t.frame()).not.toContain("hunter2")
    // bullets overlay present
    expect(t.frame()).toContain("•".repeat(7))

    act(() => t.keys.pressEnter())
    await t.settle()
    expect(t.gw.last("secret.respond")?.params).toMatchObject({ request_id: "s1", value: "hunter2" })
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
