// Inline agent prompts — approval / clarify / sudo / secret.
//
// These render *in the transcript* as a Part of the in-progress
// assistant message, not in a modal. The composer stays focused for
// approval/clarify; the shell's global key handler routes keys to
// the pending card via the imperative handle so number/arrow/Enter
// work without the textarea eating them. Sudo/secret own a masked
// <input> and take focus explicitly (the value must never echo into
// the composer).
//
// Responding is exactly-once per card but NOT unmount-triggered — the
// card can scroll out of the viewport (culling) without auto-denying.
// Esc is the only cancel path.

import {
  memo, useRef, useState, useEffect, forwardRef, useImperativeHandle,
} from "react"
import { LEFT_BAR } from "../../ui/borders"
import type { ParsedKey } from "@opentui/core"
import { useTheme } from "../../theme"
import { useGateway } from "../../context/gateway"
import { mkApproval, remember } from "../../context/approval-memory"
import { MaskInput } from "../../ui/mask-input"
import type { PromptPart, PromptReq, Part } from "../../types/message"

export type PromptCardHandle = {
  /** Offer a key to the pending card. Returns true if consumed. */
  feed: (key: ParsedKey) => boolean
  /** True if this card owns a focused <input> (sudo/secret). */
  masked: boolean
}

type Answer = (label: string, ok: boolean) => void

function digit(name: string): number | null {
  const n = parseInt(name, 10)
  return Number.isFinite(n) ? n : null
}

// ┃-bar panel frame — matches the oc permission grammar that prompts
// already used inside the modal, minus the fixed width.
const Frame = (p: { tint: import("@opentui/core").RGBA; children: React.ReactNode }) => {
  const theme = useTheme().theme
  return (
    <box
      flexDirection="column"
      border={["left"]}
      borderColor={p.tint}
      customBorderChars={LEFT_BAR}
      backgroundColor={theme.backgroundPanel}
      marginBottom={1}
    >
      {p.children}
    </box>
  )
}

const Pill = (p: { on: boolean; hot: string; label: string; onPick: () => void }) => {
  const theme = useTheme().theme
  return (
    <box height={1} paddingX={1}
         backgroundColor={p.on ? theme.primary : undefined}
         onMouseDown={p.onPick}>
      <text>
        <span fg={p.on ? theme.background : theme.textMuted}>{p.hot} </span>
        <span fg={p.on ? theme.background : theme.text}>{p.label}</span>
      </text>
    </box>
  )
}

const CHOICES = ["once", "session", "never", "deny"] as const
type Choice = typeof CHOICES[number]
const LABELS: Record<Choice, string> = {
  once: "Allow once",
  session: "Allow this session",
  never: "Never ask",
  deny: "Deny",
}
const RESPOND: Record<Choice, string> = {
  once: "once",
  session: "session",
  never: "always",
  deny: "deny",
}

