import { memo, useEffect, type ReactNode } from "react"
import { Config } from "./Config"
import { Skills } from "./Skills"
import { Toolsets } from "./Toolsets"
import { AgentPlugins } from "./AgentPlugins"
import { Env } from "./Env"
import { Memory } from "./Memory"
import { SubTabBar } from "../components/tabs/SubTabBar"
import { SUB_TABS, CONFIG_TAB } from "../app/tabs"

type Props = {
  focused?: boolean
  sub: number
  setSub: (i: number) => void
}

// Consolidates Config / Skills / Toolsets / Env / Memory / Plugins. Order is
// Config first so a bare click on the top-level tab lands on the most
// common target; the rest are alphabetical-ish by frequency of use.
export const ConfigGroup = memo((props: Props) => {
  const labels = SUB_TABS[CONFIG_TAB]
  useEffect(() => {
    if (props.sub >= labels.length) props.setSub(0)
  }, [props.sub, labels.length])
  const hint = "shift+←/→ sub"
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <SubTabBar tabs={labels} active={props.sub} onChange={props.setSub} hint={hint} />
      <box flexGrow={1} minWidth={0} flexDirection="column">
        <Pane visible={props.sub === 0}>
          <Config focused={!!props.focused && props.sub === 0} />
        </Pane>
        <Pane visible={props.sub === 1}>
          <Skills focused={!!props.focused && props.sub === 1} />
        </Pane>
        <Pane visible={props.sub === 2}>
          <Toolsets focused={!!props.focused && props.sub === 2} />
        </Pane>
        <Pane visible={props.sub === 3}>
          <Env focused={!!props.focused && props.sub === 3} />
        </Pane>
        <Pane visible={props.sub === 4}>
          <Memory focused={!!props.focused && props.sub === 4} />
        </Pane>
        <Pane visible={props.sub === 5}>
          <AgentPlugins focused={!!props.focused && props.sub === 5} />
        </Pane>
      </box>
    </box>
  )
})

const Pane = ({ visible, children }: { visible: boolean; children: ReactNode }) =>
  visible ? <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">{children}</box> : null
