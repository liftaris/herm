import { beforeEach, describe, expect, test } from "bun:test"
import { act, createRef } from "react"
import { mount, mountNode, until, MockGateway } from "./harness"
import * as prefs from "../src/context/preferences"
import { PromptCard, type PromptCardHandle } from "../src/components/chat/PromptCard"
import type { NeverPrompt } from "../src/context/preferences"
import type { PromptPart, PromptReq } from "../src/types/message"

type ApprovalReq = Extract<PromptReq, { variant: "approval" }>

const req = (over: Partial<ApprovalReq> = {}): ApprovalReq => ({
  variant: "approval",
  command: "rm -rf /tmp/a",
  description: "Run dangerous command?",
  ...over,
})

const part = (over: Partial<ApprovalReq> = {}): PromptPart => ({
  type: "prompt",
  id: "approval-test",
  variant: "approval",
  req: req(over),
})

const prefsAny = prefs as typeof prefs & {
  get: (key: "neverPrompts") => NeverPrompt[] | undefined
  set: (key: "neverPrompts", value: NeverPrompt[]) => void
}

beforeEach(() => {
  prefs.reset()
  prefsAny.set("neverPrompts", [])
})

describe("approval memory", () => {
  test("normal approval prompt path sends once when no memory exists", async () => {
    const gw = new MockGateway(); gw.ok = true
    const ref = createRef<PromptCardHandle>()
    await using t = await mountNode(
      <PromptCard ref={ref} part={part({ pattern_keys: ["rm_recursive"] })} onAnswer={() => {}} />,
      { gw },
    )

    expect(t.frame()).toContain("Permission required")
    expect(t.frame()).toContain("$ rm -rf /tmp/a")
    expect(gw.calls.filter(c => c.method === "approval.respond").length).toBe(0)

    act(() => ref.current!.feed({ name: "1" } as never))
    await t.settle()

    expect(gw.last("approval.respond")?.params.choice).toBe("once")
    expect(prefsAny.get("neverPrompts")).toEqual([])
  })

  test("stores never_prompts for a specific question and pattern_keys-derived subject", async () => {
    const gw = new MockGateway(); gw.ok = true
    const ref = createRef<PromptCardHandle>()
    await using t = await mountNode(
      <PromptCard ref={ref} part={part({ pattern_keys: ["rm_recursive", "tmp_write"] })} onAnswer={() => {}} />,
      { gw },
    )

    act(() => ref.current!.feed({ name: "3" } as never))
    await t.settle()

    expect(gw.last("approval.respond")?.params.choice).toBe("always")
    expect(prefsAny.get("neverPrompts")).toEqual([
      { group: "approval", question: "Run dangerous command?", subject: "rm_recursive|tmp_write" },
    ])
  })

  test("reuses memory for the same question and pattern_keys-derived subject", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "rm -rf /tmp/a", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
    }))
    await t.settle()
    act(() => t.keys.pressKey("3"))
    await t.settle()

    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "rm -rf /tmp/b", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
    }))
    await t.settle()

    expect(t.gw.calls.filter(c => c.method === "approval.respond").length).toBe(2)
    expect(t.gw.last("approval.respond")?.params.choice).toBe("always")
    expect(t.frame()).not.toContain("$ rm -rf /tmp/b")
    t.destroy()
  })

  test("failed remembered response restores the approval prompt", async () => {
    prefsAny.set("neverPrompts", [
      { group: "approval", question: "Run dangerous command?", subject: "rm_recursive|tmp_write" },
    ])
    const gw = new MockGateway({
      "approval.respond": () => { throw new Error("approval wire down") },
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))
    act(() => gw.push({
      type: "approval.request",
      payload: { command: "rm -rf /tmp/retry", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
    }))

    await until(t, () => t.frame().includes("approval wire down") && t.frame().includes("$ rm -rf /tmp/retry"))
    t.destroy()
  })

  test("failed remembered response does not leak into a replacement session", async () => {
    prefsAny.set("neverPrompts", [
      { group: "approval", question: "Run dangerous command?", subject: "rm_recursive|tmp_write" },
    ])
    let fail!: (error: Error) => void
    let creates = 0
    const pending = new Promise<never>((_resolve, reject) => { fail = reject })
    const gw = new MockGateway({
      "approval.respond": () => pending,
      "session.create": () => ({ session_id: `sid-${++creates}` }),
    })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))
    act(() => gw.push({
      type: "approval.request",
      payload: { command: "rm -rf /tmp/stale", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
    }))
    await until(t, () => gw.last("approval.respond") !== undefined)

    await act(async () => { await t.keys.typeText("/new now") })
    act(() => t.keys.pressEnter())
    await until(t, () => creates === 2 && t.frame().includes("Ready"))
    fail(new Error("old approval failed"))
    await act(async () => { await Bun.sleep(20) })
    await t.settle()
    expect(t.frame()).not.toContain("$ rm -rf /tmp/stale")
    await act(async () => { await t.keys.typeText("fresh message") })
    act(() => t.keys.pressEnter())
    await until(t, () => gw.last("prompt.submit")?.params.text === "fresh message")
    t.destroy()
  })

  test("does not reuse memory for a different question or different subject", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "rm -rf /tmp/a", description: "Run dangerous command?", pattern_keys: ["rm_recursive", "tmp_write"] },
    }))
    await t.settle()
    act(() => t.keys.pressKey("3"))
    await t.settle()

    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "rm -rf /tmp/b", description: "Run package manager?", pattern_keys: ["rm_recursive", "tmp_write"] },
    }))
    await t.settle()
    expect(t.gw.calls.filter(c => c.method === "approval.respond").length).toBe(1)
    expect(t.frame()).toContain("Run package manager?")
    act(() => t.keys.pressEscape())
    await t.settle()

    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "cat /tmp/a", description: "Run dangerous command?", pattern_keys: ["tmp_read"] },
    }))
    await t.settle()
    expect(t.gw.calls.filter(c => c.method === "approval.respond").length).toBe(2)
    expect(t.frame()).toContain("$ cat /tmp/a")
    t.destroy()
  })

  test("falls back to command as subject when approval.request.pattern_keys is missing", async () => {
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))
    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "bun add zod", description: "Run package manager?" },
    }))
    await t.settle()
    expect(t.frame()).toContain("subject: bun add zod")
    act(() => t.keys.pressKey("3"))
    await t.settle()

    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "bun add zod", description: "Run package manager?" },
    }))
    await t.settle()
    expect(t.gw.calls.filter(c => c.method === "approval.respond").length).toBe(2)

    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "bun update zod", description: "Run package manager?" },
    }))
    await t.settle()
    expect(t.gw.calls.filter(c => c.method === "approval.respond").length).toBe(2)
    expect(t.frame()).toContain("$ bun update zod")
    t.destroy()
  })

  test("resolve_all memory is scoped by group", async () => {
    prefsAny.set("neverPrompts", [
      { group: "slash", question: "Run dangerous command?", subject: "rm_recursive" },
    ])
    const t = await mount()
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({
      type: "approval.request",
      payload: { command: "rm -rf /tmp/a", description: "Run dangerous command?", pattern_keys: ["rm_recursive"] },
    }))
    await t.settle()

    expect(t.gw.calls.filter(c => c.method === "approval.respond").length).toBe(0)
    expect(t.frame()).toContain("Permission required")
    t.destroy()
  })
})
