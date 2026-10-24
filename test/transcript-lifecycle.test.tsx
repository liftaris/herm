import { expect, test } from "bun:test"
import { act, useState } from "react"
import { Renderable } from "@opentui/core"
import { MessageList } from "../src/components/chat/MessageList"
import type { Message } from "../src/types/message"
import { mountNode, until } from "./harness"

const turn = (n: number): Message[] => [
  { id: `user-${n}`, role: "user", timestamp: n, parts: [{ type: "text", content: `request-${n}`, streaming: false }] },
  { id: `assistant-${n}`, role: "assistant", timestamp: n, parts: [{ type: "text", content: `**reply**\n\n\`\`\`ts\nconst n = ${n}\n\`\`\`\n\nreply-${n}-done`, streaming: false }] },
]

test("evicting transcript entries releases their renderables across repeated turns", async () => {
  let append!: (messages: Message[]) => void
  const messages = Array.from({ length: 100 }, (_, n) => turn(n)).flat()
  function Probe() {
    const [list, set] = useState(messages)
    append = set
    return <box flexDirection="column" width="100%" height="100%"><MessageList messages={list} streaming={false} /></box>
  }
  await using t = await mountNode(<Probe />, { width: 90, height: 24 })
  await until(t, () => t.frame().includes("reply-99-done"))
  const mounted = Renderable.renderablesByNumber.size
  for (let n = 100; n < 120; n++) {
    messages.push(...turn(n))
    act(() => append([...messages]))
    await until(t, () => t.frame().includes(`reply-${n}-done`))
    await t.settle()
    expect(Renderable.renderablesByNumber.size).toBe(mounted)
    expect(t.renderer.nativeScene.cleanupOwners.size).toBe(0)
  }
})
