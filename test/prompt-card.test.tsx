import { describe, test, expect } from "bun:test"
import { act, createRef } from "react"
import { mountNode, until, MockGateway } from "./harness"
import { PromptCard, pending, type PromptCardHandle } from "../src/components/chat/PromptCard"
import type { PromptPart, Part } from "../src/types/message"

const approval = (over: Partial<Extract<PromptPart["req"], { variant: "approval" }>> = {}): PromptPart => ({
  type: "prompt", id: "a1", variant: "approval",
  req: { variant: "approval", command: "rm -rf /tmp/x", description: "recursive rm", ...over },
})

describe("PromptCard.Approval", () => {
  test("renders command + pattern_keys; 1..4/Enter/Esc dispatch approval.respond", async () => {
    const gw = new MockGateway(); gw.ok = true
    const ref = createRef<PromptCardHandle>()
    const answers: string[] = []
    await using t = await mountNode(
      <PromptCard ref={ref}
        part={approval({ pattern_keys: ["rm_recursive", "tmp_write"] })}
        onAnswer={(_, label) => answers.push(label)} />,
      { gw },
    )
    const f = t.frame()
    expect(f).toContain("$ rm -rf /tmp/x")
    expect(f).toContain("recursive rm")
    expect(f).toContain("rm_recursive, tmp_write")
    expect(f).toContain("Allow once")
    expect(f).toContain("Deny")
    expect(f).toContain("Steer")

    act(() => ref.current!.feed({ name: "2" } as never))
    await t.settle()
    expect(gw.last("approval.respond")?.params.choice).toBe("session")
    expect(answers).toEqual(["Allow this session"])
    // second send is ignored (done latch)
    act(() => ref.current!.feed({ name: "4" } as never))
    await t.settle()
    expect(gw.calls.filter(c => c.method === "approval.respond").length).toBe(1)
  })

  test("←/→ wraps, Enter sends selection", async () => {
    const gw = new MockGateway(); gw.ok = true
    const ref = createRef<PromptCardHandle>()
    await using t = await mountNode(
      <PromptCard ref={ref} part={approval()} onAnswer={() => {}} />,
      { gw },
    )
    act(() => ref.current!.feed({ name: "left" } as never))
    act(() => ref.current!.feed({ name: "return" } as never))
    await t.settle()
    expect(gw.last("approval.respond")?.params.choice).toBe("deny")
  })

  test("steer opens input, submits session.steer, and keeps approval pending", async () => {
    const gw = new MockGateway({ "session.steer": p => ({ status: "queued", text: p.text }) })
    gw.ok = true
    const ref = createRef<PromptCardHandle>()
    const answers: string[] = []
    await using t = await mountNode(
      <PromptCard ref={ref} part={approval()} onAnswer={(_, label) => answers.push(label)} />,
      { gw },
    )

    act(() => ref.current!.feed({ name: "s" } as never))
    await until(t, () => t.frame().includes("Enter steer"))
    await act(async () => { await t.keys.typeText("use ls first") })
    await until(t, () => t.frame().includes("use ls first"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.gw.last("session.steer")?.params.text === "use ls first")

    expect(gw.last("approval.respond")).toBeUndefined()
    expect(answers).toEqual([])
    expect(t.frame()).toContain("steer sent")
    expect(t.frame()).toContain("Deny")
  })

  test("steer input escape returns to approval without RPC", async () => {
    const gw = new MockGateway(); gw.ok = true
    const ref = createRef<PromptCardHandle>()
    await using t = await mountNode(
      <PromptCard ref={ref} part={approval()} onAnswer={() => {}} />,
      { gw },
    )

    act(() => ref.current!.feed({ name: "s" } as never))
    await until(t, () => t.frame().includes("Enter steer"))
    act(() => ref.current!.feed({ name: "escape" } as never))
    await until(t, () => t.frame().includes("s steer"))

    expect(gw.last("session.steer")).toBeUndefined()
    expect(gw.last("approval.respond")).toBeUndefined()
  })

  test("answered part collapses to Outcome line", async () => {
    await using t = await mountNode(
      <PromptCard part={{ ...approval(), answered: { label: "Allow once", ok: true, at: 0, question: "recursive rm" } }}
        onAnswer={() => {}} />,
    )
    expect(t.frame()).toContain("✓")
    expect(t.frame()).toContain("Allow once")
    expect(t.frame()).toContain("recursive rm")
    expect(t.frame()).not.toContain("$ rm")
  })

  test("answered approval and secret outcomes preserve safe context only", async () => {
    await using t = await mountNode(
      <box flexDirection="column">
        <PromptCard part={{
          ...approval({ command: "cat /etc/shadow", description: "read shadow" }),
          answered: { label: "Deny", ok: false, at: 0, question: "read shadow" },
        }} onAnswer={() => {}} />
        <PromptCard part={{
          type: "prompt", id: "s1", variant: "secret",
          req: { variant: "secret", request_id: "s1", prompt: "paste token hunter2", env_var: "API_KEY" },
          answered: { label: "(provided)", ok: true, at: 0, question: "Secret: API_KEY" },
        }} onAnswer={() => {}} />
      </box>,
    )
    const f = t.frame()
    expect(f).toContain("read shadow")
    expect(f).not.toContain("cat /etc/shadow")
    expect(f).toContain("API_KEY (provided)")
    expect(f).not.toContain("hunter2")
    expect(f).not.toContain("paste token")
  })
})

describe("PromptCard.Clarify", () => {
  test("choice list: ↓ + Enter sends; 'Other' opens freeform", async () => {
    const gw = new MockGateway(); gw.ok = true
    const ref = createRef<PromptCardHandle>()
    const part: PromptPart = {
      type: "prompt", id: "c1", variant: "clarify",
      req: { variant: "clarify", request_id: "r1", question: "which?", choices: ["A", "B"] },
    }
    await using t = await mountNode(
      <PromptCard ref={ref} part={part} onAnswer={() => {}} />, { gw },
    )
    expect(t.frame()).toContain("which?")
    expect(t.frame()).toContain("Other")
    act(() => ref.current!.feed({ name: "down" } as never))
    act(() => ref.current!.feed({ name: "return" } as never))
    await t.settle()
    expect(gw.last("clarify.respond")?.params).toMatchObject({ request_id: "r1", answer: "B" })
  })

  test("answered outcomes keep question and selected/freeform answers visible", async () => {
    const long = "write a concise status update that explains the work done without mentioning private implementation process details"
    await using t = await mountNode(
      <box flexDirection="column">
        <PromptCard part={{
          type: "prompt", id: "c1", variant: "clarify",
          req: { variant: "clarify", request_id: "r1", question: "which one?", choices: ["red", "blue"] },
          answered: { label: "blue", ok: true, at: 0, question: "which one?" },
        }} onAnswer={() => {}} />
        <PromptCard part={{
          type: "prompt", id: "c2", variant: "clarify",
          req: { variant: "clarify", request_id: "r2", question: long, choices: null },
          answered: { label: "Use the shorter terminal-friendly wording", ok: true, at: 0, question: long },
        }} onAnswer={() => {}} />
      </box>,
      { width: 90, height: 20 },
    )
    const f = t.frame()
    expect(f).toContain("which one?")
    expect(f).toContain("blue")
    expect(f).toContain("write a concise status update")
    expect(f).toContain("Use the shorter terminal-friendly wording")
  })
})

describe("pending()", () => {
  test("finds the latest unanswered prompt part across messages", () => {
    const parts = (...ps: Part[]) => ({ role: "assistant" as const, parts: ps })
    const a = approval()
    const done = { ...approval(), id: "a0", answered: { label: "x", ok: true, at: 0 } }
    expect(pending([parts(done)])).toBeNull()
    expect(pending([parts(done), parts({ type: "text", content: "hi", streaming: false }, a)])).toBe(a)
  })
})
