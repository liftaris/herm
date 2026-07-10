// Wires the CONTROL=1 HTTP server's Bridge to shell state. No-op
// when control isn't enabled. `state` is a live snapshot updated
// each render so the bridge reads current values without the effect
// re-running (and re-registering) on every key event.

import { useEffect, useRef, type RefObject } from "react"
import { setBridge, enabled } from "./control"
import { useGateway } from "../context/gateway"
import { usePlugins } from "../plugins/runtime"
import { useRenderer } from "@opentui/react"
import { CHAT_TAB } from "./tabs"
import type { Action, TurnState } from "./turnReducer"
import type { ComposerHandle } from "../components/chat/Composer"

type Region = "input" | "content"

export function useBridge(o: {
  tab: number
  ready: boolean
  streaming: boolean
  messages: TurnState["messages"]
  sid: string
  focusRegion: Region
  setTab: (n: number) => void
  setFocusRegion: (r: Region) => void
  dispatch: (a: Action) => void
  composer: RefObject<ComposerHandle | null>
}) {
  const gw = useGateway()
  const renderer = useRenderer()
  const plugins = usePlugins()
  const state = useRef(o); state.current = o

  useEffect(() => {
    if (!enabled) return
    setBridge({
      tab: () => state.current.tab,
      setTab: o.setTab,
      send: async (msg: string) => {
        const s = state.current
        if (!s.ready) throw new Error("not connected")
        if (s.streaming) throw new Error("already streaming")
        s.setTab(CHAT_TAB)
        try {
          await gw.request("prompt.submit", { text: msg })
          s.dispatch({ kind: "user", text: msg })
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err)
          s.dispatch({ kind: "system", text: `Failed to send: ${text}` })
          throw err
        }
      },
      ready: () => state.current.ready,
      streaming: () => state.current.streaming,
      messages: () => state.current.messages.length,
      session: () => state.current.sid,
      input: () => state.current.composer.current?.value() ?? "",
      setInput: (v: string) => state.current.composer.current?.set(v),
      focusRegion: () => state.current.focusRegion,
      setFocusRegion: o.setFocusRegion,
      renderer: () => renderer,
      logs: (n?: number) => gw.tail(n),
      plugin: (id, on) => on ? plugins.activate(id) : plugins.deactivate(id),
      push: ev => (gw as unknown as { emit: (t: string, e: unknown) => void }).emit("event", ev),
    })
  }, [gw, renderer, plugins])
}
