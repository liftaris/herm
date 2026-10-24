import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import { MessageItem, type PromptWire } from "./MessageItem"
import { mountBudget } from "./mount-budget"
import { useTheme } from "../../theme"
import type { Message } from "../../types/message"

type Props = {
  messages: Message[]
  streaming: boolean
  prompt?: PromptWire
  onRewind?: (m: Message) => void
  onPick?: (m: Message) => void
}

export const MessageList = memo((props: Props) => {
  if (props.messages.length === 0) return <box flexGrow={1} />
  return <Transcript key={props.messages[0].id} {...props} />
})

const Transcript = ({ messages, streaming, prompt, onRewind, onPick }: Props) => {
  const theme = useTheme().theme
  const scroll = useRef<ScrollBoxRenderable>(null)
  const [history, setHistory] = useState<{ start: number; space: number } | null>(null)
  const start = history === null ? mountBudget.start(messages.length) : Math.min(history.start, mountBudget.start(messages.length))
  const live = useRef({ start, space: 0 })
  live.current = { start, space: history?.space ?? 0 }
  const anchor = useRef<{ height: number; top: number } | null>(null)
  const length = useRef(messages.length)

  const follow = useCallback(() => {
    anchor.current = null
    setHistory(null)
    const box = scroll.current
    if (!box) return
    box.stickyScroll = true
    box.scrollTo(box.scrollHeight)
  }, [])

  useLayoutEffect(() => {
    const from = length.current
    length.current = messages.length
    if (messages.slice(from).some(message => message.role === "user")) follow()
  }, [messages, follow])

  const reveal = useCallback(() => {
    const box = scroll.current
    if (!box || anchor.current || live.current.start === 0) return
    box.stickyScroll = false
    anchor.current = { height: box.scrollHeight, top: box.scrollTop }
    setHistory({
      start: mountBudget.older(live.current.start),
      space: Math.max(live.current.space, box.viewport.height - box.getChildren()[0].height),
    })
  }, [])

  useEffect(() => {
    const box = scroll.current
    if (!box) return
    let previous = box.scrollTop
    const change = () => {
      const top = box.scrollTop
      const up = top < previous
      previous = top
      if (anchor.current) return
      const bottom = top >= box.scrollHeight - box.viewport.height
      box.stickyScroll = bottom
      if (bottom) {
        setHistory(null)
        return
      }
      if (up && top <= box.viewport.height) reveal()
    }
    const restore = () => {
      const before = anchor.current
      if (!before || box.scrollHeight === before.height) return
      box.scrollTo(before.top + box.scrollHeight - before.height)
      previous = box.scrollTop
      anchor.current = null
    }
    box.verticalScrollBar.on("change", change)
    box.content.on("resize", restore)
    return () => {
      box.verticalScrollBar.off("change", change)
      box.content.off("resize", restore)
    }
  }, [reveal])

  const style = useMemo(() => ({
    viewportOptions: { backgroundColor: theme.background },
    scrollbarOptions: {
      trackOptions: {
        foregroundColor: theme.borderSubtle,
        backgroundColor: theme.background,
      },
    },
  }), [theme])

  const last = messages[messages.length - 1]
  const lastStreaming = streaming && last?.role === "assistant"
  return (
    <scrollbox
      ref={scroll}
      flexGrow={1}
      scrollY
      stickyScroll
      stickyStart="bottom"
      onMouseScroll={event => {
        const box = scroll.current
        if (!box) return
        if (event.scroll?.direction === "up" && box.scrollTop === 0) reveal()
        if (event.scroll?.direction === "down" && box.scrollTop >= box.scrollHeight - box.viewport.height) follow()
      }}
      onKeyDown={key => {
        if (key.name === "end") follow()
        if (["up", "pageup", "home"].includes(key.name) && scroll.current?.scrollTop === 0) reveal()
      }}
      style={style}
    >
      <box flexDirection="column" paddingBottom={1 + (history?.space ?? 0)}>
        {messages.slice(start).map(msg => (
          <box key={msg.id} flexDirection="column">
            <MessageItem
              message={msg}
              streaming={lastStreaming && msg === last}
              prompt={prompt}
              onRewind={onRewind}
              onPick={onPick}
            />
          </box>
        ))}
      </box>
    </scrollbox>
  )
}
