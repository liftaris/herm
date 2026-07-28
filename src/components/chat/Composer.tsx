// Composer — owns the chat input buffer, slash popover, ghost completion
// and prompt history. The shell (app.tsx) drives keyboard routing through
// the imperative handle so there is exactly one global useKeyboard.

import { forwardRef, memo, useImperativeHandle, useRef, useState, useCallback, useMemo, useEffect } from "react"
import type { TextareaRenderable, PasteEvent } from "@opentui/core"
import { decodePasteBytes } from "@opentui/core"
import { useTheme } from "../../theme"
import { useKeys, toBindings } from "../../keys"
import { useGateway } from "../../context/gateway"
import type { ImageAttachResponse, DropDetectResponse } from "../../context/wire"
import { looksLikePath } from "../../utils/drop"
import { resolve as resolveSlash, type SlashCommand } from "../../app/slashCommands"
import { replaceSlashToken, useSlashPopover } from "../../app/useSlashPopover"
import { useAtRefPopover, atWordAt } from "../../app/useAtRefPopover"
import { acceptCompletion, useCompletion } from "../../app/useCompletion"
import { frecency } from "../../app/frecency"
import { useInputHistory, type HistEntry } from "../../app/useInputHistory"
import { useBackground } from "../../app/background"
import { PartsBuffer, styles as partStyles, type Part, type FilePart } from "../../app/parts"
import { SlashPopover } from "./SlashPopover"
import { AtRefPopover } from "./AtRefPopover"
import { ChafaImage } from "../../ui/ChafaImage"
import { trunc } from "../../ui/fmt"
import { SpinGlyph } from "../../ui/spinner"
import { MediaChip, classify } from "./MediaChip"
import type { HiddenContext } from "../sidebar/Sidebar"

export type ComposerHandle = {
  value: () => string
  set: (v: string) => void
  /** Insert text at the cursor (verbatim, multi-line ok). */
  insert: (text: string) => void
  /** Append to prompt history without sending (draft save on Ctrl+C). */
  remember: (text: string) => void
  /** Logical line count of the current buffer. */
  lines: () => number
  /** True iff the buffer is empty (no text, no whitespace-only). */
  isEmpty: () => boolean
  /** Composer mode — used by useAppKeys for Esc/backspace-@0 exit. */
  mode: () => "normal" | "shell"
  setMode: (m: "normal" | "shell") => void
  /** Textarea cursorOffset (caret-aware `!` at 0 → shell mode entry). */
  caret: () => number
  popOpen: () => boolean
  popNav: (d: -1 | 1) => void
  popAccept: () => void
  popCancel: () => void
  /** Returns false when not applicable (multi-line buffer → caller lets textarea own ↑/↓). */
  historyUp: () => boolean
  historyDown: () => boolean
}

type Props = {
  focused: boolean
  canSubmitPrompt: boolean
  ready: boolean
  streaming: boolean
  starting?: boolean
  status?: string
  model?: string
  subagents?: number
  /** Set for ~5s after the first Esc of the interrupt double-tap. */
  escHint?: boolean
  queue?: ReadonlyArray<string>
  attachments?: ReadonlyArray<ImageAttachResponse>
  hidden?: HiddenContext
  cmds: ReadonlyArray<SlashCommand>
  onSend: (text: string, parts?: readonly Part[]) => void
  onSlash: (cmd: SlashCommand) => void
  /** Shell-mode submit (`!` at cursor 0). Not a prompt turn — routed
   *  to shell.exec and rendered as a transcript $ cmd / stdout pair. */
  onShell?: (command: string) => void
  onAttach?: (r: ImageAttachResponse) => void
  /** Fired on an empty bracketed paste (Windows Terminal image-only clipboard). */
  onAttachClipboard?: () => void
  onEnqueue?: (text: string) => void
  onDequeue?: (i: number) => void
  onSubmitBlocked?: () => void
  /** Enter pressed with an empty buffer. Return true to consume. */
  onEmptyEnter?: () => boolean
  /** Fires on the empty↔non-empty edge of the input buffer. */
  onDirty?: (dirty: boolean) => void
}

export const resumeHint = (subagents: number | undefined, streaming: boolean) => {
  const count = typeof subagents === "number" ? subagents : 0
  if (count < 1 || streaming) return undefined
  return count === 1 ? "↩ resumes when subagent finishes" : `↩ resumes when ${count} subagents finish`
}

