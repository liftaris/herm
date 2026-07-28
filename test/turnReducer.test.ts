import { describe, expect, test } from "bun:test"
import { turnReducer, initialTurn, transcriptToMessages, type Action, type TurnState } from "../src/app/turnReducer"
import type { Part, ToolPart } from "../src/types/message"

function run(actions: Action[]): TurnState {
  return actions.reduce(turnReducer, initialTurn)
}

function last(s: TurnState) { return s.messages[s.messages.length - 1] }
function kinds(parts: Part[]) { return parts.map(p => p.type) }

describe("turnReducer", () => {
  test("delta accumulates into one streaming text part", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "hel" },
      { kind: "message.delta", chunk: "lo" },
    ])
    expect(s.streaming).toBe(true)
    const m = last(s)
    expect(m.role).toBe("assistant")
    expect(m.parts).toHaveLength(1)
    expect(m.parts[0]).toMatchObject({ type: "text", content: "hello", streaming: true })
  })

  test("tool.start seals open text; text→tool→text yields three parts in order", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "before " },
      { kind: "tool.start", id: "t1", name: "read_file" },
      { kind: "tool.complete", id: "t1", summary: "ok" },
      { kind: "message.delta", chunk: "after" },
    ])
    const parts = last(s).parts
    expect(kinds(parts)).toEqual(["text", "tool", "text"])
    expect(parts[0]).toMatchObject({ content: "before ", streaming: false })
    expect(parts[1]).toMatchObject({ id: "t1", status: "done", preview: "ok" })
    expect(parts[2]).toMatchObject({ content: "after", streaming: true })
  })

  test("reference block is committed before aggregator answer", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "reference", text: "◇ Reference 1/2 — openrouter:openai/gpt-5.5\nParis." },
      { kind: "message.delta", chunk: "The answer is Paris." },
      { kind: "message.complete" },
    ])
    const parts = last(s).parts
    expect(kinds(parts)).toEqual(["text", "text"])
    expect(parts[0]).toMatchObject({ content: "◇ Reference 1/2 — openrouter:openai/gpt-5.5\nParis.", streaming: false })
    expect(parts[1]).toMatchObject({ content: "The answer is Paris.", streaming: false })
  })

  test("interim text seals a distinct chronological segment", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.interim", text: "INTERIM_TEXT_SENTINEL" },
      { kind: "tool.start", id: "t1", name: "read_file" },
      { kind: "tool.complete", id: "t1", summary: "ok" },
      { kind: "message.delta", chunk: "FINAL_TEXT_SENTINEL" },
      { kind: "message.complete", text: "FINAL_TEXT_SENTINEL" },
    ])
    const parts = last(s).parts
    expect(kinds(parts)).toEqual(["text", "tool", "text"])
    expect(parts[0]).toMatchObject({ content: "INTERIM_TEXT_SENTINEL", streaming: false })
    expect(parts[2]).toMatchObject({ content: "FINAL_TEXT_SENTINEL", streaming: false })
  })

  test("already-streamed interim seals open text without duplicating it", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "STREAMED_INTERIM_SENTINEL" },
      { kind: "message.interim", text: "STREAMED_INTERIM_SENTINEL", streamed: true },
      { kind: "tool.start", id: "t1", name: "terminal" },
      { kind: "message.delta", chunk: "FINAL_AFTER_TOOL_SENTINEL" },
      { kind: "message.complete", text: "FINAL_AFTER_TOOL_SENTINEL" },
    ])
    const parts = last(s).parts
    expect(kinds(parts)).toEqual(["text", "tool", "text"])
    expect(parts.filter(p => p.type === "text" && p.content === "STREAMED_INTERIM_SENTINEL")).toHaveLength(1)
    expect(parts[0]).toMatchObject({ streaming: false })
  })

  test("identical interim and final text remain distinct without preview marker", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.interim", text: "SAME_REPLY_SENTINEL" },
      { kind: "message.complete", text: "SAME_REPLY_SENTINEL" },
    ])
    const parts = last(s).parts
    expect(kinds(parts)).toEqual(["text", "text"])
    expect(parts.filter(p => p.type === "text" && p.content === "SAME_REPLY_SENTINEL")).toHaveLength(2)
  })

  test("response-previewed final text dedupes matching interim text", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.interim", text: "PREVIEWED_REPLY_SENTINEL" },
      { kind: "message.complete", text: "PREVIEWED_REPLY_SENTINEL", previewed: true },
    ])
    const parts = last(s).parts
    expect(kinds(parts)).toEqual(["text"])
    expect(parts[0]).toMatchObject({ type: "text", content: "PREVIEWED_REPLY_SENTINEL", streaming: false })
  })

  test("complete seals trailing stream and attaches usage", () => {
    const usage = { input: 10, output: 5, total: 15 }
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "hi" },
      { kind: "message.complete", usage },
    ])
    expect(s.streaming).toBe(false)
    const m = last(s)
    expect(m.usage).toEqual(usage)
    expect(m.parts[0]).toMatchObject({ content: "hi", streaming: false })
  })

  test("complete with no prior delta creates assistant from final text", () => {
    const s = run([
      { kind: "user", text: "q" },
      { kind: "message.start" },
      { kind: "message.complete", text: "answer" },
    ])
    expect(last(s).role).toBe("assistant")
    expect(last(s).parts[0]).toMatchObject({ type: "text", content: "answer", streaming: false })
  })

  test("tool.progress updates most-recently-started running tool", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "tool.start", id: "a", name: "terminal" },
      { kind: "tool.start", id: "b", name: "terminal" },
      { kind: "tool.progress", name: "terminal", preview: "running b" },
    ])
    const tools = last(s).parts.filter((p): p is ToolPart => p.type === "tool")
    expect(tools[0].preview).toBeUndefined()
    expect(tools[1].preview).toBe("running b")
  })

  test("tool.complete error → status=error", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "tool.start", id: "t1", name: "x" },
      { kind: "tool.complete", id: "t1", error: "boom" },
    ])
    expect((last(s).parts[0] as ToolPart).status).toBe("error")
  })

  test("verbose tool details are stored without replacing normal preview", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "tool.start", id: "t1", name: "patch", preview: "src/x.ts", args: "{\"path\":\"src/x.ts\"}" },
      { kind: "tool.complete", id: "t1", summary: "edited src/x.ts", result: "raw result text", duration: 1200 },
    ])
    const tool = last(s).parts[0] as ToolPart
    expect(tool).toMatchObject({
      status: "done",
      preview: "edited src/x.ts",
      args: "{\"path\":\"src/x.ts\"}",
      result: "edited src/x.ts",
      verboseResult: "raw result text",
      duration: 1200,
    })
  })

  test("inline_diff completion keeps verbose result text for details", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "tool.start", id: "t1", name: "patch", preview: "src/x.ts", args: "args" },
      { kind: "tool.complete", id: "t1", inline_diff: "--- a\n+++ b", result: "patched result" },
    ])
    const tool = last(s).parts[0] as ToolPart
    expect(tool.preview).toBe("--- a\n+++ b")
    expect(tool.diff).toBe("--- a\n+++ b")
    expect(tool.result).toBeUndefined()
    expect(tool.verboseResult).toBe("patched result")
    expect(tool.verboseArgs).toBe("args")
  })

  test("thinking deltas win; reasoning.available is fallback-only", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "thinking", text: "hmm ", final: false },
      { kind: "thinking", text: "more", final: false },
      { kind: "thinking", text: "summary", final: true },
    ])
    expect(last(s).parts[0]).toMatchObject({ type: "thinking", content: "hmm more", streaming: false })
  })

  test("reasoning.available used when no deltas streamed", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "thinking", text: "recovered from last_reasoning", final: true },
    ])
    expect(last(s).parts[0]).toMatchObject({ type: "thinking", content: "recovered from last_reasoning", streaming: false })
  })

  test("reasoning.available preserves forced verbose flag", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "thinking", text: "trace", final: true, verbose: true },
    ])
    expect(last(s).parts[0]).toMatchObject({ type: "thinking", content: "trace", streaming: false, verbose: true })
  })

  test("interrupt.notice dedupes consecutive identical notices", () => {
    const s = run([
      { kind: "interrupt.notice", text: "press esc" },
      { kind: "interrupt.notice", text: "press esc" },
    ])
    expect(s.messages).toHaveLength(1)
  })

  test("error aborts streaming and appends system message", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "message.delta", chunk: "partial" },
      { kind: "error", text: "gateway died" },
    ])
    expect(s.streaming).toBe(false)
    expect(last(s).role).toBe("system")
    const p = last(s).parts[0]
    expect(p.type === "text" && p.content).toContain("gateway died")
  })

  test("nonfatal error keeps active stream alive", () => {
    const s = run([
      { kind: "message.start" },
      { kind: "error", text: "compression warning", fatal: false },
      { kind: "tool.start", id: "t1", name: "read_file" },
    ])
    expect(s.streaming).toBe(true)
    expect(s.toolActive).toBe(true)
    const p = last(s).parts[0]
    expect(p.type === "tool" && p.name).toBe("read_file")
  })

  test("reset clears everything", () => {
    const s = run([
      { kind: "user", text: "x" },
      { kind: "message.delta", chunk: "y" },
      { kind: "reset" },
    ])
    expect(s).toEqual(initialTurn)
  })
})

describe("transcriptToMessages", () => {
  test("released gateway string rows hydrate visible sanitized text", () => {
    const ms = transcriptToMessages([
      { role: "user", text: "hi\u0007" },
      { role: "assistant", text: "hello" },
    ])
    expect(ms).toHaveLength(2)
    expect(ms[0].parts[0]).toMatchObject({ type: "text", content: "hi" })
    expect(ms[1].parts[0]).toMatchObject({ type: "text", content: "hello" })
  })

  test("released gateway tool and system rows stay out of the visible transcript", () => {
    const ms = transcriptToMessages([
      { role: "system", text: "sys" },
      { role: "tool", name: "read_file", context: "/etc/hosts" },
      { role: "user", text: "hi" },
    ])
    expect(ms).toHaveLength(1)
    expect(ms[0].role).toBe("user")
  })
})
