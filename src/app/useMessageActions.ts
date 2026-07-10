import { useCallback, type Dispatch, type MutableRefObject, type RefObject } from "react"
import type { Gateway } from "../context/gateway"
import type { DialogContext } from "../ui/dialog"
import type { ToastContext } from "../ui/toast"
import type { ComposerHandle } from "../components/chat/Composer"
import type { Message } from "../types/message"
import { openMessage } from "../dialogs/message"
import { transcriptToMessages, type Action, type TurnState } from "./turnReducer"
import { undo } from "./undo"

type Args = {
  gw: Gateway
  dialog: DialogContext
  toast: ToastContext
  session: { close: (sid: string) => Promise<unknown> }
  activate: (sid: string) => Promise<boolean>
  composer: RefObject<ComposerHandle | null>
  turn: MutableRefObject<TurnState>
  dispatch: Dispatch<Action>
  focus: (region: "input" | "content") => void
}

const textOf = (message: Message) =>
  message.parts.filter(part => part.type === "text").map(part => part.content).join("")

export function useMessageActions(args: Args) {
  const turns = useCallback((message: Message) => {
    const messages = args.turn.current.messages
    const at = messages.findIndex(item => item.id === message.id)
    return at < 0 ? 0 : messages.slice(at).filter(item => item.role === "user").length
  }, [args.turn])

  const rewind = useCallback(async (message: Message) => {
    if (args.turn.current.streaming) return false
    const count = turns(message)
    if (!count) return false
    try {
      await undo(args.gw, count)
      const result = await args.gw.request<{ messages: import("../context/wire").TranscriptMessage[] }>("session.history")
      args.dispatch({ kind: "load", messages: transcriptToMessages(result.messages ?? []) })
      args.composer.current?.set(textOf(message))
      args.focus("input")
      return true
    } catch (err) {
      args.toast.show({ variant: "error", message: err instanceof Error ? err.message : String(err) })
      return false
    }
  }, [args.gw, args.toast, args.turn, args.dispatch, args.composer, args.focus, turns])

  const fork = useCallback(async (message: Message) => {
    if (args.turn.current.streaming) return
    const result = await args.gw.request<{ session_id: string; title?: string }>("session.branch", {})
      .catch((err: Error) => {
        args.toast.show({ variant: "error", message: `branch failed: ${err.message}` })
        return null
      })
    if (!result?.session_id) return
    try {
      await undo(args.gw, turns(message), result.session_id)
      if (!await args.activate(result.session_id)) {
        await args.session.close(result.session_id)
        return
      }
      args.composer.current?.set(textOf(message))
      args.focus("input")
      args.toast.show({ variant: "success", message: `forked → ${result.title ?? result.session_id}` })
    } catch (err) {
      await args.session.close(result.session_id)
      args.toast.show({ variant: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [args.gw, args.toast, args.turn, args.activate, args.session, args.composer, args.focus, turns])

  const menu = useCallback((message: Message) => {
    if (args.turn.current.streaming) return
    openMessage(args.dialog, message, { rewind, fork, toast: args.toast })
  }, [args.dialog, args.toast, args.turn, rewind, fork])

  return { rewind, fork, menu }
}
