import type { ReactNode } from "react"
import { useTheme } from "../theme"
import { TabShell } from "../ui/shell"
import type { useFollow } from "../keys"

export const EIKON_CARD = 50

type Follow = ReturnType<typeof useFollow>

export type EikonTitle = {
  key: string
  name: string
  active?: boolean
}

export type EikonCard = EikonTitle & {
  author?: string
  status: string
  lines: string[]
}

export const titleWidth = (title: string, rows: EikonTitle[]) => Math.max(
  title.length,
  ...rows.map(r => r.name.length + 4),
) + 7

const cardWidth = (lines: string[]) => Math.max(EIKON_CARD, ...lines.map(line => line.length + 2))

export const EikonTitleList = (props: {
  title: string
  rows: EikonTitle[]
  sel: number
  focus?: boolean
  follow: Follow
  width: number
  onSel: (i: number) => void
  onUse: (i: number) => void
}) => {
  const theme = useTheme().theme
  return (
    <box width={props.width} flexShrink={0} minHeight={0}>
      <TabShell title={props.title} focus={props.focus} grow={1}>
        <box flexDirection="column" flexGrow={1} minHeight={0}>
          <scrollbox ref={props.follow.ref} scrollY flexGrow={1}>
            {props.rows.length === 0
              ? <text fg={theme.textMuted}>No eikons found.</text>
              : props.rows.map((r, i) => {
                  const on = i === props.sel
                  return (
                    <box key={r.key} id={props.follow.id(i)} flexDirection="row" height={1} paddingRight={3}
                         backgroundColor={on ? theme.backgroundElement : undefined}
                         onMouseMove={() => props.onSel(i)} onMouseDown={() => { props.onSel(i); props.onUse(i) }}>
                      <box width={2}><text fg={on ? theme.primary : theme.textMuted}>{on ? "▸ " : "  "}</text></box>
                      <box flexGrow={1} minWidth={0} height={1} overflow="hidden"><text fg={r.active ? theme.accent : theme.text}>
                        {r.active ? "● " : "  "}<strong>{r.name}</strong>
                      </text></box>
                    </box>
                  )
                })}
          </scrollbox>
        </box>
      </TabShell>
    </box>
  )
}

export const EikonCardGrid = (props: {
  rows: EikonCard[]
  sel: number
  follow: Follow
  empty?: ReactNode
  onSel: (i: number) => void
  onUse: (i: number) => void
}) => {
  const theme = useTheme().theme
  if (props.rows.length === 0) return <box padding={1}>{props.empty ?? <text fg={theme.textMuted}>No eikons found.</text>}</box>
  return (
    <scrollbox ref={props.follow.ref} scrollY flexGrow={1}>
      <box flexDirection="row" flexWrap="wrap" width="100%" flexShrink={0}>
        {props.rows.map((r, i) => {
          const on = i === props.sel
          return (
            <box key={r.key} id={props.follow.id(i)} flexDirection="column" height={r.lines.length + 2}
                 width={cardWidth(r.lines)} flexShrink={0} paddingX={1}
                 backgroundColor={on ? theme.backgroundElement : undefined}
                 onMouseMove={() => props.onSel(i)} onMouseDown={() => { props.onSel(i); props.onUse(i) }}>
              <box height={r.lines.length} overflow="hidden" flexDirection="column">
                {r.lines.map((line, j) => (
                  <box key={j} height={1} overflow="hidden"><text fg={theme.textMuted} wrapMode="none">{line || " "}</text></box>
                ))}
              </box>
              <box height={1} overflow="hidden"><text fg={r.active ? theme.accent : theme.text} wrapMode="none">{on ? "▸ " : "  "}{r.active ? "● " : "  "}<strong>{r.name}</strong></text></box>
              <box height={1} overflow="hidden"><text fg={theme.textMuted} wrapMode="none">by {r.author ?? "unknown"} · {r.status}</text></box>
            </box>
          )
        })}
      </box>
    </scrollbox>
  )
}
