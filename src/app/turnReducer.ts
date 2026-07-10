// Chat turn state — messages, streaming flags. Parts are appended in the
// order the gateway emits them (text → tool → text → …), so rendering can
// iterate `parts` chronologically without regrouping.

import type { Message, Part, TextPart, ToolPart, PromptPart, PromptReq, Usage } from "../types/message"
import { mid, pid } from "../types/message"
import type { SubagentPayload, TranscriptMessage } from "../context/wire"
import { sanitize } from "../utils/sanitize"

export type TurnState = {
  messages: Message[]
  streaming: boolean
  hasContent: boolean
  toolActive: boolean
}

export const initialTurn: TurnState = {
  messages: [],
  streaming: false,
  hasContent: false,
  toolActive: false,
}

export type Action =
  | { kind: "reset" }
  | { kind: "load"; messages: Message[] }
  | { kind: "load.live"; messages: Message[]; streaming: boolean }
  | { kind: "push"; message: Message }
  | { kind: "user"; text: string }
  | { kind: "system"; text: string }
  | { kind: "background"; id: string; title?: string; text: string }
  | { kind: "message.start" }
  | { kind: "message.delta"; chunk: string }
  | { kind: "message.complete"; text?: string; usage?: Usage }
  | { kind: "reference"; text: string }
  | { kind: "tool.start"; id: string; name: string; preview?: string; args?: string }
  | { kind: "tool.progress"; name?: string; preview?: string }
  | { kind: "tool.generating"; name?: string }
  | { kind: "tool.complete"; id: string; summary?: string; error?: string; inline_diff?: string; duration?: number; result?: string }
  | { kind: "thinking"; text: string; final: boolean; verbose?: boolean }
  | { kind: "subagent"; event: "start" | "thinking" | "tool" | "progress" | "complete"; payload: SubagentPayload }
  | { kind: "prompt"; id: string; req: PromptReq }
  | { kind: "prompt.answered"; id: string; label: string; ok: boolean }
  | { kind: "error"; text: string; fatal?: boolean }
  | { kind: "interrupt.notice"; text: string }

