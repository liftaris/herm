import { memo } from "react"
import { useKeys } from "../../keys"
import { TabStrip } from "./TabStrip"

// Top-level tab row. Thin adapter over TabStrip that maps the TABS
// registry's {name, description} entries down to bare names and
// supplies the top-level nav hint. The <leader>+N / Alt+N direct-jump
// chords still work (useAppKeys) — they're just no longer painted per
// label, since with four consolidated groups the row has room and the
// hint already advertises the chord.

type Tab = { name: string; description: string }

type Props = {
  tabs: ReadonlyArray<Tab>
  activeTab: number
  onTabChange: (i: number) => void
}

export const TabBar = memo(({ tabs, activeTab, onTabChange }: Props) => {
  const keys = useKeys()
  const hint = `${keys.print("tab.prev")}/${keys.print("tab.next")} or ${keys.print("leader")} N`
  return (
    <TabStrip
      tabs={tabs.map(t => t.name)}
      active={activeTab}
      onChange={onTabChange}
      hint={hint}
      menu
    />
  )
})
