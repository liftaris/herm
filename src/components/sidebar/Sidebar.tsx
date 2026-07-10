import { useState, memo, type ReactNode, useRef } from "react"
import { AnimatedAvatar } from "../avatar/AnimatedAvatar"
import type { ParsedEikon } from "../avatar/eikon"
import { useTheme } from "../../theme"
import type { AvatarState } from "../avatar/states"
import type { SessionInfo } from "../../context/wire"
import type { Usage } from "../../types/message"
import { git } from "../../utils/git"
import { Tail } from "../chat/ThoughtCloud"
import { ContextGauge } from "./ContextGauge"
import { useDialog } from "../../ui/dialog"
import { useKeyboard } from "@opentui/react"
import { useKeys } from "../../keys"

export type HiddenContext = {
  profile?: string
  model?: string
  title?: string
  place?: string
  context?: string
}

// The pillar body carries a compact identity block, the MCP operational
// section, and a context-usage gauge at the bottom. Stats/Memory/Recent/
// Identity wrapper and the Plugins section were removed — they duplicated
// dedicated tabs and cluttered the most-visible surface.

const WIDTH = 48
const PAD_L = 12
// Inner content width after border (2) + padding (2).
const INNER = WIDTH - 4

const trunc = (s: string, max: number) => s.length <= max ? s : s.slice(0, max - 1) + "…"

export function hidden(props: {
  info?: SessionInfo | null
  usage?: Usage
  profile?: string
  title?: string
  branch?: string | null
}): HiddenContext {
  const cwd = props.info?.cwd?.split(/[/\\]/).filter(Boolean).pop()
  return {
    profile: props.profile,
    model: props.info?.model,
    title: props.title,
    place: props.branch ?? cwd,
    context: typeof props.usage?.context_percent === "number" ? `${props.usage.context_percent}%` : undefined,
  }
}

const Section = memo((props: {
  title: string; hint?: string
  open: boolean; onToggle: () => void
  children: ReactNode
}) => {
  const theme = useTheme().theme
  const [hover, setHover] = useState(false)
  return (
    <box flexDirection="column" marginBottom={props.open ? 1 : 0}>
      <box height={1}
           onMouseDown={props.onToggle}
           onMouseOver={() => setHover(true)}
           onMouseOut={() => setHover(false)}>
        <text>
          <span fg={hover ? theme.text : theme.textMuted}>
            {props.open ? "▾ " : "▸ "}
          </span>
          <span fg={theme.text}><strong>{props.title}</strong></span>
          {props.hint ? <span fg={theme.textMuted}>{`  ${props.hint}`}</span> : null}
        </text>
      </box>
      {props.open ? <box flexDirection="column">{props.children}</box> : null}
    </box>
  )
})

const Avatar = (props: { state: AvatarState; eikon?: ParsedEikon; id?: string; onHold?: (s: AvatarState) => void }) => (
  <AnimatedAvatar key={props.id} state={props.state} eikon={props.eikon} onHold={props.onHold} />
)

const Row = (props: { label: string; value: string; strong?: boolean; block?: boolean }) => {
  const theme = useTheme().theme
  if (props.block) return (
    <box flexDirection="column" minHeight={2} marginBottom={1}>
      <text fg={theme.textMuted}>{`  ${props.label}`}</text>
      <text fg={theme.text} wrapMode="word">{props.value}</text>
    </box>
  )
  return (
    <box height={1}>
      <text>
        <span fg={theme.textMuted}>{`  ${props.label.padEnd(PAD_L)}`}</span>
        {props.strong
          ? <span fg={theme.text}><strong>{trunc(props.value, INNER - PAD_L - 2)}</strong></span>
          : <span fg={theme.text}>{trunc(props.value, INNER - PAD_L - 2)}</span>}
      </text>
    </box>
  )
}

const ChangesDialog = memo((props: { files: git.File[] }) => {
  const theme = useTheme().theme

  return (
    <box flexDirection="column" width={70}>
      <text fg={theme.text}>
        <strong>{`Changed Files (${props.files.length})`}</strong>
      </text>
      <box height={1} />
      <scrollbox scrollY maxHeight={20} paddingRight={1}
        contentOptions={{ flexDirection: "column" }}>
        {props.files.map(f => (
          <box key={f.file} height={1} paddingRight={1}>
            <text>
              <span fg={theme.textMuted}> </span>
              <span fg={f.code[0] === "?" ? theme.diffAdded
                : f.code[0] === "A" || f.code[1] === "A" ? theme.diffAdded
                : f.code[0] === "D" || f.code[1] === "D" ? theme.diffRemoved
                : theme.warning}>{f.code}</span>
              <span fg={theme.textMuted}>{"  " + f.file}</span>
            </text>
          </box>
        ))}
      </scrollbox>
    </box>
  )
})