export function turnReducer(state: TurnState, a: Action): TurnState {
  switch (a.kind) {
    case "reset":
      return initialTurn

    case "load":
      return { ...initialTurn, messages: a.messages }

    case "load.live":
      return {
        ...initialTurn,
        messages: a.messages,
        streaming: a.streaming,
        hasContent: a.streaming && Boolean(joinText(a.messages.at(-1)?.parts ?? [])),
      }

    case "push":
      return { ...state, messages: [...state.messages, a.message] }

    case "user":
      return { ...state, messages: [...state.messages, userMessage(a.text)] }

    case "system":
      return { ...state, messages: [...state.messages, systemMessage(sanitize(a.text))] }

    case "background":
      return { ...state, messages: [...state.messages, backgroundMessage(a.id, a.title, a.text)] }

    case "message.start":
      return { ...state, streaming: true, hasContent: false, toolActive: false }

    case "message.delta": {
      const chunk = sanitize(a.chunk)
      if (!chunk) return state
      return {
        ...state,
        hasContent: true,
        toolActive: false,
        messages: appendText(state.messages, chunk),
      }
    }

    case "message.complete":
      return {
        ...state,
        streaming: false,
        hasContent: false,
        toolActive: false,
        messages: finalize(state.messages, a.text != null ? sanitize(a.text) : undefined, a.usage),
      }

    case "reference": {
      const text = sanitize(a.text)
      if (!text) return state
      return {
        ...state,
        hasContent: true,
        toolActive: false,
        messages: appendPart(state.messages, { type: "text", key: pid(), content: text, streaming: false }, true),
      }
    }

    case "tool.start": {
      // `context` carries the raw tool input; when JSON-shaped we keep it
      // as args so the UI can render KV lines on expand.
      const preview = sanitize(a.preview)
      const args = sanitize(a.args)
      const raw = args || preview
      const json = raw && /^\s*\{/.test(raw)
      const part: ToolPart = {
        type: "tool", id: a.id, name: a.name,
        args: json ? raw : "",
        status: "running", startedAt: Date.now(),
        preview: preview || undefined,
        verboseArgs: args || undefined,
      }
      return {
        ...state,
        toolActive: true,
        hasContent: false,
        messages: appendPart(state.messages, part, true),
      }
    }

    case "tool.progress":
      return {
        ...state,
        messages: updateRunningTool(state.messages, a.name, p => ({
          ...p, preview: sanitize(a.preview) || p.preview,
        })),
      }

    case "tool.generating":
      return {
        ...state,
        messages: updateRunningTool(state.messages, a.name, p => ({
          ...p, preview: p.preview ?? "generating…",
        })),
      }

    case "tool.complete": {
      const summary = sanitize(a.summary)
      const error = sanitize(a.error)
      const diff = sanitize(a.inline_diff)
      const result = sanitize(a.result)
      return {
        ...state,
        toolActive: false,
        messages: updateToolById(state.messages, a.id, p => ({
          ...p,
          status: (a.error ? "error" : "done") as ToolPart["status"],
          duration: a.duration ?? (p.startedAt ? Date.now() - p.startedAt : undefined),
          preview: summary || diff || p.preview,
          result: error || summary || undefined,
          verboseResult: result || undefined,
          diff: diff || undefined,
        })),
      }
    }

    case "thinking":
      return { ...state, messages: upsertThinking(state.messages, sanitize(a.text), a.final, a.verbose) }

    case "subagent":
      return { ...state, messages: renderSubagent(state.messages, a.event, a.payload) }

    case "prompt": {
      const part: PromptPart = {
        type: "prompt", id: a.id, variant: a.req.variant, req: a.req,
      }
      // Append to the in-progress assistant turn (prompts arrive
      // mid-stream, between tool calls). Seal any open text so the
      // prompt sits chronologically.
      return {
        ...state,
        messages: appendPart(state.messages, part, true),
      }
    }

    case "prompt.answered":
      return {
        ...state,
        messages: updatePrompt(state.messages, a.id, p => ({
          ...p, answered: { label: a.label, ok: a.ok, at: Date.now(), question: promptQuestion(p.req) },
        })),
      }

    case "error": {
      const msg = systemMessage(`Error: ${sanitize(a.text)}`)
      if (a.fatal === false) return { ...state, messages: [...state.messages, msg] }
      return {
        ...state,
        streaming: false,
        hasContent: false,
        toolActive: false,
        messages: [...state.messages, msg],
      }
    }

    case "interrupt.notice": {
      const clean = sanitize(a.text)
      const last = state.messages[state.messages.length - 1]
      const already = last?.role === "system"
        && last.parts[0]?.type === "text"
        && last.parts[0].content.includes(clean)
      if (already) return state
      return { ...state, messages: [...state.messages, systemMessage(clean)] }
    }
  }
}

function userMessage(text: string): Message {
  return {
    id: mid(), role: "user",
    parts: [{ type: "text", content: text, streaming: false }],
    timestamp: Date.now() / 1000,
  }
}

function systemMessage(text: string): Message {
  return {
    id: mid(), role: "system",
    parts: [{ type: "text", content: text, streaming: false }],
    timestamp: Date.now() / 1000,
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…"
}

function label(text: string | undefined, max: number): string {
  return clip(sanitize(text).replace(/\s+/g, " ").trim(), max)
}

function backgroundMessage(id: string, title: string | undefined, text: string): Message {
  const tid = label(id, 32) || "?"
  const name = label(title, 80)
  return {
    id: mid(), role: "assistant",
    speaker: `[bg ${tid}]${name ? ` ${name}` : ""}`,
    parts: [{ type: "text", content: sanitize(text), streaming: false }],
    timestamp: Date.now() / 1000,
  }
}

// Flatten a transcript row's `text` to a plain string for the reducer.
// Native-mode image routing stores user turns as an OpenAI content-parts
// list (`[{type:"text",text:…}, {type:"image_url",image_url:{url:…}}, …]`)
// instead of a plain string. ChafaImage needs a path, so a `data:` URL
// can't be reconstructed into a MEDIA: line — but we emit the `withMedia`
// prefix on the wire now (app.tsx:send), so the path sits inside the
// leading {type:"text"} fragment and survives.
function flatten(text: TranscriptMessage["text"]): string {
  if (typeof text === "string") return text
  if (!Array.isArray(text)) return ""
  const out: string[] = []
  for (const p of text) {
    if (p && typeof p === "object" && "type" in p && p.type === "text"
        && "text" in p && typeof p.text === "string") out.push(p.text)
  }
  return out.join("\n")
}

export function transcriptToMessages(rows: TranscriptMessage[]): Message[] {
  return rows
    .filter(r => r.role === "user" || r.role === "assistant")
    .map(r => ({ role: r.role, content: sanitize(flatten(r.text)) }))
    .filter(r => r.content)
    .map(r => ({
      id: mid(),
      role: r.role as "user" | "assistant",
      parts: [{ type: "text" as const, content: r.content, streaming: false }],
      timestamp: Date.now() / 1000,
    }))
}

function assistant(parts: Part[]): Message {
  return { id: mid(), role: "assistant", parts, timestamp: Date.now() / 1000 }
}

function withLastAssistant(
  messages: Message[],
  fn: (m: Message) => Message,
  otherwise: () => Message,
): Message[] {
  const last = messages[messages.length - 1]
  if (last?.role === "assistant") return [...messages.slice(0, -1), fn(last)]
  return [...messages, otherwise()]
}

/** Seal the trailing streaming text part so the next chunk starts fresh. */
function seal(parts: Part[]): Part[] {
  const last = parts[parts.length - 1]
  if (last?.type === "text" && last.streaming)
    return [...parts.slice(0, -1), { ...last, streaming: false }]
  return parts
}

/** Append a chunk to the trailing streaming text part, or open a new one. */
function appendText(messages: Message[], chunk: string): Message[] {
  return withLastAssistant(
    messages,
    m => {
      const last = m.parts[m.parts.length - 1]
      if (last?.type === "text" && last.streaming) {
        const part: TextPart = { ...last, content: last.content + chunk }
        return { ...m, parts: [...m.parts.slice(0, -1), part] }
      }
      return { ...m, parts: [...m.parts, { type: "text", key: pid(), content: chunk, streaming: true }] }
    },
    () => assistant([{ type: "text", key: pid(), content: chunk, streaming: true }]),
  )
}

/** Append a non-text part, optionally sealing any open text stream first. */
function appendPart(messages: Message[], part: Part, close: boolean): Message[] {
  return withLastAssistant(
    messages,
    m => ({ ...m, parts: [...(close ? seal(m.parts) : m.parts), part] }),
    () => assistant([part]),
  )
}

function finalize(messages: Message[], final?: string, usage?: Usage): Message[] {
  const last = messages[messages.length - 1]
  if (last?.role === "assistant") {
    const tail = last.parts[last.parts.length - 1]
    const dup = final && last.parts.some(p => p.type === "text" && sameText(p.content, final))
    const text = tail?.type === "text" && final && sameText(tail.content, final) ? tail.content : final
    const parts = tail?.type === "text" && tail.streaming
      ? [...last.parts.slice(0, -1), { ...tail, content: text || tail.content, streaming: false }]
      : final && !dup && !sameText(joinText(last.parts), final)
        ? [...last.parts, { type: "text" as const, content: final, streaming: false }]
        : seal(last.parts)
    return expirePrompts([...messages.slice(0, -1), { ...last, parts, usage }])
  }
  const next = final
    ? [...messages, { ...assistant([{ type: "text", content: final, streaming: false }]), usage }]
    : messages
  return expirePrompts(next)
}

function expirePrompts(messages: Message[]): Message[] {
  const at = Date.now()
  return messages.map(m => m.role === "assistant"
    ? {
      ...m,
      parts: m.parts.map(p => p.type === "prompt" && !p.answered
        ? { ...p, answered: { label: "Timed out", ok: false, at, question: promptQuestion(p.req) } }
        : p),
    }
    : m)
}

function joinText(parts: Part[]): string {
  return parts.filter(p => p.type === "text").map(p => p.content).join("")
}

function sameText(a: string, b: string): boolean {
  return a.trim() === b.trim()
}

function updateRunningTool(
  messages: Message[],
  name: string | undefined,
  fn: (p: ToolPart) => ToolPart,
): Message[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant") return messages
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const p = last.parts[i]
    if (p.type !== "tool" || p.status !== "running") continue
    if (name && p.name !== name) continue
    const parts = [...last.parts]
    parts[i] = fn(p)
    return [...messages.slice(0, -1), { ...last, parts }]
  }
  return messages
}

function updateToolById(messages: Message[], id: string, fn: (p: ToolPart) => ToolPart): Message[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant") return messages
  const parts = last.parts.map(p => p.type === "tool" && p.id === id ? fn(p) : p)
  return [...messages.slice(0, -1), { ...last, parts }]
}

/** Prompts can be answered after the assistant turn has moved on
 *  (user scrolled away, agent kept streaming). Search all messages,
 *  not just the tail. */
function updatePrompt(messages: Message[], id: string, fn: (p: PromptPart) => PromptPart): Message[] {
  return messages.map(m => {
    if (m.role !== "assistant") return m
    if (!m.parts.some(p => p.type === "prompt" && p.id === id)) return m
    return { ...m, parts: m.parts.map(p => p.type === "prompt" && p.id === id ? fn(p) : p) }
  })
}

function promptQuestion(req: PromptReq): string | undefined {
  if (req.variant === "clarify") return req.question
  if (req.variant === "approval") return req.description || "Shell command"
  if (req.variant === "sudo") return "Sudo required"
  return req.env_var ? `Secret: ${req.env_var}` : "Secret required"
}

function upsertThinking(messages: Message[], text: string, final: boolean, verbose?: boolean): Message[] {
  return withLastAssistant(
    messages,
    m => {
      const idx = m.parts.findIndex(p => p.type === "thinking")
      if (idx >= 0) {
        const prev = m.parts[idx] as Part & { type: "thinking"; content: string }
        // `final` (reasoning.available) is a fallback for providers
        // that don't stream deltas — keep the accumulated buffer if we
        // have one. Matches Ink turnController.recordReasoningAvailable.
        const content = final ? prev.content.trim() || text : prev.content + text
        const parts = [...m.parts]
        parts[idx] = { ...prev, content, streaming: !final, verbose: prev.verbose || verbose || undefined }
        return { ...m, parts }
      }
      return { ...m, parts: [{ type: "thinking" as const, key: pid(), content: text, streaming: !final, verbose }, ...m.parts] }
    },
    () => assistant([{ type: "thinking", key: pid(), content: text, streaming: !final, verbose }]),
  )
}

function renderSubagent(
  messages: Message[],
  event: "start" | "thinking" | "tool" | "progress" | "complete",
  p: SubagentPayload,
): Message[] {
  // Prefer the stable subagent_id threaded by delegate_tool; fall back
  // to task_index for older gateways. task_index alone collides when
  // orchestrator children spawn their own batch (same index, new depth).
  const id = p.subagent_id ? `sub-${p.subagent_id}` : `sub-${p.task_index}`

  if (event === "start") {
    const goal = sanitize(p.goal)
    const part: ToolPart = {
      type: "tool", id, name: "delegate_task", args: "",
      status: "running", startedAt: Date.now(),
      preview: goal || undefined, goal: goal || undefined,
      depth: p.depth ?? 0, trail: [],
    }
    return appendPart(messages, part, true)
  }

  if (event === "tool" && p.tool_name) {
    const tname = sanitize(p.tool_name)
    const tprev = sanitize(p.tool_preview)
    return updateToolById(messages, id, t => ({
      ...t,
      trail: [...(t.trail ?? []), { name: tname, preview: tprev || undefined }],
      preview: tprev ? `${tname}: ${tprev}` : tname,
    }))
  }

  if (event === "complete") {
    const tokens = (p.input_tokens ?? 0) + (p.output_tokens ?? 0)
    const extra = tokens ? ` · ${(tokens / 1000).toFixed(1)}k tok` : ""
    const summary = sanitize(p.summary)
    return updateToolById(messages, id, t => ({
      ...t,
      status: ((p.status === "failed" || p.status === "error" || p.status === "timeout" || p.status === "interrupted") ? "error" : "done") as ToolPart["status"],
      duration: p.duration_seconds ? p.duration_seconds * 1000 : (t.startedAt ? Date.now() - t.startedAt : undefined),
      result: summary ? summary + extra : undefined,
      preview: t.goal ?? t.preview,
    }))
  }

  // thinking / progress — surface transient text on the row.
  return updateToolById(messages, id, t => ({ ...t, preview: sanitize(p.text) || t.preview }))
}
