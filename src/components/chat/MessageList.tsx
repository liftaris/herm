import { memo, useMemo } from "react"
import { MessageItem, type PromptWire } from "./MessageItem"
import { useTheme } from "../../theme"
import type { Message } from "../../types/message"

type Props = {
  messages: Message[]
  streaming: boolean
  prompt?: PromptWire
  onRewind?: (m: Message) => void
  onPick?: (m: Message) => void
}

export const MessageList = memo(({ messages, streaming, prompt, onRewind, onPick }: Props) => {
  const theme = useTheme().theme

  const style = useMemo(() => ({
    viewportOptions: { backgroundColor: theme.background },
    scrollbarOptions: {
      trackOptions: {
        foregroundColor: theme.borderSubtle,
        backgroundColor: theme.background,
      },
    },
  }), [theme])

  // Empty transcript is covered by the overlay Splash (ui/Splash.tsx);
  // when the splash is intentionally suppressed (--no-splash, /clear)
  // the bare box is the correct blank canvas.
  if (messages.length === 0) return <box flexGrow={1} />

  const last = messages[messages.length - 1]
  const lastStreaming = streaming && last?.role === "assistant"
  return (
    <scrollbox
      flexGrow={1}
      scrollY
      stickyScroll
      stickyStart="bottom"
      style={style}
    >
      <box flexDirection="column" paddingBottom={1}>
        {messages.map((msg, i) => (
          <box key={msg.id} flexDirection="column">
            <MessageItem
              message={msg}
              streaming={lastStreaming && i === messages.length - 1}
              prompt={prompt}
              onRewind={onRewind}
              onPick={onPick}
            />
          </box>
        ))}
      </box>
    </scrollbox>
  )
})
