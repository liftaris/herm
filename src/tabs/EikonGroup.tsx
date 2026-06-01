import { memo, useCallback, useEffect, useState, type ReactNode } from "react"
import { SubTabBar } from "../components/tabs/SubTabBar"
import { SUB_TABS, EIKON_TAB } from "../app/tabs"
import { EikonStudio } from "./EikonStudio"
import { EikonGallery } from "./EikonGallery"
import { EikonMarketplace } from "./EikonMarketplace"
import { EikonImport } from "./EikonImport"

type Props = {
  focused?: boolean
  sub: number
  setSub: (i: number) => void
}

export const EikonGroup = memo((props: Props) => {
  const labels = SUB_TABS[EIKON_TAB]!
  const [target, setTarget] = useState<string | undefined>(undefined)
  useEffect(() => { if (props.sub >= labels.length) props.setSub(0) }, [props.sub, labels.length])
  const edit = useCallback((name: string) => { setTarget(name); props.setSub(2) }, [props])
  const hint = "shift+←/→ sub"
  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
      <SubTabBar tabs={labels} active={props.sub} onChange={props.setSub} hint={hint} />
      <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">
        <Pane visible={props.sub === 0}>
          <EikonGallery focused={!!props.focused && props.sub === 0} onEdit={edit} />
        </Pane>
        <Pane visible={props.sub === 1}>
          <EikonMarketplace focused={!!props.focused && props.sub === 1} />
        </Pane>
        <Pane visible={props.sub === 2}>
          <EikonStudio focused={!!props.focused && props.sub === 2} name={target} />
        </Pane>
        <Pane visible={props.sub === 3}>
          <EikonImport focused={!!props.focused && props.sub === 3} />
        </Pane>
      </box>
    </box>
  )
})

const Pane = ({ visible, children }: { visible: boolean; children: ReactNode }) =>
  visible ? <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">{children}</box> : null
