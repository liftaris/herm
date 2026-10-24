import { useMemo, memo } from "react"
import type { RGBA } from "@opentui/core"
import { useTheme } from "../../theme"
import type { Theme } from "../../theme"
import type { SlashCommand, SlashSource } from "../../app/slashCommands"

type Props = {
  readonly commands: ReadonlyArray<SlashCommand>
  readonly cursor: number
  readonly onCursor: (idx: number) => void
  readonly onSelect: (cmd: SlashCommand) => void
}

type Row =
  | { type: "header"; cat: string }
  | { type: "cmd"; cmd: SlashCommand; idx: number }

const MAX_VISIBLE = 10

/** Color for the source badge. Returns null for sources that shouldn't render. */
function badge(source: SlashSource, theme: Theme): RGBA | null {
  if (source === "skill") return theme.success
  if (source === "plugin") return theme.info
  if (source === "mcp") return theme.warning
  return null // "command" and "local" get no badge
}

export const SlashPopover = memo(({ commands: cmds, cursor, onCursor, onSelect }: Props) => {
  const theme = useTheme().theme

  if (cmds.length === 0) {
    return (
      <box
        border
        borderStyle="single"
        borderColor={theme.border}
        backgroundColor={theme.backgroundPanel}
        paddingX={1}
        height={3}
      >
        <text fg={theme.textMuted}>No matching commands</text>
      </box>
    )
  }

  const rows = useMemo(() => {
    const start = Math.max(0, Math.min(cursor - 2, cmds.length - MAX_VISIBLE))
    const items = cmds.slice(start, start + MAX_VISIBLE)
    const cat = cmds[cursor]?.category ?? items[0]?.category ?? "Command"
    return [
      { type: "header", cat } satisfies Row,
      ...items.map((cmd, i) => ({ type: "cmd" as const, cmd, idx: start + i })),
    ]
  }, [cmds, cursor])

  const start = rows.find(r => r.type === "cmd")?.idx ?? 0
  const clipped = cmds.length > MAX_VISIBLE
  const above = clipped && start > 0
  const below = clipped && start + MAX_VISIBLE < cmds.length
  const height = rows.length + 2 + (above ? 1 : 0) + (below ? 1 : 0)

  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={theme.border}
      backgroundColor={theme.backgroundPanel}
      paddingX={1}
      height={height}
    >
      {above ? (
        <box height={1} paddingLeft={1}>
          <text fg={theme.textMuted}>↑ more</text>
        </box>
      ) : null}
      {rows.map((row) => {
        if (row.type === "header") {
          return (
            <box key={`h-${row.cat}`} height={1} paddingLeft={1}>
              <text>
                <span fg={theme.textMuted}>
                  <strong>{row.cat}</strong>
                </span>
              </text>
            </box>
          )
        }

        const active = row.idx === cursor
        const color = badge(row.cmd.source, theme)

        return (
          <box
            key={`c-${row.idx}-${row.cmd.name}`}
            height={1}
            flexDirection="row"
            backgroundColor={active ? theme.backgroundElement : undefined}
            onMouseOver={() => onCursor(row.idx)}
            onMouseDown={() => onSelect(row.cmd)}
            paddingLeft={2}
            paddingRight={1}
          >
            {/* Left: /name [args]  description */}
            <box flexGrow={1} height={1}>
              <text>
                <span fg={active ? theme.primary : theme.text}>/{row.cmd.name}</span>
                {row.cmd.argsHint ? (
                  <span fg={theme.textMuted}> {row.cmd.argsHint}</span>
                ) : null}
                <span fg={theme.textMuted}>  {row.cmd.description}</span>
              </text>
            </box>

            {/* Right: source badge + keybind */}
            <box height={1} flexDirection="row">
              {color ? (
                <text>
                  <span fg={color}> {row.cmd.source}</span>
                </text>
              ) : null}
              {row.cmd.keybind ? (
                <text>
                  <span fg={theme.textMuted}>  {row.cmd.keybind}</span>
                </text>
              ) : null}
            </box>
          </box>
        )
      })}
      {below ? (
        <box height={1} paddingLeft={1}>
          <text fg={theme.textMuted}>↓ more</text>
        </box>
      ) : null}
    </box>
  )
})
