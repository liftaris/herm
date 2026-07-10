import { memo, useEffect, type ReactNode } from "react"
import type { Message, Usage } from "../types/message"
import type { SessionInfo } from "../context/wire"
import { Sessions } from "./Sessions"
import { Context } from "./Context"
import { Analytics } from "./Analytics"
import { Journey } from "./Journey"
import { SubTabBar } from "../components/tabs/SubTabBar"
import { SUB_TABS, SESSIONS_TAB } from "../app/tabs"

type Props = {
  focused?: boolean
  sub: number
  setSub: (i: number) => void
  // Sessions
  onSwitch?: (sid: string) => void
  onActivateLive?: (sid: string) => void
  currentId?: string
  // Context
  messages?: Message[]
  sessionStart: number
  info?: SessionInfo
  usage?: Usage
}

// Consolidates the former Sessions / Context / Analytics tabs under a
// single top-level Sessions tab. Sub-tab state is owned by app.tsx so
// slash routes (e.g. `/context`) and the shell's Shift+←/→ cycle can
// address a sub-tab directly. Only the active sub-tab is mounted —
// each sub-tab runs its own fetches/useHome subscriptions and double-
// mounting would duplicate traffic without a visible payoff (state is
// cheap to rebuild from ~/.hermes on next switch).
export const SessionsGroup = memo((props: Props) => {
  const labels = SUB_TABS[SESSIONS_TAB]
  // Clamp defensively — if the sub-tab list shrinks later, drifted
  // indices would render nothing.
  useEffect(() => {
    if (props.sub >= labels.length) props.setSub(0)
  }, [props.sub, labels.length])
  const hint = "shift+←/→ sub"
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0}>
      <SubTabBar tabs={labels} active={props.sub} onChange={props.setSub} hint={hint} />
      <box flexGrow={1} minWidth={0} flexDirection="column">
        <Pane visible={props.sub === 0}>
          <Sessions focused={!!props.focused && props.sub === 0}
                    onSwitch={props.onSwitch}
                    onActivateLive={props.onActivateLive}
                    currentId={props.currentId} />
        </Pane>
        <Pane visible={props.sub === 1}>
          <Context focused={!!props.focused && props.sub === 1}
                   messages={props.messages} sessionStart={props.sessionStart} info={props.info} usage={props.usage} />
        </Pane>
        <Pane visible={props.sub === 2}>
          <Analytics focused={!!props.focused && props.sub === 2} />
        </Pane>
        <Pane visible={props.sub === 3}>
          <Journey focused={!!props.focused && props.sub === 3} />
        </Pane>
      </box>
    </box>
  )
})

const Pane = ({ visible, children }: { visible: boolean; children: ReactNode }) =>
  visible ? <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">{children}</box> : null
