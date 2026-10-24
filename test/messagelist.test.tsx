import { describe, expect, test } from "bun:test"
import { act, createRef, useState } from "react"
import { TestRecorder } from "@opentui/core/testing"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { mountBudget } from "../src/components/chat/mount-budget"
import { mountNode, until, type Harness } from "./harness"
import { turnReducer, initialTurn, type Action } from "../src/app/turnReducer"
import { MessageList } from "../src/components/chat/MessageList"
import { splitContent } from "../src/components/chat/MediaChip"
import type { PromptCardHandle } from "../src/components/chat/PromptCard"
import type { Message } from "../src/types/message"

const UDIFF = [
  "--- a/foo.ts",
  "+++ b/foo.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old line",
  "+new line",
].join("\n")

function locate(t: Harness, needle: string) {
  const rows = t.frame().split("\n")
  const y = rows.findIndex(row => row.includes(needle))
  if (y < 0) throw new Error(`Missing frame token: ${needle}`)
  return { x: rows[y].indexOf(needle), y }
}

function scroller(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node
  for (const child of node.getChildren()) {
    const result = scroller(child)
    if (result) return result
  }
}

const historyMessages: Message[] = Array.from({ length: 200 }, (_, n) => ({
  id: `history-${n}`, role: "system", timestamp: n,
  parts: [{ type: "text", content: `history-row-${String(n).padStart(3, "0")}`, streaming: false }],
}))

let updateHistory!: (messages: Message[]) => void
function HistoryProbe() {
  const [messages, set] = useState(historyMessages)
  updateHistory = set
  return <box flexDirection="column" width="100%" height="100%"><MessageList messages={messages} streaming={false} /></box>
}

function reduce(actions: Action[]) {
  return actions.reduce(turnReducer, initialTurn)
}

const SOURCE = "# Heading\n\nThis is **bold** and `code`."
let stream!: (content: string) => void

function StreamProbe() {
  const [content, set] = useState(SOURCE)
  stream = set
  const message: Message = {
    id: "stream-probe", role: "assistant", timestamp: 0,
    parts: [{ type: "text", key: "stream-part", content, streaming: true }],
  }
  return (
    <box flexDirection="column" width="100%" height="100%">
      <MessageList messages={[message]} streaming />
    </box>
  )
}

