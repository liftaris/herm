// Maps a GatewayEvent to a turn-reducer Action plus fire-and-forget side effects.

import * as perf from "../utils/perf"
import * as spawnHistory from "../app/spawnHistory"
import { shouldRemember } from "./approval-memory"
import { showNotification, clearNotification } from "../app/notices"
import type { GatewayEvent, GatewaySkin, SessionInfo } from "../context/wire"
import type { Action } from "../app/turnReducer"
import { pid, type PromptReq, type Usage } from "../types/message"
import type { ToastContext } from "../ui/toast"

export type Side = {
  onReady?: () => void
  onSessionInfo?: (info: SessionInfo) => void
  onUsage?: (u: Usage) => void
  onTurnComplete?: () => void
  onBackground?: (task_id: string, text: string) => void
  onBtw?: (text: string) => void
  onStatus?: (text: string) => void
  onSessionTitle?: (sid?: string, title?: string) => void
  onSkin?: (skin: GatewaySkin | null | undefined) => void
  onApprovalRemembered?: (fallback: Extract<Action, { kind: "prompt" }>) => void
  /** voice.status event — gateway VAD loop state change (listening/transcribing/idle). */
  onVoiceStatus?: (state: string) => void
  /** voice.transcript event — transcribed text from a completed voice capture. */
  onVoiceTranscript?: (text: string, noSpeechLimit: boolean) => void
  notices?: ToastContext
}

function count(o: Record<string, string[]> | undefined): number {
  return o ? Object.values(o).reduce((n, v) => n + v.length, 0) : 0
}

function reference(label: string, text: string, index: number | undefined, count: number | undefined): string {
  const head = index && count ? `◇ Reference ${index}/${count} — ${label}` : `◇ Reference — ${label}`
  const body = text.trim()
  return body ? `${head}\n${body}` : head
}

function shape(v: unknown): string {
  if (v == null) return "none"
  if (Array.isArray(v)) return `array(${v.length})`
  if (typeof v !== "object") return typeof v
  const keys = Object.keys(v as Record<string, unknown>).slice(0, 8)
  return keys.length ? `object keys: ${keys.join(", ")}` : "object"
}

export function formatProcessNotification(text: string): string {
  const body = text.replace(/^\[IMPORTANT: /, "").replace(/\]$/, "")
  const done = body.match(/^Background process (\S+) completed \(exit code (\S+)\)\.\nCommand: (.+?)(?:\n|$)/)
  if (done) return `${done[1]} exited ${done[2]} · ${done[3]}`
  const hit = body.match(/^Background process (\S+) matched watch pattern "([^"]+)"\.\nCommand: (.+?)(?:\n|$)/)
  if (hit) return `${hit[1]} matched "${hit[2]}" · ${hit[3]}`
  return body.slice(0, 100)
}