export const Sidebar = memo((props: {
  agentState?: AvatarState
  info?: SessionInfo | null
  usage?: Usage
  eikon?: ParsedEikon
  profile?: string
  title?: string
  cloud?: boolean
  pulse?: boolean
  onAvatar?: () => void
  onAvatarHold?: (s: AvatarState) => void
}) => {
  const theme = useTheme().theme
  const state = props.agentState ?? "idle"
  const info = props.info

  const [mcpOpen, setMcpOpen] = useState(false)

  const dialog = useDialog()
  const cwd = info?.cwd ?? process.cwd()
  const branch = git.useGitBranch(cwd)
  const changes = git.useGitStatus(cwd)
  const keys = useKeys()
  const ref = useRef(changes)
  ref.current = changes

  const show = () => {
    const cur = ref.current
    if (!cur || cur.files.length === 0 || dialog.open()) return
    dialog.replace(<ChangesDialog files={cur.files} />)
  }

  useKeyboard((key) => {
    if (dialog.open() || !keys.match("sidebar.changes", key)) return
    key.stopPropagation()
    show()
  })

  return (
    <box width={WIDTH} flexDirection="column">
      {/* Avatar (bust) — also the anchor for the thought-cloud tail */}
      <box position="relative" flexDirection="column" height={24} overflow="hidden"
           onMouseDown={props.onAvatar}>
        <Avatar state={state} eikon={props.eikon} onHold={props.onAvatarHold} />
        {props.cloud ? (
          <box position="absolute" left={0} top={0}>
            <Tail run={!!props.pulse} />
          </box>
        ) : null}
      </box>

      {/* Body (pillar) — double-border frame in accent, open at the
          bottom so it reads as the avatar's plinth running off-screen.
          No bg fill → content uses the normal text palette. */}
      <box padding={1} flexDirection="column" flexGrow={1} overflow="hidden"
           border={["top", "left", "right"]} borderStyle="double"
           borderColor={theme.hermAvatar}>

        {/* Flat identity block — Title is primary (always rendered so the
            block doesn't reflow when `/title` fires), then Profile
            (which IS agent lineage — each profile is an isolated
            HERMES_HOME), then model/cwd/branch. */}
        <Row label="Title" value={props.title || "—"} strong={!!props.title} />
        <Row label="Profile" value={props.profile ?? "default"}
             strong={!!props.profile && props.profile !== "default"} />
        <Row label="Model" value={info?.model ?? "—"} />
        {info?.cwd ? <Row label="cwd" value={info.cwd} /> : null}
        {branch ? <Row label="Branch" value={git.rtrunc(branch, INNER - PAD_L - 2)} /> : null}

        {changes && (changes.added + changes.modified + changes.deleted) > 0 ? (
          <box height={1} onMouseDown={show}>
            <text>
              <span fg={theme.textMuted}>{"▸ "}</span>
              <span fg={theme.text}><strong>Changes</strong></span>
              <span fg={theme.textMuted}>{`  +${changes.added} ~${changes.modified} -${changes.deleted}`}</span>
            </text>
          </box>
        ) : null}

        {(info?.mcp_servers?.length ?? 0) > 0 ? (() => {
          const srv = info!.mcp_servers!
          const ok = srv.filter(s => s.connected).length
          return (
            <Section title="MCP"
                     hint={`${ok}/${srv.length} up`}
                     open={mcpOpen} onToggle={() => setMcpOpen(o => !o)}>
              {srv.map(s => (
                <box key={s.name} height={1}>
                  <text>
                    <span fg={theme.textMuted}>{"  "}</span>
                    <span fg={s.connected ? theme.text : theme.textMuted}>
                      {(s.connected ? "● " : "○ ") + trunc(s.name, 16).padEnd(16)}
                    </span>
                    <span fg={theme.textMuted}>
                      {s.connected ? ` ${s.transport} · ${s.tools}t` : " failed"}
                    </span>
                  </text>
                </box>
              ))}
            </Section>
          )
        })() : null}

        <box flexGrow={1} />
        <ContextGauge info={info} usage={props.usage} width={INNER} />
      </box>
    </box>
  )
})
