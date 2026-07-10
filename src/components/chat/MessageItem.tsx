import { memo, useMemo, useRef, useState, type RefObject } from "react"
import { RGBA, type MouseEvent } from "@opentui/core"
import type { Message, Part, TextPart, ToolPart, PromptPart } from "../../types/message"
import { ErrorBlock } from "./ErrorBlock"
import { MediaChip, classify, splitContent } from "./MediaChip"
import { CodeBlock } from "./CodeBlock"
import { DiffTabs } from "./DiffTabs"
import { isDiff } from "./DiffBlock"
import { PromptCard, type PromptCardHandle } from "./PromptCard"
import { ChafaImage } from "../../ui/ChafaImage"
import { useTheme } from "../../theme"
import { useSkin } from "../../context/skin"
import { mathify } from "../../utils/math-unicode"

export type { Message }

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`
}

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function extract(msg: Message): string {
  return msg.parts
    .filter((p): p is TextPart => p.type === "text")
    .map(p => p.content)
    .join("")
}

const trunc = (s: string, max: number) => s.length <= max ? s : s.slice(0, max - 1) + "…"

function mix(a: RGBA, b: RGBA, n = 0.5): RGBA {
  return RGBA.fromValues(
    a.r + (b.r - a.r) * n,
    a.g + (b.g - a.g) * n,
    a.b + (b.b - a.b) * n,
    a.a + (b.a - a.a) * n,
  )
}

function darken(c: RGBA, n = 0.95): RGBA {
  return RGBA.fromValues(c.r * n, c.g * n, c.b * n, c.a)
}

function lighten(c: RGBA, n = 0.05): RGBA {
  return RGBA.fromValues(c.r + (1 - c.r) * n, c.g + (1 - c.g) * n, c.b + (1 - c.b) * n, c.a)
}

const TOP_RULE = {
  topLeft: "▔", topRight: "▔", horizontal: "▔",
  bottomLeft: "", bottomRight: "", vertical: "",
  topT: "", bottomT: "", leftT: "", rightT: "", cross: "",
}

const BOTTOM_RULE = {
  bottomLeft: "▁", bottomRight: "▁", horizontal: "▁",
  topLeft: "", topRight: "", vertical: "",
  topT: "", bottomT: "", leftT: "", rightT: "", cross: "",
}

// OpenTUI has no onClick; synthesize one from down→up at the same cell
// so text-selection drags don't fire it.
function useClick(fn?: () => void) {
  const at = useRef<{ x: number; y: number } | null>(null)
  return {
    onMouseDown: (e: MouseEvent) => { at.current = { x: e.x, y: e.y } },
    onMouseUp: (e: MouseEvent) => {
      const a = at.current
      at.current = null
      if (fn && a && a.x === e.x && a.y === e.y) fn()
    },
  }
}

export type PromptWire = {
  /** Ref to the single pending prompt card, for key routing. */
  ref: RefObject<PromptCardHandle | null>
  onAnswer: (id: string, label: string, ok: boolean) => void
}

export const MessageItem = memo(({ message, streaming, prompt, onRewind, onPick }: {
  message: Message
  streaming: boolean
  prompt?: PromptWire
  onRewind?: (m: Message) => void
  onPick?: (m: Message) => void
}) => {
  if (message.role === "system") return <SystemMessage message={message} />
  if (message.role === "user") return <UserMessage message={message} onRewind={onRewind} />
  return <AssistantMessage message={message} streaming={streaming} prompt={prompt} onPick={onPick} />
})

const SystemMessage = memo(({ message }: { message: Message }) => {
  const theme = useTheme().theme
  return (
    <box marginBottom={1} minHeight={1}>
      <text fg={theme.textMuted} wrapMode="word">{extract(message)}</text>
    </box>
  )
})

const UserMessage = memo(({ message, onRewind }: { message: Message; onRewind?: (m: Message) => void }) => {
  const ctx = useTheme()
  const theme = ctx.theme
  const [hover, setHover] = useState(false)
  const click = useClick(onRewind && (() => onRewind(message)))
  const fill = useMemo(
    () => ctx.mode === "dark" ? mix(theme.background, theme.backgroundElement) : darken(theme.backgroundElement),
    [ctx.mode, theme.background, theme.backgroundElement],
  )
  const edge = useMemo(
    () => ctx.mode === "dark" ? darken(theme.background) : darken(theme.backgroundElement),
    [ctx.mode, theme.background, theme.backgroundElement],
  )
  const segs = useMemo(
    () => message.parts.map(p => p.type === "text" && p.content ? splitContent(p.content) : null),
    [message.parts],
  )
  return (
    <box
      flexDirection="column"
      marginBottom={1}
    >
      <box height={1} border={["bottom"]} customBorderChars={BOTTOM_RULE}
           borderColor={edge} />
      <box backgroundColor={hover ? fill : theme.backgroundElement}
           paddingLeft={1} paddingRight={1} paddingY={1} flexDirection="column" minHeight={1}
           onMouseOver={() => setHover(true)}
           onMouseOut={() => setHover(false)}
           {...click}>
        {message.parts.map((p, i) => {
          const seg = segs[i]
          if (!seg) return null
          const k = (p as TextPart).key ?? i
          return seg.map((s, j) => {
            if ("media" in s) {
              const kind = classify(s.media)
              return kind === "img" ? (
                <box key={`${k}-m${j}`}><ChafaImage path={s.media} /></box>
              ) : (
                <box key={`${k}-m${j}`} marginTop={1}><MediaChip path={s.media} /></box>
              )
            }
            if ("code" in s) return (
              <CodeBlock key={`${k}-c${j}`} code={s.code} lang={s.lang} />
            )
            return <text key={`${k}-${j}`} fg={theme.text} wrapMode="word">{s.md}</text>
          })
        })}
      </box>
      <box height={1} border={["top"]} customBorderChars={TOP_RULE}
           borderColor={edge} />
    </box>
  )
})

const AssistantMessage = memo(({ message, streaming, prompt, onPick }: {
  message: Message; streaming: boolean; prompt?: PromptWire; onPick?: (m: Message) => void
}) => {
  const ctx = useTheme()
  const theme = ctx.theme
  const { agentName } = useSkin()
  const [hover, setHover] = useState(false)
  const click = useClick(onPick && (() => onPick(message)))
  const rail = useMemo(
    () => ctx.mode === "dark" ? lighten(theme.background) : darken(theme.backgroundElement),
    [ctx.mode, theme.background, theme.backgroundElement],
  )
  const err = !!message.error
  const trail = message.parts.filter((p): p is ToolPart | PromptPart =>
    p.type === "tool" || p.type === "prompt")
  const diffs = trail.filter((p): p is ToolPart =>
    p.type === "tool" && (!!p.diff || isDiff(p.result)))

  // Split once per parts identity so hover (which re-renders this
  // component) doesn't re-scan text. parts identity changes per
  // streaming delta and stabilizes on completion.
  const segs = useMemo(
    () => message.parts.map(p => p.type === "text" && p.content ? splitContent(p.content) : null),
    [message.parts],
  )

  const header = [
    message.speaker ?? agentName,
    message.usage ? `${tokens(message.usage.input)}→${tokens(message.usage.output)} tok` : null,
    message.duration ? duration(message.duration) : null,
  ].filter(Boolean).join(" · ")

  const part = (p: Part, i: number) => {
    if (p.type === "prompt") {
      // ref only attaches to the pending card (answered cards are
      // inert outcome rows and never receive keys).
      return (
        <box key={`pr-${p.id}`} marginTop={1}
             onMouseDown={(e: MouseEvent) => e.stopPropagation()}>
          <PromptCard part={p}
            ref={!p.answered ? prompt?.ref : undefined}
            onAnswer={prompt?.onAnswer ?? (() => {})} />
        </box>
      )
    }
    const seg = segs[i]
    if (!seg) return null
    const k = (p as TextPart).key ?? i
    const last = streaming && (p as TextPart).streaming
    return seg.map((s, j) => {
      const tail = last && j === seg.length - 1
      if ("media" in s) {
        const kind = classify(s.media)
        return kind === "img" ? (
          <box key={`${k}-m${j}`}><ChafaImage path={s.media} /></box>
        ) : (
          <box key={`${k}-m${j}`} marginTop={1}><MediaChip path={s.media} /></box>
        )
      }
      if ("code" in s) return (
        <CodeBlock key={`${k}-c${j}`} code={s.code} lang={s.lang} streaming={tail} />
      )
      // LaTeX → Unicode. mathify scans for $…$ / \(…\) / $$…$$ / \[…\]
      // spans and rewrites only their interiors via texToUnicode; prose
      // like `browser_navigate` is never touched. Inline-code spans are
      // skipped. Unknown commands inside a span pass through, so partial
      // streaming deltas (e.g. "\al" before "\alpha" arrives) are safe —
      // they simply don't substitute yet.
      return (
        <box key={`${k}-${j}`}>
          <markdown content={mathify(s.md)} fg={theme.markdownText}
            syntaxStyle={ctx.syntaxStyle} streaming={tail} />
        </box>
      )
    })
  }

  return (
    <box flexDirection="row" marginBottom={1}
         onMouseOver={() => setHover(true)}
         onMouseOut={() => setHover(false)}
         {...click}>
      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        <box height={1} flexDirection="row">
          <box flexGrow={1}><text fg={theme.textMuted}>{header}</text></box>
          {trail.length ? (
            <box><text fg={theme.textMuted}>
              {trunc(trail.map(p => p.type === "tool" ? p.name : "?").join(" · "), 40)}
            </text></box>
          ) : null}
        </box>
        {message.parts.map(part)}
        {diffs.length ? <DiffTabs tools={diffs} /> : null}
        {err ? <ErrorBlock text={message.error!} /> : null}
      </box>
      <box width={3} flexShrink={0} flexDirection="row">
        <box width={2} />
        <box width={1} backgroundColor={hover ? rail : undefined} />
      </box>
    </box>
  )
})