const Approval = forwardRef<PromptCardHandle, {
  req: Extract<PromptReq, { variant: "approval" }>
  onAnswer: Answer
}>((p, ref) => {
  const theme = useTheme().theme
  const gw = useGateway()
  const [sel, setSel] = useState(0)
  const [steering, setSteering] = useState(false)
  const [custom, setCustom] = useState("")
  const [note, setNote] = useState("")
  const done = useRef(false)

  useEffect(() => {
    void gw.request("approval.received", { request_id: p.req.request_id, session_id: p.req.session_id })
      .catch((e: Error) => setNote(e.message))
  }, [gw, p.req.request_id, p.req.session_id])

  const prompt = mkApproval(p.req)
  const choices = CHOICES.filter(c => (!p.req.choices?.length || p.req.choices.includes(RESPOND[c]))
    && (c !== "never" || p.req.allow_permanent !== false) && (c !== "session" || p.req.allow_session !== false))

  const send = (c: Choice) => {
    if (done.current) return
    done.current = true
    setNote("")
    void gw.answer(p.req.id, { choice: RESPOND[c] })
      .then(() => {
        if (c === "never") remember(prompt)
        p.onAnswer(LABELS[c], c !== "deny")
      })
      .catch((e: Error) => {
        done.current = false
        setNote(e.message)
      })
  }

  const steer = (text: string) => {
    const body = text.trim()
    if (!body) { setSteering(false); return }
    setCustom("")
    setSteering(false)
    setNote("steer sent, approval still pending")
    void gw.request("session.steer", { text: body }).catch((e: Error) => setNote(e.message))
  }

  useImperativeHandle(ref, () => ({
    masked: steering,
    feed: (key) => {
      if (steering) {
        if (key.name === "escape") { setSteering(false); return true }
        return false
      }
      if (key.name === "s") { setSteering(true); setNote(""); return true }
      if (key.name === "left" || key.name === "h") {
        setSel(s => (s + choices.length - 1) % choices.length); return true
      }
      if (key.name === "right" || key.name === "l") {
        setSel(s => (s + 1) % choices.length); return true
      }
      if (key.name === "return") { send(choices[sel]); return true }
      if (key.name === "escape") { send("deny"); return true }
      const n = digit(key.name)
      if (n !== null && n >= 1 && n <= choices.length) { send(choices[n - 1]); return true }
      return false
    },
  }), [sel, steering])

  return (
    <Frame tint={theme.warning}>
      <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={2} paddingY={1}>
        <box flexDirection="row" gap={1} height={1}>
          <text fg={theme.warning}>△</text>
          <text fg={theme.text}>Permission required</text>
          <text fg={theme.textMuted}>· {prompt.question}</text>
        </box>
        <box flexDirection="row" gap={1} paddingLeft={2} minHeight={1}>
          <text fg={theme.textMuted}>#</text>
          <text fg={theme.text} wrapMode="word">{p.req.description || "Shell command"}</text>
        </box>
        <box paddingLeft={2} minHeight={1}>
          <text fg={theme.text} wrapMode="word">$ {p.req.command}</text>
        </box>
        {p.req.pattern_keys?.length ? (
          <box paddingLeft={2} minHeight={1}>
            <text fg={theme.textMuted} wrapMode="word">
              matched: {p.req.pattern_keys.join(", ")}
            </text>
          </box>
        ) : null}
      </box>
      {steering ? (
        <box flexDirection="column" gap={1} flexShrink={0}
             paddingX={2} paddingY={1} backgroundColor={theme.backgroundElement}>
          <box flexDirection="row" height={1}>
            <text fg={theme.textMuted}>{"> "}</text>
            <input
              value={custom} onInput={setCustom}
              onSubmit={() => steer(custom)}
              focused flexGrow={1}
              textColor={theme.text}
              backgroundColor={theme.backgroundElement}
              focusedBackgroundColor={theme.backgroundElement}
            />
          </box>
          <text fg={theme.textMuted}>Enter steer · Esc back to approval</text>
        </box>
      ) : (
        <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0}
             paddingX={2} paddingY={1} backgroundColor={theme.backgroundElement}>
          {choices.map((c, i) => (
            <Pill key={c} on={sel === i} hot={String(i + 1)} label={LABELS[c]}
                  onPick={() => send(c)} />
          ))}
          <Pill on={false} hot="s" label="Steer" onPick={() => { setSteering(true); setNote("") }} />
          <box height={1}>
            <text fg={theme.textMuted}>subject: {prompt.subject}</text>
          </box>
          <box flexGrow={1} />
          <box height={1}>
            <text fg={theme.textMuted}>←/→ · enter · s steer · esc deny</text>
          </box>
        </box>
      )}
      {note ? (
        <box paddingLeft={2} paddingBottom={1} backgroundColor={theme.backgroundElement}>
          <text fg={theme.textMuted}>{note}</text>
        </box>
      ) : null}
    </Frame>
  )
})