export function mapEvent(ev: GatewayEvent, side: Side): Action | null {
  switch (ev.type) {
    case "gateway.ready":
      side.onReady?.()
      if (ev.payload?.skin) side.onSkin?.(ev.payload.skin)
      return null

    case "session.info": {
      const si = ev.payload
      side.onSessionInfo?.(si)
      const label = si.model
        ? `Connected — ${si.model} · ${count(si.tools)} tools · ${count(si.skills)} skills`
        : "Connected to Hermes"
      if (si.credential_warning) side.onStatus?.(si.credential_warning)
      return { kind: "system", text: label }
    }

    case "session.title":
      side.onSessionTitle?.(ev.payload.session_id, ev.payload.title)
      return null

    case "message.start":
      perf.count("stream:start")
      perf.mem("stream-start")
      return { kind: "message.start" }

    case "message.delta": {
      const chunk = ev.payload?.text ?? ""
      if (!chunk) return null
      perf.count("stream:chunk")
      return { kind: "message.delta", chunk }
    }

    case "message.interim": {
      const text = ev.payload?.text ?? ""
      if (!text && !ev.payload?.already_streamed) return null
      perf.count("stream:interim")
      return { kind: "message.interim", text: text || undefined, streamed: ev.payload?.already_streamed }
    }

    case "message.complete": {
      perf.count("stream:done")
      perf.mem("stream-done")
      const p = ev.payload
      if (p?.usage) side.onUsage?.(p.usage)
      side.onTurnComplete?.()
      // The gateway reports in-agent failures via status (exceptions come
      // as a separate `error` event). Without this branch a failed API
      // call ends the turn with no visible output.
      if (p?.status === "error")
        return { kind: "error", text: p.text || "request failed — see messages above" }
      if (p?.status === "interrupted")
        return { kind: "message.complete", text: (p.text || "") + "\n\n*[interrupted]*", usage: p?.usage, previewed: p?.response_previewed }
      return { kind: "message.complete", text: p?.text ?? undefined, usage: p?.usage, previewed: p?.response_previewed }
    }

    case "tool.start":
      return {
        kind: "tool.start",
        id: ev.payload.tool_id,
        name: ev.payload.name ?? "unknown",
        preview: ev.payload.context,
        args: ev.payload.args_text,
      }

    case "tool.progress":
      return { kind: "tool.progress", name: ev.payload.name, preview: ev.payload.preview }

    case "tool.generating":
      return { kind: "tool.generating", name: ev.payload.name }

    case "tool.complete":
      return {
        kind: "tool.complete",
        id: ev.payload.tool_id,
        summary: ev.payload.summary,
        error: ev.payload.error,
        inline_diff: ev.payload.inline_diff,
        duration: typeof ev.payload.duration_s === "number" ? ev.payload.duration_s * 1000 : undefined,
        result: ev.payload.result_text,
      }

    case "thinking.delta":
      // Cosmetic spinner text from the agent's status line, not model
      // reasoning. Surface as transient status only.
      side.onStatus?.(ev.payload?.text ?? "")
      return null

    case "reasoning.delta":
    case "reasoning.available": {
      const text = ev.payload?.text
      if (!text) return null
      return { kind: "thinking", text, final: ev.type === "reasoning.available", verbose: ev.payload?.verbose }
    }

    case "moa.reference":
      return {
        kind: "reference",
        text: reference(
          ev.payload?.label ?? "reference",
          ev.payload?.text ?? "",
          ev.payload?.index,
          ev.payload?.count,
        ),
      }

    case "moa.aggregating": {
      const agg = ev.payload?.aggregator
      side.onStatus?.(agg ? `aggregating with ${agg}…` : "aggregating…")
      return null
    }

    case "agent.terminal.output":
    case "billing.step_up.verification":
    case "moa.phase":
    case "moa.progress":
    case "pet.generate.progress":
    case "pet.hatch.progress":
    case "preview.restart.complete":
    case "preview.restart.progress":
    case "reaction":
    case "terminal.close":
    case "tool.output_risk":
    case "voice.interrupted":
      return null

    case "subagent.start":
    case "subagent.thinking":
    case "subagent.tool":
    case "subagent.progress":
    case "subagent.complete": {
      const sub = ev.type.slice(9) as "start" | "thinking" | "tool" | "progress" | "complete"
      // Feed the turn-wide accumulator so the completed tree can be
      // persisted (spawn_tree.save) and the Agents tab can read live
      // tool trails without its own event listener.
      spawnHistory.record(sub, ev.payload)
      return { kind: "subagent", event: sub, payload: ev.payload }
    }

    case "error":
      return { kind: "error", text: ev.payload?.message ?? "Unknown error" }

    case "clarify.request":
      return { kind: "prompt", id: ev.payload.request_id,
               req: { variant: "clarify", ...ev.payload } }

    case "approval.request": {
      const req: Extract<PromptReq, { variant: "approval" }> = { variant: "approval", ...ev.payload }
      const fallback: Extract<Action, { kind: "prompt" }> = {
        kind: "prompt",
        id: `approval-${pid()}`,
        req,
      }
      if (shouldRemember(req)) {
        side.onApprovalRemembered?.(fallback)
        return null
      }
      // Approval has no request_id upstream — the gateway's approval
      // responder is a single pending slot. Mint a unique part id so
      // multiple approvals in one turn don't alias each other when
      // prompt.answered updates by id.
      return fallback
    }

    case "sudo.request":
      return { kind: "prompt", id: ev.payload.request_id,
               req: { variant: "sudo", ...ev.payload } }

    case "secret.request":
      return { kind: "prompt", id: ev.payload.request_id,
               req: { variant: "secret", ...ev.payload } }

    case "terminal.read.request":
      return { kind: "prompt", id: ev.payload.request_id,
               req: { variant: "terminal-read", ...ev.payload } }

    case "background.complete":
      side.onBackground?.(ev.payload.task_id, ev.payload.text)
      return null

    case "review.summary": {
      // Self-improvement background review saved a skill patch or
      // memory entry. Upstream tui_gateway emits this so clients can
      // surface the mutation — without it, the file change happens
      // silently. Python side already formats the text with a 💾
      // prefix, so we pass through verbatim (trimmed). Guard blank
      // payloads: upstream does the same, and a blank system line is
      // noise. No toast — these fire stochastically post-turn and
      // per-event toasting would spam.
      const text = String(ev.payload?.text ?? "").trim()
      if (!text) return null
      return { kind: "system", text }
    }

    case "btw.complete":
      side.onBtw?.(ev.payload.text)
      return null

    case "gateway.stderr": {
      // Error-ish stderr lines (tracebacks, HTTP 4xx/5xx, auth failures)
      // surface inline; benign chatter stays in gw.tail() only (/logs).
      // The full untruncated line is always in gw.logs via GatewayClient.log();
      // stderr is a diagnostic side channel, not the turn lifecycle source
      // of truth, so it must not end an active stream.
      const line = ev.payload.line
      if (/error|fail|traceback|exception|\b[45]\d\d\b|refused|denied|unauthori/i.test(line))
        return { kind: "error", text: line, fatal: false }
      return null
    }

    case "skin.changed":
      side.onSkin?.(ev.payload)
      return null

    case "gateway.start_timeout":
      return { kind: "error", text: `gateway startup timed out (${ev.payload?.python ?? "python"} @ ${ev.payload?.cwd ?? "?"})` }

    case "gateway.protocol_error":
      return { kind: "system", text: `protocol error: ${ev.payload?.preview ?? "?"}` }

    case "browser.progress": {
      // Streamed during /browser connect (upstream e75082901). Surface as
      // transcript rows so long CDP attach work isn't a 60s black box.
      const text = ev.payload?.message ?? ""
      if (!text) return null
      return ev.payload?.level === "error"
        ? { kind: "error", text }
        : { kind: "system", text: `· ${text}` }
    }

    case "status.update": {
      const kind = ev.payload?.kind
      const text = ev.payload?.text ?? ""
      if (kind === "process") {
        side.onStatus?.(formatProcessNotification(text))
        return null
      }
      side.onStatus?.(text)
      // Generic "status" is cosmetic; lifecycle/error/warn carry real
      // signal (retries, fallbacks, auth failures) and must persist.
      if (!kind || kind === "status") return null
      return { kind: "system", text }
    }

    case "notification.show":
      if (side.notices) showNotification(side.notices, ev.payload)
      return null

    case "notification.clear":
      if (side.notices) clearNotification(side.notices, ev.payload)
      return null

    case "voice.status": {
      // Continuous VAD loop reports its internal state: listening,
      // transcribing, or idle. The UI uses this for the recording indicator.
      const state = String(ev.payload?.state ?? "")
      side.onVoiceStatus?.(state)
      return null
    }

    case "voice.transcript": {
      // Transcribed text from a completed voice capture.
      // no_speech_limit=true when 3 consecutive silent captures occurred
      // — in that case voice mode auto-disables (CLI parity).
      const noSpeechLimit = ev.payload?.no_speech_limit === true
      if (noSpeechLimit) {
        side.onVoiceTranscript?.("", true)
        return null
      }
      const text = String(ev.payload?.text ?? "").trim()
      if (!text) return null
      side.onVoiceTranscript?.(text, false)
      return null
    }
  }
  return null
}
