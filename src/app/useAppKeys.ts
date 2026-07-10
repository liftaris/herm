// Shell-level keyboard routing. Input-scoped keys (popover nav, prompt
// history) are delegated to the Composer via its imperative handle so
// there is exactly one global useKeyboard.

import { useKeyboard, useRenderer } from "@opentui/react"
import { resolveRenderLib, RGBA, type ParsedKey } from "@opentui/core"

/** Wipe the physical screen and force a full re-emit on next frame. */
export function redraw(renderer: {
  rendererPtr: unknown
  currentRenderBuffer: { clear(c: unknown): void }
  requestRender(): void
}) {
  resolveRenderLib().clearTerminal(renderer.rendererPtr as never)
  renderer.currentRenderBuffer.clear(RGBA.fromValues(0, 0, 0, 0))
  renderer.requestRender()
}
import { useRef, useEffect, type RefObject } from "react"
import { editInEditor } from "../utils/editor"
import { Selection } from "../utils/selection"
import { useKeys, conflicts } from "../keys"
import { print as chordPrint } from "../keys/chord"
import { isDegradedMouseInput } from "./mouseFilter"
import type { ComposerHandle } from "../components/chat/Composer"
import { isVoiceToggleKey } from "../voice/platform"
import type { ToastContext } from "../ui/toast"
import type { VoiceKey } from "../voice/types"

const INTERRUPT_MS = 5000
export const DOUBLE_TAB_MS = 400
export const QUIT_MS = 2000

type Region = "input" | "content"

type Opts = {
  tab: number
  tabMax: number
  chatTab: number
  setTab: (fn: (t: number) => number) => void
  /** Sub-tab count for the active top-level tab (0 if no sub-tabs, e.g. Chat). */
  subCount: number
  /** Cycle sub-tab within the active top-level tab. dir: -1 = prev, +1 = next. */
  cycleSub: (dir: -1 | 1) => void
  focusRegion: Region
  setFocusRegion: (r: Region | ((r: Region) => Region)) => void
  streaming: boolean
  starting: boolean
  dialogOpen: () => boolean
  composer: RefObject<ComposerHandle | null>
  /** Offer the key to a pending inline prompt card. Return true to
   *  consume + stopPropagation; false to fall through to the shell. */
  onPromptKey?: (key: ParsedKey) => boolean
  /** Idle-mode Esc, before focus bounce. Return true to consume. */
  onEscape?: () => boolean
  onInterrupt: () => void
  onInterruptNotice: () => void
  queued: number
  onFlushQueue: () => void
  onQuit: () => void
  onQuitArm: (label: string) => void
  onCopyLast: () => void
  onCopyToast: ToastContext["show"]
  onAttachClipboard: () => void
  /** Remove the last pending attachment (backspace on empty composer). */
  onDetachLast: () => boolean
  onNotice: (text: string) => void
  onToggleSidebar: () => void
  onSteer: () => void
  onStash: () => void
  /** Voice recording key binding + handler from useVoice hook. */
  voiceRecordKey?: VoiceKey
  /** True when voice recording mode is on (/voice on). */
  voiceEnabled?: boolean
  /** Toggle push-to-talk recording (start or stop). */
  onVoiceRecord?: () => void
}

