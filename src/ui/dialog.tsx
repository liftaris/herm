import { Component, createContext, useState, useCallback, useMemo, useRef, useSyncExternalStore } from "react"
import { makeUse } from "../context/helper"
import type { ErrorInfo, ReactNode } from "react"
import { useKeyboard, useTerminalDimensions, useRenderer } from "@opentui/react"
import { RGBA, type Renderable } from "@opentui/core"
import { useKeys } from "../keys"
import { useTheme } from "../theme"
import { useToast } from "./toast"

type Entry = {
  readonly element: ReactNode
  readonly onClose?: () => void
  /** When true, the provider does not auto-close this entry on the
   *  cancel key — the dialog owns Esc itself (e.g. a multi-view form
   *  where Esc first backs out of a sub-picker). */
  readonly ownCancel?: boolean
}

export type DialogContext = {
  readonly replace: (element: ReactNode, onClose?: () => void, opts?: { ownCancel?: boolean }) => void
  readonly clear: () => void
  readonly stack: ReadonlyArray<Entry>
  /** Scheduling-independent open probe. `stack.length > 0` is only
   *  reliable once React has committed the provider's setState; a
   *  keypress arriving between replace() and that commit reads stack=[]
   *  (stale closure in the tab's useKeyboard) and leaks through.
   *  `open()` reads a ref set synchronously by replace()/clear(). */
  readonly open: () => boolean
  /** Monotonic token for guarding async replace() calls after close/replacement. */
  readonly version: () => number
  readonly subscribe: (listener: () => void) => () => void
}

const Ctx = createContext<DialogContext | null>(null)

const BACKDROP = RGBA.fromInts(0, 0, 0, 150)

export const DialogProvider = ({ children }: { children: ReactNode }) => {
  const renderer = useRenderer()
  const toast = useToast()
  const [stack, setStack] = useState<Entry[]>([])
  const stackRef = useRef<ReadonlyArray<Entry>>(stack)
  stackRef.current = stack
  const gate = useRef(false)
  const listeners = useRef(new Set<() => void>())
  const gen = useRef(0)
  const prev = useRef<Renderable | null>(null)

  // Refocus whatever held focus before the first dialog opened. The
  // renderable may have been destroyed (tab switched underneath) or
  // detached from the tree, so walk from root to confirm it's still
  // reachable before calling focus(). setTimeout lets the closing
  // dialog's own <input focused> unmount first — focusing into a node
  // that's about to be removed is a no-op in OpenTUI but still bumps
  // currentFocusedRenderable, which would then go stale.
  const refocus = useCallback(() => {
    setTimeout(() => {
      if (gate.current) return
      const target = prev.current
      if (!target || target.isDestroyed) { prev.current = null; return }
      const reachable = (node: Renderable): boolean => {
        for (const c of node.getChildren()) {
          if (c === target || reachable(c)) return true
        }
        return false
      }
      if (reachable(renderer.root)) target.focus()
      prev.current = null
    }, 0)
  }, [renderer])

  const replace = useCallback((element: ReactNode, onClose?: () => void, opts?: { ownCancel?: boolean }) => {
    // Capture focus only on the first open of a chain; a dialog that
    // replaces another (or opens immediately after clear()) should
    // restore to the original composer/textarea, not to whatever the
    // intermediate dialog's <input> happened to focus.
    if (!gate.current && !prev.current) {
      prev.current = renderer.currentFocusedRenderable
      prev.current?.blur()
    }
    gate.current = true
    gen.current++
    for (const listener of listeners.current) listener()
    setStack(cur => {
      for (const e of cur) e.onClose?.()
      return [{ element, onClose, ownCancel: opts?.ownCancel }]
    })
  }, [renderer])

  const clear = useCallback(() => {
    const at = ++gen.current
    setStack(cur => {
      for (const e of cur) e.onClose?.()
      return []
    })
    // Keep open()→true for the remainder of the synchronous emit loop
    // that triggered clear(). Downstream useKeyboard subscribers gate
    // on `dialog.open()` and fire in the same tick; flipping the gate
    // here would let the Esc that closed the dialog fall through to
    // tab-scope handlers as if no dialog had been open. `gen` guards
    // against a replace() that chained synchronously after clear().
    queueMicrotask(() => {
      if (gen.current !== at) return
      gate.current = false
      for (const listener of listeners.current) listener()
    })
    refocus()
  }, [refocus])

  const open = useCallback(() => gate.current, [])
  const version = useCallback(() => gen.current, [])
  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener)
    return () => { listeners.current.delete(listener) }
  }, [])

  const onError = useCallback((err: Error) => {
    clear()
    toast.error(err)
  }, [clear, toast])

  const keys = useKeys()
  useKeyboard((key) => {
    if (stack.length === 0) return
    // An active text selection owns Esc (clear highlight) before the
    // dialog does. Selection.key in useAppKeys handles the general
    // case; this guard covers dialogs whose own <input> grabbed focus.
    if (renderer.getSelection()?.getSelectedText()) return
    const top = stack[stack.length - 1]
    if (top?.ownCancel) return
    if (keys.match("dialog.cancel", key)) clear()
  })

  const value = useMemo<DialogContext>(
    () => ({ replace, clear, get stack() { return stackRef.current }, open, version, subscribe }),
    [replace, clear, open, version, subscribe])
  const top = stack[stack.length - 1]

  return (
    <Ctx.Provider value={value}>
      {children}
      {top ? <Boundary onError={onError}><Overlay entry={top} onClose={clear} /></Boundary> : null}
    </Ctx.Provider>
  )
}

// React error boundaries must be classes — hooks can't catch render
// errors. A throw inside any dialog body (the register-during-render
// loop, a bad picker option, …) bubbles here, onError dismisses the
// dialog + toasts the message, and the TUI stays alive. Dismissal
// unmounts this boundary too, so no state reset is needed.
class Boundary extends Component<
  { readonly children: ReactNode; readonly onError: (err: Error) => void },
  { readonly dead: boolean }
> {
  state = { dead: false }

  static getDerivedStateFromError() {
    return { dead: true }
  }

  componentDidCatch(err: Error, _info: ErrorInfo) {
    this.props.onError(err)
  }

  render() {
    if (this.state.dead) return null
    return this.props.children
  }
}

const Overlay = ({ entry, onClose }: { entry: Entry; onClose: () => void }) => {
  const dims = useTerminalDimensions()
  const theme = useTheme().theme
  const renderer = useRenderer()
  // Dismiss only when both halves of the click land on the backdrop
  // with no selection in between. A mouseup alone (e.g. the tail of
  // the click that opened this dialog, or a drag-select that ended
  // over the scrim) must not close.
  const armed = useRef(false)

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={dims.width}
      height={dims.height}
      zIndex={100}
      backgroundColor={BACKDROP}
      justifyContent="center"
      alignItems="center"
      onMouseDown={() => { armed.current = !renderer.getSelection() }}
      onMouseUp={() => {
        if (!armed.current) return
        armed.current = false
        onClose()
      }}
    >
      <box
        backgroundColor={theme.backgroundPanel}
        borderStyle="single"
        border={true}
        borderColor={theme.border}
        padding={1}
        flexDirection="column"
        onMouseDown={(e) => { e.stopPropagation() }}
        onMouseUp={(e) => { armed.current = false; e.stopPropagation() }}
      >
        {entry.element}
      </box>
    </box>
  )
}

export const useDialog = makeUse(Ctx, "useDialog")

export const useDialogOpen = () => {
  const dialog = useDialog()
  return useSyncExternalStore(dialog.subscribe, dialog.open, dialog.open)
}
