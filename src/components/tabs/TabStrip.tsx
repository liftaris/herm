import { memo } from "react"
import { useTheme } from "../../theme"

// Shared horizontal tab strip. Top-level TabBar and per-group SubTabBar
// both render this; callers supply the nav chord and hint text. No digit
// prefix or bullet; active entry gets a bold label on backgroundElement.
// Keyboard lives in useAppKeys; this is click + paint only.

type Props = {
  tabs: readonly string[]
  active: number
  onChange: (i: number) => void
  hint?: string
  menu?: boolean
}

export const TabStrip = memo(({ tabs, active, onChange, hint, menu }: Props) => {
  const theme = useTheme().theme
  return (
    <box width="100%" flexDirection="row" height={1} overflow="hidden"
         backgroundColor={menu ? theme.backgroundMenu : undefined}>
      {tabs.map((name, i) => (
        <box
          key={i}
          onMouseDown={() => onChange(i)}
          paddingX={2}
          marginRight={1}
          flexShrink={0}
          backgroundColor={i === active ? theme.backgroundElement : undefined}
        >
          <text fg={i === active ? theme.primary : theme.textMuted}>
            <strong>{name}</strong>
          </text>
        </box>
      ))}
      <box flexGrow={1} minWidth={0} />
      {hint ? (
        <box paddingX={1} flexShrink={1} minWidth={0} overflow="hidden">
          <text fg={theme.borderSubtle}>{hint}</text>
        </box>
      ) : null}
    </box>
  )
})
