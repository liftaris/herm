import type { ParsedKey, Renderable } from "@opentui/core"
import { copyText } from "./clipboard"
import type { ToastContext } from "../ui/toast"

type Toast = ToastContext

type Renderer = {
  getSelection: () => { getSelectedText: () => string; selectedRenderables: Renderable[] } | null
  clearSelection: () => void
  currentFocusedRenderable: Renderable | null
}

function yank(renderer: Renderer, toast?: Toast): boolean {
  const text = renderer.getSelection()?.getSelectedText()
  if (!text) return false
  void copyText(text, toast)
    .catch(() => toast?.show({ variant: "error", message: "Clipboard write failed" }))
  renderer.clearSelection()
  return true
}

// Earliest-possible key interceptor for an active text selection.
// Returns true when the key was consumed and the caller should
// stopPropagation + early-return. Called before any other shell binding
// so Esc clears the selection instead of closing a dialog or arming the
// interrupt counter, and Ctrl+C copies instead of clearing the prompt.
export function key(renderer: Renderer, evt: ParsedKey, toast?: Toast): boolean {
  const sel = renderer.getSelection()
  // A zero-length selection (single click, no drag) is not a real
  // selection for key-routing purposes — let the key through so a
  // click-then-Esc still closes the dialog on the first press.
  if (!sel?.getSelectedText()) return false

  if (evt.ctrl && evt.name === "c") {
    yank(renderer, toast)
    return true
  }

  if (evt.name === "escape") {
    renderer.clearSelection()
    return true
  }

  // Any other key: if the selection lives inside the focused renderable
  // (typing over a textarea selection), leave it to the renderable's own
  // handler. Otherwise clear — a stray keypress shouldn't leave a stale
  // highlight on screen.
  const focus = renderer.currentFocusedRenderable
  if (focus && sel.selectedRenderables.includes(focus)) return false
  renderer.clearSelection()
  return false
}

export * as Selection from "./selection"