const Clarify = forwardRef<PromptCardHandle, {
  req: Extract<PromptReq, { variant: "clarify" }>
  onAnswer: Answer
}>((p, ref) => {
  const theme = useTheme().theme
  const gw = useGateway()
  const [answers, setAnswers] = useState<Record<string, string | null>>(p.req.answers ?? {})
  const remaining = p.req.questions.filter(q => !(q.qid in answers))
  const q = remaining[0] ?? p.req.questions[p.req.questions.length - 1]
  const choices = q.choices ?? []
  const [sel, setSel] = useState(0)
  const [typing, setTyping] = useState(choices.length === 0)
  const [custom, setCustom] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [err, setErr] = useState("")
  const done = useRef(false)

  const finish = (next: Record<string, string | null>, outcome: "submitted" | "cancelled") => {
    if (done.current) return
    done.current = true
    setErr("")
    void gw.answer(p.req.id, { answers: next, outcome })
      .then(() => p.onAnswer(Object.values(next).map(v => v ?? "(skipped)").join("; "), Object.values(next).some(v => v !== null)))
      .catch((e: Error) => { done.current = false; setErr(e.message) })
  }

  const send = (answer: string | null) => {
    if (done.current) return
    const next = { ...answers, [q.qid]: answer?.trim() ? answer : null }
    const following = p.req.questions.find(q => !(q.qid in next))
    if (!following) { finish(next, "submitted"); return }
    done.current = true
    setErr("")
    void gw.request<{ status: string }>("clarify.lock", { request_id: p.req.id, question_id: q.qid, answer: next[q.qid] })
      .then(r => {
        if (r.status === "expired") throw new Error(`request no longer open: ${p.req.id}`)
        setAnswers(next)
        setSel(0)
        setSelected([])
        setCustom("")
        setTyping(!following.choices?.length)
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => { done.current = false })
  }

  const cancel = () => finish(Object.fromEntries(p.req.questions.map(q => [q.qid, answers[q.qid] ?? null])), "cancelled")

  const pick = (i: number) => {
    if (i === choices.length + 1) { send(null); return }
    if (i === choices.length) { setTyping(true); return }
    if (!q.multi_select) { send(choices[i]); return }
    setSelected(values => values.includes(choices[i]) ? values.filter(v => v !== choices[i]) : [...values, choices[i]])
  }

  useImperativeHandle(ref, () => ({
    masked: typing,
    feed: key => {
      if (key.name === "escape") {
        if (typing && choices.length) { setTyping(false); return true }
        cancel(); return true
      }
      if (typing) return false
      if (key.name === "up") { setSel(s => Math.max(0, s - 1)); return true }
      if (key.name === "down") { setSel(s => Math.min(choices.length + 1, s + 1)); return true }
      if (key.name === "return") {
        if (sel >= choices.length) pick(sel)
        else if (q.multi_select && selected.length) send(selected.join(", "))
        else pick(sel)
        return true
      }
      if (key.name === "space" && q.multi_select) { pick(sel); return true }
      const n = digit(key.name)
      if (n !== null && n >= 1 && n <= choices.length) { pick(n - 1); return true }
      return false
    },
  }))

  return (
    <Frame tint={theme.accent}>
      <box flexDirection="column" paddingLeft={1} paddingRight={2} paddingY={1}>
        <text fg={theme.accent} wrapMode="word"><strong>{q.question}</strong></text>
        <text fg={theme.textMuted}>{p.req.questions.length - remaining.length + 1}/{p.req.questions.length}</text>
        {typing ? (
          <input value={custom} onInput={setCustom} onSubmit={() => send(custom)} focused
            textColor={theme.text} backgroundColor={theme.backgroundElement} focusedBackgroundColor={theme.backgroundElement} />
        ) : (
          <box flexDirection="column">
            {[...choices, "Other (type your answer)", "Skip question"].map((c, i) => (
              <box key={c} minHeight={1} onMouseDown={() => pick(i)}>
                <text fg={sel === i ? theme.text : theme.textMuted} wrapMode="word">
                  {sel === i ? "▸ " : "  "}{i + 1}. {selected.includes(c) ? "[x] " : ""}{c}
                </text>
              </box>
            ))}
            {q.multi_select ? <box minHeight={1} onMouseDown={() => send(selected.join(", "))}><text fg={theme.accent}>Submit selections</text></box> : null}
          </box>
        )}
        <box flexDirection="row" flexWrap="wrap" gap={1}>
          {typing ? <Pill on={false} hot="Enter" label="Submit" onPick={() => send(custom)} /> : null}
          <Pill on={false} hot="" label="Skip question" onPick={() => send(null)} />
          <Pill on={false} hot="Esc" label="Cancel" onPick={cancel} />
        </box>
        {q.multi_select ? <text fg={theme.textMuted}>Space/number toggle · Enter submit selections</text> : null}
        {err ? <text fg={theme.error}>{err}</text> : null}
      </box>
    </Frame>
  )
})

const Masked = forwardRef<PromptCardHandle, {
  title: string
  note: string
  onSubmit: (v: string) => Promise<unknown>
  onAnswer: Answer
}>((p, ref) => {
  const theme = useTheme().theme
  const [value, setValue] = useState("")
  const [err, setErr] = useState("")
  const done = useRef(false)

  const go = (v: string) => {
    if (done.current) return
    done.current = true
    setErr("")
    void p.onSubmit(v)
      .then(() => p.onAnswer(v ? "(provided)" : "(cancelled)", v !== ""))
      .catch((e: Error) => {
        done.current = false
        setErr(e.message)
      })
  }

  useImperativeHandle(ref, () => ({
    masked: true,
    feed: (key) => {
      if (key.name === "escape") { go(""); return true }
      return false
    },
  }), [])

  return (
    <Frame tint={theme.warning}>
      <box flexDirection="column" paddingLeft={1} paddingRight={2} paddingY={1}>
        <text fg={theme.warning}><strong>{p.title}</strong></text>
        <text fg={theme.text}>{p.note}</text>
        <box height={1} />
        <MaskInput value={value} input={setValue} submit={() => go(value)} />
        {err ? <text fg={theme.error}>{err}</text> : null}
        <box flexDirection="row" gap={1}>
          <Pill on={false} hot="Enter" label="Submit" onPick={() => go(value)} />
          <Pill on={false} hot="Esc" label="Cancel" onPick={() => go("")} />
        </box>
      </box>
    </Frame>
  )
})

function same(a: string | undefined, b: string): boolean {
  return Boolean(a && b && b.toLowerCase().includes(a.toLowerCase()))
}

function cap(s: string, n = 160): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…"
}