const MAX_ROWS = 6
const MAX_PREVIEWS = 2

function fmt(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export const Composer = memo(forwardRef<ComposerHandle, Props>((props, ref) => {
  const theme = useTheme().theme
  const syntaxStyle = useTheme().syntaxStyle
  const gw = useGateway()
  const keys = useKeys()
  const bg = useBackground()
  const ta = useRef<TextareaRenderable | null>(null)
  const buf = useRef<PartsBuffer | null>(null)
  const sids = useMemo(() => partStyles(syntaxStyle, theme), [syntaxStyle, theme])
  // Mirror of the textarea buffer. The renderable is the source of truth;
  // this drives React-side derivations (popover matching, row count, hints).
  const [input, setInput] = useState("")
  const [caret, setCaret] = useState(0)
  // `!` at cursor 0 (empty or line start) flips to shell mode; submit
  // routes to onShell, Esc/backspace@0 return to normal. Slash/@ and
  // history are disabled in shell mode.
  const [mode, setMode] = useState<"normal" | "shell">("normal")
  const modeRef = useRef(mode); modeRef.current = mode

  // Slash and @-ref popovers are cursor-relative over the current buffer.
  // Slash command execution stays whole-buffer only; mixed prose accepts
  // replace the token under the cursor without invoking local commands.
  const pop = useSlashPopover(mode === "normal" ? input : "", props.cmds, caret)
  const atSpot = mode === "normal" ? atWordAt(input, caret) : null
  const at = useAtRefPopover(mode === "normal" ? input : "", caret)
  const slashReq = pop.spot && !pop.open && pop.spot.query
    ? { method: "complete.slash" as const, params: { text: pop.spot.text }, replaceFrom: pop.spot.start + 1, replaceTo: pop.spot.end }
    : null
  const comp = useCompletion(mode === "normal" && !atSpot ? input : "", mode !== "normal" || pop.open, gw, slashReq)

  const write = useCallback((v: string) => {
    // clear() wipes text + extmarks via setText(""); replay v after.
    buf.current?.clear()
    if (v) ta.current?.setText(v)
    ta.current?.gotoBufferEnd()
    setInput(v)
  }, [])

  // Entries with parts restore via snapshot so chips + ranges rebuild.
  const restore = useCallback((e: HistEntry) => {
    if (e.parts.length === 0) { write(e.input); return }
    buf.current?.fromSnapshot({ v: 1, input: e.input, parts: [...e.parts] })
    setInput(e.input)
  }, [write])

  const hist = useInputHistory(input, restore)

  // Merged over the renderable's default map (which has bare return →
  // newline), so input.submit's `return` entry overrides it and the
  // newline alternates add on top. Recomputes only when a user rebinds.
  const bindings = useMemo(() => [
    ...toBindings(keys.chord("input.submit"), "submit"),
    ...toBindings(keys.chord("input.newline"), "newline"),
  ], [keys])

  // Hold latest pop/props in a ref so the imperative handle is stable.
  const live = useRef({ pop, at, comp, props, input })
  live.current = { pop, at, comp, props, input }

  // Notify parent only on the empty↔non-empty edge so the splash
  // continue-prompt can hide the moment typing starts.
  const wasDirty = useRef(false)
  useEffect(() => {
    const dirty = input.trim().length > 0
    if (dirty === wasDirty.current) return
    wasDirty.current = dirty
    live.current.props.onDirty?.(dirty)
  }, [input])

  // Selecting a popover entry: subcommand synthetics (name contains a
  // space) complete the input for further typing; real commands dispatch.
  const select = (c: SlashCommand) => {
    const spot = live.current.pop.spot
    if (spot && !spot.whole) {
      write(replaceSlashToken(live.current.input, spot, c))
      return
    }
    if (c.name.includes(" ")) { write(`/${c.name} `); return }
    write("")
    live.current.props.onSlash(c)
  }

  const fill = (c: SlashCommand) => {
    const p = live.current.pop
    if (!p.spot) return
    const next = replaceSlashToken(live.current.input, p.spot, c)
    p.dismiss(next)
    write(next)
  }

  // Complete @-refs land as styled chips; prefix keywords that keep the
  // popover open have nothing to anchor a mark to and stay plain text.
  const atAccept = (idx?: number) => {
    const off = ta.current?.cursorOffset
    const src = live.current.input
    const which = idx ?? live.current.at.cursor
    const it = live.current.at.items[which]
    if (!it) return
    const a = atWordAt(src, off)
    const trail = it.text.endsWith(":") || it.text.endsWith("/")
    const b = buf.current
    if (trail || !b || !ta.current || !a) {
      const next = live.current.at.accept(src, idx, off)
      if (next !== null) write(next)
      return
    }
    // Splice the @word out via deleteRange — setText would wipe every
    // prior chip's mark.
    if (it.text.includes(":")) frecency.bump(it.text)
    const eb = ta.current.editBuffer
    const s = eb.offsetToPosition(a.start)
    const e = eb.offsetToPosition(a.start + a.word.length)
    if (!s || !e) return
    ta.current.deleteRange(s.row, s.col, e.row, e.col)
    ta.current.cursorOffset = a.start
    const part: FilePart = {
      type: "file",
      mime: "text/uri-list",
      filename: it.text,
      source: { type: "file", path: it.text, text: { start: a.start, end: a.start + it.text.length, value: it.text } },
    }
    b.insertPart(part, it.text)
    setInput(ta.current.plainText)
  }

  // Paste routing, in priority order:
  //  0. Empty payload → probe the OS clipboard for an image. Windows
  //     Terminal sends a zero-byte bracketed paste for image-only content.
  //  1. Single-line paste that *looks* like a local path → ask the gateway.
  //     input.detect_drop is authoritative (stats the file, handles file://,
  //     quoting, escaped spaces, ~/ expansion, WSL drive rewriting). Image
  //     hits append to session["attached_images"] server-side; herm mirrors
  //     the chip and inserts only the trailing remainder text, not the
  //     `[User attached image: …]` placeholder (that's for blind clients).
  //     Non-image hits (pdf/txt/…) mirror as chips and insert the
  //     `[User attached file: …]` wrapper so the agent sees the path.
  //     Any miss falls through.
  //  2. ≥5 lines → gateway writes a temp file and hands back a
  //     `[Pasted #N …]` placeholder (hermes CLI convention; expanded
  //     server-side in prompt.submit).
  //  3. Otherwise insert verbatim minus trailing newlines — terminals append
  //     one on bracketed paste and `echo`/`cat` output copied from a shell
  //     always carries one, so a naive 1-line paste would otherwise push the
  //     cursor to a blank second row. A paste that is *only* newlines is let
  //     through unchanged (intentional line break).
  const paste = useCallback((e: PasteEvent) => {
    e.preventDefault()
    const raw = decodePasteBytes(e.bytes).replace(/\r\n?/g, "\n")
    const text = /[^\n]/.test(raw) ? raw.replace(/\n+$/, "") : raw
    if (!text) {
      live.current.props.onAttachClipboard?.()
      return
    }
    const verbatim = () => ta.current?.insertText(text)
    if (looksLikePath(text)) {
      gw.request<DropDetectResponse>("input.detect_drop", { text })
        .then(r => {
          if (!r.matched) return verbatim()
          if (r.is_image) {
            const { path, count, name, width, height, token_estimate } = r
            live.current.props.onAttach?.({ attached: true, path, count, name, width, height, token_estimate })
            if (!r.text.startsWith("[User attached")) ta.current?.insertText(r.text + " ")
            return
          }
          live.current.props.onAttach?.({ attached: true, path: r.path, name: r.name })
          ta.current?.insertText(r.text + " ")
        })
        .catch(verbatim)
      return
    }
    if (text.split("\n").length < 5) return verbatim()
    gw.request<{ placeholder: string }>("paste.collapse", { text })
      .then(r => ta.current?.insertText(r.placeholder + " "))
      .catch(verbatim)
  }, [gw])

  const submit = () => {
    // Popover accept runs first — slash commands and @-ref completion
    // stay live while streaming so /steer, /stop, tab jumps, and queued
    // /cmd prompts all resolve against the catalog.
    const a = live.current.at
    if (a.open) return atAccept()
    const cc = live.current.comp
    if (cc.open) {
      const it = cc.items[cc.cursor]
      if (!it || !it.text) return
      write(acceptCompletion(live.current.input, it, cc.replaceFrom, cc.replaceTo))
      return
    }
    const p = live.current.pop
    if (p.open && !(p.spot?.whole && p.spot.query.includes(" "))) {
      const c = p.popover?.[p.cursor]
      if (c) fill(c)
      return
    }
    const exp = buf.current?.expand() ?? { text: live.current.input, parts: [] }
    if (modeRef.current === "shell") {
      const cmd = exp.text.trim()
      if (!cmd) return
      hist.push({ input: cmd, parts: exp.parts })
      write("")
      setMode("normal")
      live.current.props.onShell?.(cmd)
      return
    }
    const text = exp.text.trim()
    const local = text.startsWith("/") && (() => {
      const name = text.match(/^\/(\S+)/)?.[1] ?? ""
      const r = resolveSlash(live.current.props.cmds, name)
      return "hit" in r && r.hit.target === "local"
    })()
    if (live.current.props.streaming) {
      if (!text) return
      if (!live.current.props.canSubmitPrompt && !local) { live.current.props.onSubmitBlocked?.(); return }
      hist.push({ input: text, parts: exp.parts })
      write("")
      // Slash-shaped input routes through onSend so send() → slash()
      // can apply per-command streaming policy (local cases fire now,
      // gateway-target cases self-queue). Only plain text hits the
      // app-side busy-mode branch.
      if (text.startsWith("/")) return void live.current.props.onSend(text, exp.parts)
      live.current.props.onEnqueue?.(text)
      return
    }
    const hasAtt = (live.current.props.attachments?.length ?? 0) > 0
    if (!text && !hasAtt) { live.current.props.onEmptyEnter?.(); return }
    if (!live.current.props.canSubmitPrompt && !local) { live.current.props.onSubmitBlocked?.(); return }
    if (text) hist.push({ input: text, parts: exp.parts })
    write("")
    live.current.props.onSend(text, exp.parts)
  }

  useImperativeHandle(ref, () => ({
    value: () => live.current.input,
    set: write,
    insert: (text) => ta.current?.insertText(text),
    remember: hist.push,
    lines: () => (ta.current?.lineCount ?? 1),
    isEmpty: () => live.current.input.trim().length === 0,
    mode: () => modeRef.current,
    setMode,
    caret: () => ta.current?.cursorOffset ?? 0,
    popOpen: () => live.current.pop.open || live.current.at.open || live.current.comp.open,
    popNav: (d) => {
      const a = live.current.at
      if (a.open) return a.setCursor(c => Math.max(0, Math.min(a.items.length - 1, c + d)))
      const cc = live.current.comp
      if (cc.open) return cc.setCursor(c => Math.max(0, Math.min(cc.items.length - 1, c + d)))
      const max = (live.current.pop.popover?.length ?? 1) - 1
      pop.setCursor(c => Math.max(0, Math.min(max, c + d)))
    },
    popAccept: () => {
      const a = live.current.at
      if (a.open) return atAccept()
      const cc = live.current.comp
      if (cc.open) {
        const it = cc.items[cc.cursor]
        if (it?.text) write(acceptCompletion(live.current.input, it, cc.replaceFrom, cc.replaceTo))
        return
      }
      const p = live.current.pop
      const c = p.popover?.[p.cursor]
      if (c) fill(c)
    },
    popCancel: () => {
      const a = live.current.at
      if (a.open) return a.dismiss()
      const cc = live.current.comp
      if (cc.open) return cc.dismiss()
      const p = live.current.pop
      if (p.open && p.spot && !p.spot.whole) return p.dismiss()
      write("")
    },
    // History nav is cursor-aware: ↑ fires when the caret is on the
    // first line, ↓ on the last. On a multi-line buffer the first
    // press jumps to the edge, the second navigates — ↑↑ from
    // mid-buffer reaches history without the textarea eating either
    // key. Uses cursorOffset rather than visualCursor.visualRow since
    // the latter is viewport-relative and drifts once the buffer
    // scrolls past maxHeight.
    historyUp: () => {
      const t = ta.current
      if (!t || modeRef.current === "shell") return false
      const buf = live.current.input
      if (t.cursorOffset > 0 && buf.lastIndexOf("\n", t.cursorOffset - 1) >= 0) return false
      if (buf.includes("\n") && t.cursorOffset !== 0) { t.cursorOffset = 0; return true }
      hist.up()
      return true
    },
    historyDown: () => {
      const t = ta.current
      if (!t || modeRef.current === "shell") return false
      const buf = live.current.input
      if (buf.indexOf("\n", t.cursorOffset) >= 0) return false
      if (buf.includes("\n") && t.cursorOffset !== buf.length) { t.cursorOffset = buf.length; return true }
      hist.down()
      return true
    },
  }), [hist.up, hist.down, pop.setCursor, write])

  // Stable ref callback so re-renders don't cycle r → null → r and drop
  // the PartsBuffer mid-edit; sids via closure so theme swaps rebuild
  // through the unmount path.
  const sidsRef = useRef(sids); sidsRef.current = sids
  const taRef = useCallback((r: TextareaRenderable | null) => {
    ta.current = r
    if (r && !buf.current) buf.current = new PartsBuffer(r, sidsRef.current)
    if (!r) buf.current = null
  }, [])

  const label = !props.ready ? "Connecting..."
    : props.starting ? (props.status || "Starting agent...")
    : props.streaming ? (props.status || "Generating...")
    : "Ready"
  const dot = props.ready ? (props.streaming ? theme.warning : theme.success) : theme.error
  const resume = resumeHint(props.subagents, props.streaming)

  // Logical-line row count (wrap-induced growth ignored; yoga sizes the
  // textarea, this only positions the absolute popover above the border).
  const rows = Math.min(MAX_ROWS, Math.max(1, input.split("\n").length))
  const all = props.attachments ?? []
  const previews = all.filter(a => a.path && classify(a.path) === "img").slice(0, MAX_PREVIEWS)
  const chips = all.filter(a => !previews.includes(a)).slice(0, MAX_PREVIEWS)
  const shown = new Set([...previews, ...chips])
  const attRows = all.length > 0 ? (previews.length > 0 ? 2 : 1) : 0
  const lift = rows + attRows + 3
  const more = all.filter(a => !shown.has(a)).length
  const bits = [
    props.hidden?.profile,
    props.hidden?.title,
    props.hidden?.place,
    props.hidden?.context,
  ].filter(Boolean)

  return (
    <box flexDirection="column" position="relative">
      {props.focused && pop.open ? (
        <box position="absolute" bottom={lift} left={0} right={0} zIndex={2}>
          <SlashPopover
            commands={pop.popover!}
            cursor={pop.cursor}
            onCursor={pop.setCursor}
            onSelect={select}
          />
        </box>
      ) : props.focused && at.open ? (
        <box position="absolute" bottom={lift} left={0} right={0} zIndex={2}>
          <AtRefPopover
            items={at.items}
            cursor={at.cursor}
            onCursor={at.setCursor}
            onSelect={atAccept}
          />
        </box>
      ) : props.focused && comp.open ? (
        <box position="absolute" bottom={lift} left={0} right={0} zIndex={2}>
          <AtRefPopover
            items={comp.items}
            cursor={comp.cursor}
            onCursor={comp.setCursor}
            onSelect={idx => {
              const it = comp.items[idx]
              if (it?.text) write(acceptCompletion(input, it, comp.replaceFrom, comp.replaceTo))
            }}
          />
        </box>
      ) : null}

      {(props.queue?.length ?? 0) > 0 ? (
        <box flexDirection="column" paddingX={1} paddingBottom={1}>
          {props.queue!.map((q, i) => (
            <box key={i} height={1} onMouseDown={() => props.onDequeue?.(i)}>
              <text>
                <span fg={theme.borderSubtle}>{i === 0 ? "╭" : "│"} </span>
                <span fg={theme.textMuted}>⏸ {i + 1}. {trunc(q, 60)}</span>
              </text>
            </box>
          ))}
        </box>
      ) : null}

      <box
        border
        borderStyle="single"
        borderColor={mode === "shell" ? theme.primary
          : props.focused ? theme.borderActive : theme.border}
        flexDirection="column"
        position="relative"
      >
        {previews.length > 0 ? (
          <box flexDirection="column" paddingX={1} maxHeight={MAX_PREVIEWS} overflow="hidden">
            {previews.map(a => <ChafaImage key={`p-${a.path}`} path={a.path!} width={60} bare />)}
          </box>
        ) : null}
        {chips.length > 0 ? (
          <box flexDirection="row" flexWrap="wrap" gap={1} paddingX={1} paddingTop={previews.length > 0 ? 0 : 1} paddingBottom={1}>
            {chips.map((a, i) => {
              if (a.path) {
                const kind = classify(a.path)
                return (
                  <box key={a.path} flexDirection="row" height={1}>
                    <MediaChip path={a.path} bare={kind === "img"} />
                    {kind !== "img" && a.token_estimate ? <text fg={theme.textMuted}> ~{fmt(a.token_estimate)}t</text> : null}
                  </box>
                )
              }
              return (
                <text key={a.name ?? i}>
                  <span bg={theme.secondary} fg={theme.background}> file </span>
                  <span bg={theme.backgroundElement} fg={theme.textMuted}> {a.name ?? `file ${i + 1}`} </span>
                </text>
              )
            })}
            {more > 0 ? <text fg={theme.textMuted}>+{more}</text> : null}
          </box>
        ) : null}
        <box flexDirection="row">
          <box width={1}><text fg={theme.primary}>{mode === "shell" ? "$" : ">"}</text></box>
          <box width={1} />
          <textarea
            ref={taRef}
            syntaxStyle={syntaxStyle}
            onContentChange={() => {
              const t = ta.current
              setInput(t?.plainText ?? "")
              setCaret(t?.cursorOffset ?? 0)
            }}
            onCursorChange={() => {
              // Only worth a re-render when @-completion might retarget;
              // otherwise ←/→ in a long prompt would reconcile Composer
              // on every keystroke for no observable effect.
              if (!live.current.input.includes("@") && !live.current.input.includes("/")) return
              const off = ta.current?.cursorOffset ?? 0
              setCaret(c => c === off ? c : off)
            }}
            onSubmit={submit}
            onPaste={paste}
            keyBindings={bindings}
            wrapMode="word"
            minHeight={1}
            maxHeight={MAX_ROWS}
            placeholder={mode === "shell" ? "Run a shell command (30s cap, cwd) — esc or ⌫ to exit" : props.streaming ? "Type to queue... (Enter queues, click chip to edit)" : "Message Hermes... (/ for commands, Shift+Enter for newline)"}
            focused={props.focused}
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.textMuted}
            cursorColor={theme.text}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            flexGrow={1}
          />
        </box>
        {pop.ghost && props.focused && rows === 1 && pop.spot?.whole ? (
          <box position="absolute" top={attRows} left={2 + input.length} height={1}>
            <text fg={theme.textMuted}>{pop.ghost}</text>
          </box>
        ) : null}
      </box>

      <box height={1} flexDirection="row" paddingX={1}>
        <text>
          {props.streaming ? <SpinGlyph fg={dot} /> : <span fg={dot}>●</span>}
          <span fg={theme.textMuted}> {mode === "shell" ? "Shell" : label}</span>
          {mode === "shell"
            ? <span fg={theme.textMuted}>  esc exit shell mode</span>
            : props.starting && props.escHint
            ? <span fg={theme.warning}>  esc again to cancel</span>
            : props.starting
            ? <span fg={theme.textMuted}>  esc×2 cancel</span>
            : props.streaming && props.escHint
            ? <span fg={theme.warning}>  esc again to interrupt</span>
            : props.streaming
            ? <span fg={theme.textMuted}>  esc×2 interrupt</span>
            : null}
        </text>
        <box flexGrow={1} />
        {props.streaming && (props.queue?.length ?? 0) > 0 ? (
          <text fg={theme.textMuted}>{keys.print("queue.flush")} to send queued now  </text>
        ) : null}
        {bg.count > 0 ? <text fg={theme.text}>▶ {bg.count}  </text> : null}
        {resume ? <text fg={theme.textMuted}>{resume}  </text> : null}
        {bits.length > 0 ? <text fg={theme.textMuted}>{trunc(bits.join(" · "), 56)}  </text> : null}
        {props.model ? <text fg={theme.textMuted}>{props.model}</text> : null}
      </box>
    </box>
  )
}))