describe("message transcript contracts", () => {
  test("a long transcript mounts only its tail and backfill preserves the viewport text", async () => {
    await using t = await mountNode(<HistoryProbe />, { width: 72, height: 12 })
    await until(t, () => t.frame().includes("history-row-199"))
    const box = scroller(t.renderer.root)
    if (!box) throw new Error("transcript scrollbox missing")
    const rows = () => box.getChildren()[0].getChildren().length
    expect(rows()).toBe(mountBudget.tail)
    act(() => box.scrollTo(box.viewport.height + 1))
    await t.settle()
    const before = t.frame().split("\n").slice(0, -2).map(line => line.slice(0, -1))
    const recorder = new TestRecorder(t.renderer)
    recorder.rec()
    act(() => box.scrollBy(-1))
    await until(t, () => rows() === mountBudget.tail + mountBudget.chunk)
    await t.settle()
    recorder.stop()
    const stable = t.frame().split("\n").slice(1, -1).map(line => line.slice(0, -1))
    expect(stable).toEqual(before)
    expect(recorder.recordedFrames.map(entry => entry.frame.split("\n").slice(1, -1).map(line => line.slice(0, -1)))).toEqual(expect.arrayContaining([stable]))
    expect(recorder.recordedFrames.every(entry => !entry.frame.includes("history-row-106"))).toBe(true)
    expect(box.stickyScroll).toBe(false)
    for (const count of [160, 200]) {
      act(() => box.scrollTo(0))
      await until(t, () => rows() === count)
      await t.settle()
    }
    act(() => box.scrollTo(0))
    await until(t, () => t.frame().includes("history-row-000"))
    expect(rows()).toBe(200)
    act(() => updateHistory([...historyMessages,
      { id: "new-user", role: "user", timestamp: 201, parts: [{ type: "text", content: "new-user-turn", streaming: false }] },
      { id: "new-assistant", role: "assistant", timestamp: 202, parts: [{ type: "text", content: "new-assistant-turn", streaming: false }] },
    ]))
    await until(t, () => t.frame().includes("new-user-turn") && t.frame().includes("new-assistant-turn"))
    expect(rows()).toBe(mountBudget.tail)
    expect(box.stickyScroll).toBe(true)
  })

  test("keyboard and wheel can reveal history even when the initial tail fits", async () => {
    await using t = await mountNode(<HistoryProbe />, { width: 72, height: 100 })
    const box = scroller(t.renderer.root)
    if (!box) throw new Error("transcript scrollbox missing")
    await until(t, () => t.frame().includes("history-row-199"))
    expect(box.scrollTop).toBe(0)
    const before = t.frame().split("\n").map(line => line.slice(0, -1))
    act(() => box.focus())
    act(() => t.keys.pressArrow("up"))
    await until(t, () => box.getChildren()[0].getChildren().length === 100)
    await t.settle()
    expect(t.frame().split("\n").map(line => line.slice(0, -1))).toEqual(before)
    act(() => t.keys.pressKey("HOME"))
    await t.settle()
    await act(async () => { await t.mouse.scroll(2, 2, "up") })
    await until(t, () => box.getChildren()[0].getChildren().length > 100)
    act(() => t.keys.pressKey("END"))
    await until(t, () => t.frame().includes("history-row-199"))
    expect(box.getChildren()[0].getChildren()).toHaveLength(40)
    expect(box.stickyScroll).toBe(true)
  })

  test("revealed user and assistant messages retain rewind and pick callbacks", async () => {
    const rewinds: Message[] = []
    const picks: Message[] = []
    const older: Message[] = [
      { id: "old-user", role: "user", timestamp: 0, parts: [{ type: "text", content: "revealed-user", streaming: false }] },
      { id: "old-assistant", role: "assistant", timestamp: 1, parts: [{ type: "text", content: "revealed-assistant", streaming: false }] },
    ]
    await using t = await mountNode(
      <box flexDirection="column" width="100%" height="100%"><MessageList messages={[...older, ...historyMessages]} streaming={false} onRewind={message => rewinds.push(message)} onPick={message => picks.push(message)} /></box>,
      { width: 72, height: 20 },
    )
    const box = scroller(t.renderer.root)
    if (!box) throw new Error("transcript scrollbox missing")
    await until(t, () => t.frame().includes("history-row-199"))
    for (const count of [100, 160, 202]) {
      act(() => box.scrollTo(0))
      await until(t, () => box.getChildren()[0].getChildren().length === count)
    }
    act(() => box.scrollTo(0))
    await until(t, () => t.frame().includes("revealed-user") && t.frame().includes("revealed-assistant"))
    const user = locate(t, "revealed-user")
    await act(async () => { await t.mouse.click(user.x, user.y) })
    const assistant = locate(t, "revealed-assistant")
    await act(async () => { await t.mouse.click(assistant.x, assistant.y) })
    expect(rewinds).toEqual([older[0]])
    expect(picks).toEqual([older[1]])
  })

  test("the tail keeps streaming text and the pending prompt mounted", async () => {
    const ref = createRef<PromptCardHandle>()
    const answered: string[] = []
    let append!: (text: string) => void
    function Probe() {
      const [text, set] = useState("streaming-tail")
      append = set
      const message: Message = { id: "tail-assistant", role: "assistant", timestamp: 200, parts: [
        { type: "text", content: text, streaming: true },
        { type: "prompt", id: "tail-prompt", variant: "approval", req: { id: "tail-prompt", session_id: "test-sid", variant: "approval", request_id: "tail-request", command: "pwd", description: "Inspect working directory" } },
      ] }
      return <box flexDirection="column" width="100%" height="100%"><MessageList messages={[...historyMessages, message]} streaming prompt={{ ref, onAnswer: id => answered.push(id) }} /></box>
    }
    await using t = await mountNode(<Probe />, { width: 90, height: 24 })
    await until(t, () => t.frame().includes("streaming-tail") && ref.current !== null)
    act(() => append("streaming-tail-updated"))
    await until(t, () => t.frame().includes("streaming-tail-updated"))
    const box = scroller(t.renderer.root)
    if (!box) throw new Error("transcript scrollbox missing")
    expect(box.getChildren()[0].getChildren()).toHaveLength(40)
    expect(t.frame()).toContain("pwd")
    const choice = locate(t, "Allow once")
    await act(async () => { await t.mouse.click(choice.x, choice.y) })
    await until(t, () => answered.length === 1)
    expect(answered).toEqual(["tail-prompt"])
    expect(t.gw.last("answer")?.params).toMatchObject({ id: "tail-prompt", choice: "once" })
  })

  test("an empty transcript stays blank and replacement history starts at its own tail", async () => {
    await using t = await mountNode(<HistoryProbe />, { width: 72, height: 12 })
    act(() => updateHistory([]))
    await t.settle()
    expect(t.frame().trim()).toBe("")
    act(() => updateHistory(historyMessages.map(message => ({ ...message, id: `replacement-${message.id}` }))))
    await until(t, () => t.frame().includes("history-row-199"))
    const box = scroller(t.renderer.root)
    if (!box) throw new Error("transcript scrollbox missing")
    expect(box.getChildren()[0].getChildren()).toHaveLength(40)
  })

  test("markdown images route to media without interpreting fenced examples", () => {
    expect(splitContent([
      "before ![preview](/tmp/owl.png) after",
      "```md",
      "![literal](/tmp/owl.png)",
      "```",
    ].join("\n"))).toEqual([
      { md: "before " },
      { media: "/tmp/owl.png" },
      { md: " after" },
      { code: "![literal](/tmp/owl.png)", lang: "md" },
    ])
  })

  test("streamed assistant headings never expose source markers between highlight passes", async () => {
    await using t = await mountNode(<StreamProbe />, { width: 80, height: 16 })
    const recorder = new TestRecorder(t.renderer)
    recorder.rec()

    for (const suffix of [" stream-one", " stream-two", " stream-three", " stream-four"]) {
      act(() => stream(SOURCE + suffix))
      await until(t, () => t.frame().includes(suffix.trim()) && !t.frame().includes("# Heading"))
    }
    recorder.stop()

    const frames = recorder.recordedFrames.map(frame => frame.frame)
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.some(frame => frame.includes("# Heading"))).toBe(false)
  })

  test("trim-equivalent completion cannot duplicate or reorder streamed parts", () => {
    const state = reduce([
      { kind: "message.delta", chunk: "before" },
      { kind: "tool.start", id: "t1", name: "read_file", preview: "src/a.ts" },
      { kind: "tool.complete", id: "t1", summary: "read src/a.ts" },
      { kind: "message.delta", chunk: "after" },
      { kind: "message.complete", text: "after\n" },
    ])
    const parts = state.messages[0].parts

    expect(parts.map(part => part.type)).toEqual(["text", "tool", "text"])
    expect(parts.filter(part => part.type === "text")).toEqual([
      expect.objectContaining({ content: "before", streaming: false }),
      expect.objectContaining({ content: "after", streaming: false }),
    ])
  })

  test("messages occupy one transcript column in chronological order", async () => {
    const messages: Message[] = [
      {
        id: "first", role: "system", timestamp: 0,
        parts: [{ type: "text", content: "first-message", streaming: false }],
      },
      {
        id: "second", role: "system", timestamp: 1,
        parts: [{ type: "text", content: "second-message", streaming: false }],
      },
    ]
    await using t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageList messages={messages} streaming={false} />
      </box>,
      { width: 72, height: 12 },
    )
    await until(t, () => t.frame().includes("second-message"))

    expect(locate(t, "first-message").y).toBeLessThan(locate(t, "second-message").y)

    const scroll = scroller(t.renderer.root)
    expect(scroll).toBeDefined()
    expect(scroll?.viewport.width).toBe(72)
    expect(scroll?.content.getChildren()).toHaveLength(1)

    const column = scroll?.content.getChildren()[0]
    expect(column?.width).toBe(scroll?.viewport.width)
    expect(column?.getChildren()).toHaveLength(messages.length)
  })

  test("diff controls toggle their body without selecting the message", async () => {
    const picks: Message[] = []
    const message: Message = {
      id: "a1", role: "assistant", timestamp: 0,
      parts: [
        { type: "text", content: "selection-target", streaming: false },
        {
          type: "tool", id: "td", name: "patch", args: "",
          preview: "src/foo.ts", status: "done", result: UDIFF,
        },
      ],
    }
    await using t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageList messages={[message]} streaming={false} onPick={msg => picks.push(msg)} />
      </box>,
      { width: 100, height: 18 },
    )
    await until(t, () => t.frame().includes("foo.ts") && t.frame().includes("selection-target"))

    const body = locate(t, "selection-target")
    await act(async () => { await t.mouse.click(body.x, body.y) })
    expect(picks).toEqual([message])
    expect(t.frame()).not.toContain("+new line")

    const tab = locate(t, "foo.ts")
    await act(async () => { await t.mouse.click(tab.x, tab.y) })
    await until(t, () => t.frame().includes("+new line"))
    expect(picks).toEqual([message])

    const active = locate(t, "foo.ts")
    await act(async () => { await t.mouse.click(active.x, active.y) })
    await until(t, () => !t.frame().includes("+new line"))
    expect(picks).toEqual([message])
  })

  test("turn errors disclose the full body on demand", async () => {
    const error = [
      "RuntimeError: boom",
      ...Array.from({ length: 10 }, (_, i) => `trace-${i}`),
    ].join("\n")
    const message: Message = {
      id: "failed", role: "assistant", timestamp: 0, parts: [], error,
    }
    await using t = await mountNode(
      <box flexDirection="column" width="100%" height="100%">
        <MessageList messages={[message]} streaming={false} />
      </box>,
      { width: 100, height: 30 },
    )
    await until(t, () => t.frame().includes("trace-0"))

    expect(t.frame()).not.toContain("trace-9")
    const body = locate(t, "trace-0")
    await act(async () => { await t.mouse.pressDown(body.x, body.y) })
    await until(t, () => t.frame().includes("trace-9"))

    const open = locate(t, "trace-0")
    await act(async () => { await t.mouse.pressDown(open.x, open.y) })
    await until(t, () => !t.frame().includes("trace-9"))
  })
})