function question(part: PromptPart): string {
  const a = part.answered?.question
  if (a) return a
  if (part.req.variant === "clarify") return part.req.questions.map(q => q.question).join("; ")
  if (part.req.variant === "approval") return mkApproval(part.req).question
  if (part.req.variant === "sudo") return "Sudo required"
  return part.req.env_var ? `Secret: ${part.req.env_var}` : "Secret required"
}

function outcome(part: PromptPart): { head: string; body?: string } {
  const a = part.answered!
  if (part.variant === "clarify") {
    const q = cap(question(part))
    const body = cap(a.label)
    return same(q, a.label) ? { head: body } : { head: q, body }
  }
  if (part.variant === "approval") {
    const q = cap(question(part), 96)
    return { head: a.label, body: q }
  }
  if (part.variant === "sudo") return { head: `sudo ${a.label}` }
  const req = part.req as Extract<PromptReq, { variant: "secret" }>
  return { head: `${req.env_var ?? "secret"} ${a.label}` }
}

const Outcome = memo(({ part }: { part: PromptPart }) => {
  const theme = useTheme().theme
  const a = part.answered!
  const glyph = a.ok ? "✓" : "✗"
  const fg = a.ok ? theme.success : theme.error
  const text = outcome(part)
  return (
    <box flexDirection="row" paddingLeft={3} marginBottom={1}>
      <box width={2} flexShrink={0}>
        <text fg={fg}>{glyph}</text>
      </box>
      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        <text fg={theme.textMuted} wrapMode="word">{text.head}</text>
        {text.body ? <text fg={theme.textMuted} wrapMode="word">{text.body}</text> : null}
      </box>
    </box>
  )
})

export const PromptCard = memo(forwardRef<PromptCardHandle, {
  part: PromptPart
  onAnswer: (id: string, label: string, ok: boolean) => void
}>((p, ref) => {
  const gw = useGateway()
  if (p.part.answered) return <Outcome part={p.part} />
  const answer: Answer = (label, ok) => p.onAnswer(p.part.id, label, ok)
  const req = p.part.req
  if (req.variant === "approval")
    return <Approval ref={ref} req={req} onAnswer={answer} />
  if (req.variant === "clarify")
    return <Clarify ref={ref} req={req} onAnswer={answer} />
  if (req.variant === "sudo")
    return <Masked ref={ref} title="🔒 Sudo required"
                   note="Enter your password to elevate privileges."
                   onSubmit={v => gw.answer(req.id, { value: v })}
                   onAnswer={answer} />
  return <Masked ref={ref} title={`🔑 Secret: ${req.env_var}`}
                 note={req.prompt}
                 onSubmit={v => gw.answer(req.id, { value: v })}
                 onAnswer={answer} />
}))

/** Find the single pending prompt across all messages. The gateway
 *  blocks on the answer, so there's at most one. */
export function pending(messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<Part> }>): PromptPart | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const part = m.parts[j]
      if (part.type === "prompt" && !part.answered) return part
    }
  }
  return null
}
