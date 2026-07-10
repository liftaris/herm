// Image/video generation dialog for the Eikon Studio source menu.
// Multi-line textarea for the prompt; optional seed toggle (only when
// the caller passes a seed path); optional seconds slider 1-4 for
// kind="video". Enter submits → spinner → resolves with {path} or null.
//
// Generation runs via `service/eikon-gen.ts`, which spawns the
// installed hermes-agent venv's python and calls the image/video
// tool functions directly — no gateway RPC round-trip.

import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { TextareaRenderable, KeyBinding } from "@opentui/core"
import { useTheme } from "../theme"
import { Spinner } from "../ui/spinner"
import type { DialogContext } from "../ui/dialog"
import type { AvatarState } from "../components/avatar/states"
import type { GenerateFn, GenerateKind } from "../service/eikon-gen"

export type { GenerateKind }

type Opts = {
  state: AvatarState
  kind: GenerateKind
  /** Absolute path to a seed image (e.g. base.png). When provided the
   *  toggle row is shown so users can pick `base.png` vs `none`. */
  seed?: string
  /** Pre-fill the prompt input. */
  lastPrompt?: string
}

type Props = Opts & {
  run: GenerateFn
  onDone: (path: string | null, prompt: string) => void
}

type Field = "prompt" | "seed" | "seconds" | "submit"

// Style hints that make a generated image rasterize well as a mono
// text avatar. Pre-filled on a blank first-open so new users start
// from something usable; leading newline leaves line 1 for their
// own subject description with the cursor parked there.
const BASE = "\nhigh contrast, light subject on dark, black background"

// Bare Enter in the prompt textarea confirms the field and advances
// focus (like a single-line input); Shift+Enter inserts a newline.
// mergeKeyBindings keys on (name, ctrl, shift, meta, super), so
// `return` overrides the default `return → newline` entry exactly.
const BINDS: KeyBinding[] = [
  { name: "return",              action: "submit"  },
  { name: "return", shift: true, action: "newline" },
]