export function useAppKeys(o: Opts) {
  const renderer = useRenderer()
  const keys = useKeys()
  const lastEsc = useRef(0)
  const lastTab = useRef(0)
  const lastQuit = useRef(0)

  // Tabs with their own keyboard surface own focus on entry; Chat keeps
  // the composer since its content region has no keybinds.
  const regionFor = (t: number): Region => t === o.chatTab ? "input" : "content"

  // One-shot conflict scan whenever the resolved table changes (i.e. a
  // user override was written). DEFAULTS are swept by a test, so any
  // hit here is user-introduced — warn but honor the override.
  useEffect(() => {
    const found = conflicts(keys.table)
      // Same chord, disjoint modes — the guards below make these
      // mutually exclusive, not real collisions.
      .filter(c => !(c.a === "session.interrupt" && c.b === "dialog.cancel"))
      .filter(c => !(c.a === "app.exit" && c.b === "input.clear"))
    if (found.length === 0) return
    const first = found[0]
    o.onNotice(
      `Keybinding conflict: ${chordPrint([first.chord])} → ${first.a} and ${first.b}` +
      (found.length > 1 ? ` (+${found.length - 1} more)` : ""),
    )
  }, [keys.table])

  useKeyboard((key) => {
    const c = o.composer.current

    if (isDegradedMouseInput(key)) {
      key.stopPropagation()
      return
    }

    // An active text selection pre-empts every shell binding: Esc
    // clears it (not the dialog, not the interrupt counter), Ctrl+C
    // copies it (not input.clear/app.exit), any other key clears it
    // unless the selection belongs to the focused textarea.
    if (Selection.key(renderer, key, { show: o.onCopyToast, clear: () => {}, error: () => {} })) { key.stopPropagation(); return }

    // oc parity: input_clear (ctrl+c) with non-empty buffer clears and
    // consumes; app_exit (also ctrl+c) fires on the next press. A draft
    // of ≥20 chars is pushed to prompt history first so Ctrl+C doesn't
    // silently eat a half-written message — ↑ brings it back.
    if (keys.match("input.clear", key) && c && !c.isEmpty()) {
      const v = c.value().trim()
      if (v.length >= 20) c.remember(v)
      c.set("")
      lastQuit.current = 0
      key.stopPropagation()
      return
    }
    if (keys.match("input.stash", key)) {
      o.onStash()
      key.stopPropagation()
      return
    }
    // Legacy terminals send Ctrl+Shift+C as plain ^C — guard with a
    // double-tap so a reflexive copy chord doesn't one-shot exit.
    if (keys.match("app.exit", key)) {
      const now = Date.now()
      if (now - lastQuit.current < QUIT_MS) return o.onQuit()
      lastQuit.current = now
      o.onQuitArm(keys.print("app.exit"))
      key.stopPropagation()
      return
    }

    if (keys.match("app.suspend", key)) {
      renderer.suspend()
      process.kill(process.pid, "SIGTSTP")
      // Resumes on SIGCONT; OpenTUI's suspend/resume cycle re-enables
      // raw mode and redraws on the next frame.
      process.once("SIGCONT", () => renderer.resume())
      return
    }

    if (keys.match("app.redraw", key)) {
      // OpenTUI's renderNative() only emits cells that diff against
      // the previous frame, so pty garbage from a child process / ssh
      // banner / macOS Cmd+K sticks until those cells happen to
      // change. clearTerminal() writes CSI 2J + CSI H to wipe the
      // physical screen; zeroing currentRenderBuffer (the diff
      // baseline — same trick resume() uses) makes the next normal
      // render see every populated cell as changed and re-emit it.
      // Calling lib.render(ptr, true) directly would bypass the loop
      // and rot the native buffer-swap state, so go through
      // requestRender() instead.
      redraw(renderer)
      key.stopPropagation()
      return
    }

    if (keys.match("app.sidebar", key)) {
      o.onToggleSidebar()
      return
    }

    // Modal means modal: with a dialog open, the shell yields
    // everything except process-level escapes above. DialogProvider
    // handles Esc-to-close; tabs/composer/interrupt all sit behind the
    // overlay and shouldn't move.
    if (o.dialogOpen()) return

    // Voice recording key — must win before prompt/editor/composer
    // so the configured shortcut always fires push-to-talk.
    if (o.voiceRecordKey && o.onVoiceRecord && isVoiceToggleKey(key, o.voiceRecordKey)) {
      o.onVoiceRecord()
      key.stopPropagation()
      return
    }

    // Shell mode: Esc exits (pre-empts the interrupt double-tap);
    // backspace at offset 0 also exits.
    if (c?.mode() === "shell") {
      if (key.name === "escape") { c.setMode("normal"); key.stopPropagation(); return }
      if (key.name === "backspace" && !key.ctrl && !key.meta && c.caret() === 0) {
        c.setMode("normal"); key.stopPropagation(); return
      }
    }

    if (keys.match("session.steer", key)) {
      o.onSteer()
      key.stopPropagation()
      return
    }

    // Interrupt the turn so the drain effect fires the queued head now.
    // Only meaningful mid-stream with something queued; otherwise fall
    // through (leader was already consumed, so no stray "u" reaches the
    // textarea).
    if (keys.match("queue.flush", key) && (o.streaming || o.starting) && o.queued > 0) {
      o.onFlushQueue()
      key.stopPropagation()
      return
    }

    // Inline prompt gets first refusal on nav/answer keys. It only
    // claims the narrow set it cares about (←/→/↑/↓/Enter/Esc/1-9);
    // everything else — including printable chars while the composer
    // is focused — falls through so typing-to-queue still works.
    if (o.onPromptKey && !keys.leader && !key.ctrl && !key.meta && key.eventType !== "release") {
      if (o.onPromptKey(key)) { key.stopPropagation(); return }
    }

    if (keys.match("editor.open", key) && !o.streaming) {
      const seed = c?.value() ?? ""
      void editInEditor(renderer, seed).then(out => {
        if (out === undefined) {
          if (!process.env.VISUAL && !process.env.EDITOR)
            o.onNotice("Set $EDITOR or $VISUAL to use the external editor")
          return
        }
        c?.set(out)
        o.setFocusRegion("input")
      }).catch((e: Error) => o.onNotice(e.message))
      return
    }

    if (keys.match("tab.prev", key)) {
      o.setTab(t => { const n = Math.max(0, t - 1); o.setFocusRegion(regionFor(n)); return n })
      return
    }
    if (keys.match("tab.next", key)) {
      o.setTab(t => { const n = Math.min(o.tabMax, t + 1); o.setFocusRegion(regionFor(n)); return n })
      return
    }
    // Shift+←/→ cycles sub-tab within the active group. No-op on Chat
    // (subCount=0). Structural, not catalog — sub-tabs are a layout
    // property of a group, not a rebindable concept.
    if (o.subCount > 0 && key.shift && !key.ctrl && !key.meta
        && key.eventType !== "release") {
      if (key.name === "left")  { o.cycleSub(-1); key.stopPropagation(); return }
      if (key.name === "right") { o.cycleSub(1);  key.stopPropagation(); return }
    }
    // <leader> 1..0 → tab 1..10 (1-indexed), <leader> - → tab 11.
    // Structural, not catalog — ten near-identical rebindable actions is
    // noise, and the leader itself is the rebindable part.
    if (keys.leader && !key.ctrl && !key.meta && !key.shift && key.eventType !== "release") {
      const map: Record<string, number> = {
        "1": 0, "2": 1, "3": 2, "4": 3, "5": 4,
        "6": 5, "7": 6, "8": 7, "9": 8, "0": 9, "-": 10,
      }
      const n = map[key.name]
      if (n !== undefined && n <= o.tabMax) {
        o.setTab(() => { o.setFocusRegion(regionFor(n)); return n })
        key.stopPropagation()
        return
      }
    }
    // Alt+1..0 → tab 1..10 (1-indexed), Alt+- → tab 11.
    // Direct single-stroke, no leader needed.
    if (key.meta && !key.ctrl && !key.shift && key.eventType !== "release") {
      const map: Record<string, number> = {
        "1": 0, "2": 1, "3": 2, "4": 3, "5": 4,
        "6": 5, "7": 6, "8": 7, "9": 8, "0": 9, "-": 10,
      }
      const n = map[key.name]
      if (n !== undefined && n <= o.tabMax) {
        o.setTab(() => { o.setFocusRegion(regionFor(n)); return n })
        key.stopPropagation()
        return
      }
    }

    // Popover owns up/down/tab/enter/escape while open; stopPropagation keeps
    // the textarea renderable from also moving the cursor or submitting.
    // Structural — popover nav is composer-state, not a catalog action.
    if (c?.popOpen()) {
      if (key.name === "escape") { c.popCancel(); key.stopPropagation(); return }
      if (key.name === "up") { c.popNav(-1); key.stopPropagation(); return }
      if (key.name === "down") { c.popNav(1); key.stopPropagation(); return }
      if (key.name === "tab" || key.name === "return") { c.popAccept(); key.stopPropagation(); return }
      return
    }

    if (keys.match("focus.cycle", key) && !o.streaming) {
      if (o.tab === o.chatTab) {
        o.setFocusRegion(r => r === "input" ? "content" : "input")
        return
      }
      if (o.focusRegion === "input") {
        o.setFocusRegion("content")
        return
      }
      // Content-focused on a non-Chat tab: single Tab stays (tab owns it as a
      // nav key); double-tap within the window jumps to the composer.
      const now = Date.now()
      if (now - lastTab.current < DOUBLE_TAB_MS) {
        o.setFocusRegion("input")
        lastTab.current = 0
        key.stopPropagation()
      } else {
        lastTab.current = now
      }
      return
    }

    if (keys.match("session.interrupt", key)) {
      if (!o.streaming && !o.starting && o.onEscape?.()) return
      if (o.streaming || o.starting) {
        const now = Date.now()
        if (now - lastEsc.current < INTERRUPT_MS) {
          o.onInterrupt()
          lastEsc.current = 0
          return
        }
        lastEsc.current = now
        o.onInterruptNotice()
        return
      }
      if (o.tab === o.chatTab && o.focusRegion === "content") o.setFocusRegion("input")
      return
    }

    if (keys.match("reply.copy", key)) return o.onCopyLast()
    if (keys.match("clipboard.attach", key)) {
      o.onAttachClipboard()
      key.stopPropagation()
      return
    }

    // ↑/↓ with a single-line buffer cycles prompt history; with a multi-line
    // buffer historyUp/Down return false so the keystroke falls through to
    // the textarea renderable's move-up/move-down. No stopPropagation — on a
    // single-line buffer the textarea's move-up/down is a no-op anyway, and
    // swallowing the key would starve dialog/select renderables that share
    // the global key bus while focusRegion is still "input".
    if (o.focusRegion === "input" && !o.streaming) {
      // `!` at the very start of the buffer enters shell mode. Only in
      // normal mode with no popover; the key is consumed so the `!`
      // literal never lands in the textarea. Kitty may report base
      // `1` + shift when the terminal doesn't send the shifted codepoint.
      if ((key.name === "!" || (key.name === "1" && key.shift))
          && !key.ctrl && !key.meta && key.eventType !== "release"
          && c && c.mode() === "normal" && !c.popOpen() && c.caret() === 0) {
        c.setMode("shell")
        key.stopPropagation()
        return
      }
      if (key.name === "up") {
        const before = c?.value()
        const ok = c?.historyUp()
        return void (ok && c?.value() !== before && key.stopPropagation())
      }
      if (key.name === "down") {
        const before = c?.value()
        const ok = c?.historyDown()
        return void (ok && c?.value() !== before && key.stopPropagation())
      }
      // Backspace at a line start with attachments peels the last
      // attachment. This lets the user detach while drafting without
      // clearing the whole buffer first; mid-line backspace still edits
      // text through the textarea.
      if (key.name === "backspace" && !key.ctrl && !key.meta
          && c && (c.isEmpty() || c.caret() === 0 || c.value()[c.caret() - 1] === "\n")
          && o.onDetachLast()) {
        key.stopPropagation()
        return
      }
    }

    // Printable char while Chat transcript has focus → bounce to composer
    // AND deliver the char (so the first keystroke isn't swallowed). Other
    // tabs own their printable keys (v=reveal, d=delete, …), so the shell
    // must not intercept there.
    if (o.tab === o.chatTab && o.focusRegion === "content" && !o.streaming
        && !key.ctrl && !key.meta && key.eventType !== "release") {
      if (key.name.length === 1 && key.name !== " ") {
        const ch = key.shift && /[a-z]/.test(key.name)
          ? key.name.toUpperCase() : key.name
        o.setFocusRegion("input")
        c?.insert(ch)
        key.stopPropagation()
      }
    }
  })
}