const Generate = (props: Props) => {
  const theme = useTheme().theme
  const ta = useRef<TextareaRenderable | null>(null)
  const flight = useRef(false)
  const [prompt, setPrompt] = useState(props.lastPrompt ?? BASE)
  const [useSeed, setUseSeed] = useState(!!props.seed)
  const [secs, setSecs] = useState(2)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [field, setField] = useState<Field>("prompt")

  // Park the caret at (0,0) so the user types their subject on the
  // blank first line above the pre-filled style hints. initialValue
  // lands the cursor at end-of-buffer by default.
  useEffect(() => { ta.current?.setCursor(0, 0) }, [])

  const fields: readonly Field[] = props.kind === "video"
    ? (props.seed ? ["prompt", "seed", "seconds", "submit"] : ["prompt", "seconds", "submit"])
    : (props.seed ? ["prompt", "seed", "submit"] : ["prompt", "submit"])

  const advance = () => setField(f => fields[(fields.indexOf(f) + 1) % fields.length]!)

  const submit = () => {
    const p = prompt.trim()
    // Blank line 1 with only the pre-filled style hints below = no
    // subject described yet. Don't submit.
    const bare = !props.lastPrompt && p === BASE.trim()
    if (!p || bare || flight.current) {
      if (bare) setErr("describe the subject on line 1")
      return
    }
    flight.current = true
    setBusy(true); setErr(null)
    void props.run(props.kind, p, {
      seed: props.seed && useSeed ? props.seed : undefined,
      seconds: props.kind === "video" ? secs : undefined,
      aspect: props.kind === "video" ? "1:1" : "square",
    }).then(r => {
      if ("err" in r) { setErr(r.err); setBusy(false); return }
      props.onDone(r.path, p)
    }).catch(e => {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }).finally(() => { flight.current = false })
  }

  useKeyboard(key => {
    if (busy) return
    if (key.name === "tab") {
      key.preventDefault()
      const i = fields.indexOf(field)
      const next = fields[(i + (key.shift ? fields.length - 1 : 1)) % fields.length]!
      setField(next)
      return
    }
    if (field === "prompt") return
    if (key.name === "return") return field === "submit" ? submit() : advance()
    if (field === "seed" && (key.name === "space" || key.name === "left" || key.name === "right")) {
      setUseSeed(v => !v)
      return
    }
    if (field === "seconds") {
      if (key.name === "left") return setSecs(v => Math.max(1, v - 1))
      if (key.name === "right") return setSecs(v => Math.min(4, v + 1))
    }
    if (field === "submit" && key.name === "space") {
      submit()
    }
  })
  const lbl = (id: Field, text: string) => (
    <box width={12} flexShrink={0}>
      <text fg={field === id ? theme.accent : theme.textMuted}>
        {field === id ? "▸ " : "  "}{text}
      </text>
    </box>
  )

  return (
    <box flexDirection="column" width={72}>
      <box height={1}><text fg={theme.primary}><strong>
        {`Generate ${props.kind} — ${props.state}`}
      </strong></text></box>
      <box height={1} />

      <box flexDirection="row">
        {lbl("prompt", "Prompt")}
        <box flexGrow={1} minWidth={0}>
          <textarea
            ref={ta}
            initialValue={prompt}
            keyBindings={BINDS}
            onSubmit={advance}
            onContentChange={() => { if (ta.current) setPrompt(ta.current.plainText) }}
            focused={field === "prompt"}
            placeholder={props.kind === "image" ? "describe the image…" : "describe the motion…"}
            textColor={theme.text}
            placeholderColor={theme.textMuted}
            backgroundColor={field === "prompt" ? theme.backgroundElement : undefined}
            focusedBackgroundColor={theme.backgroundElement}
            minHeight={4}
            maxHeight={6}
          />
        </box>
      </box>

      {props.seed ? (
        <box height={1} flexDirection="row" marginTop={1}>
          {lbl("seed", "Seed")}
          <box flexGrow={1} minWidth={0} height={1}>
            <text fg={field === "seed" ? theme.text : theme.textMuted}>
              {useSeed ? "● base.png" : "○ none"}
            </text>
          </box>
        </box>
      ) : null}

      {props.kind === "video" ? (
        <box height={1} flexDirection="row" marginTop={1}>
          {lbl("seconds", "Seconds")}
          <box width={20} height={1}>
            <slider orientation="horizontal" min={1} max={4} value={secs}
                    foregroundColor={field === "seconds" ? theme.accent : theme.textMuted}
                    backgroundColor={theme.border}
                    onChange={v => setSecs(Math.round(v))} />
          </box>
          <box width={6} height={1}>
            <text fg={field === "seconds" ? theme.text : theme.textMuted}>{`  ${secs}s`}</text>
          </box>
        </box>
      ) : null}

      <box marginTop={1} flexDirection="row">
        {lbl("submit", "")}
        <box flexGrow={1} minWidth={0}>
          {busy
            ? <box height={1}><Spinner color={theme.accent} label="generating…" /></box>
            : err
              ? <text fg={theme.warning} wrapMode="word">{err}</text>
              : <box height={1}>
                  <text fg={field === "submit" ? theme.accent : theme.textMuted}>
                    {"[Enter] generate"}
                  </text>
                </box>}
        </box>
      </box>

      <box height={1} marginTop={1}>
        <text fg={theme.textMuted}>
          {"Enter next  ·  Shift+Enter newline  ·  Tab field  ·  Esc cancel"}
        </text>
      </box>
    </box>
  )
}

export function openGenerate(
  dialog: DialogContext,
  run: GenerateFn,
  opts: Opts,
): Promise<{ path: string; prompt: string } | null> {
  return new Promise(resolve => {
    let token = 0
    dialog.replace(
      <Generate
        {...opts} run={run}
        onDone={(p, txt) => {
          resolve(p ? { path: p, prompt: txt } : null)
          if (dialog.version() === token) dialog.clear()
        }}
      />,
      () => resolve(null),
    )
    token = dialog.version()
  })
}
