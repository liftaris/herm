// Gateway event stream → turn reducer. Owns delta batching, the
// client-side interrupt latch, and the Side-effect hooks mapEvent
// calls out to. Pulled from AppInner so the shell only wires setters.

import type React from "react"
import { useCallback, useEffect, useRef, type RefObject } from "react"
import * as spawnHistory from "./spawnHistory"
import * as preferences from "../context/preferences"
import { useGateway, useGatewayEvent } from "../context/gateway"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { openAlert } from "../dialogs/alert"
import { mapEvent } from "../context/events"
import { deriveSkin, type SkinState } from "../context/skin"
import { home } from "../home"
import { useBackground } from "./background"
import type { Action } from "./turnReducer"
import type { useSession } from "./useSession"
import type { GatewayEvent, SessionInfo } from "../context/wire"
import type { Usage } from "../types/message"
import type { Launch } from "./launch"

type Ctx = {
  dispatch: React.Dispatch<Action>
  session: ReturnType<typeof useSession>
  launchRef: RefObject<Launch>
  sidRef: RefObject<string>
  sessionStart: RefObject<number>
  goalHook: { check: (sid: string) => void }

  setSid: (id: string) => void
  setDurable: (id: string) => void
  setInfo: (i: SessionInfo) => void
  setReady: (r: boolean) => void
  setTitle: (t: string) => void
  setBusy: (m: "queue" | "steer" | "interrupt") => void
  setStarting: (v: boolean) => void
  setUsage: (u: Usage | undefined) => void
  setStatus: (s: string) => void
  setSkin: (s: SkinState) => void
  setSplash: (v: boolean) => void
  setErrorPulse: (v: boolean) => void
  onVoiceStatus: (state: string) => void
  onVoiceTranscript: (text: string, noSpeechLimit: boolean) => void
  settle: () => void
  start: () => void
}

// Events that mutate the in-progress assistant turn. Everything else
// (system messages, session.info, toasts, completion, side channels)
// is orthogonal to the stream and passes the interrupt gate.
const STREAM_EVENTS = new Set<GatewayEvent["type"]>([
  "message.start",
  "message.delta", "message.interim", "reasoning.delta", "reasoning.available", "thinking.delta",
  "moa.reference", "moa.aggregating",
  "tool.start", "tool.progress", "tool.generating",
])
const TITLE_DELAYS = [1200, 5000, 15000, 30000] as const

export function useStream(c: Ctx) {
  const gw = useGateway()
  const dialog = useDialog()
  const toast = useToast()
  const bg = useBackground()
  const ctx = useRef(c); ctx.current = c
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }, [])

  // Client-side interrupt latch: flipped on Esc×2 before the gateway
  // has confirmed the stop. Stream-mutation events still in the stdio
  // pipe (already written by the agent thread before it saw the
  // interrupt flag) are dropped until the NEXT user send — not
  // message.complete — because run_agent's worker thread can keep
  // emitting after the monitor thread's InterruptedError has already
  // ended the turn.
  const interrupted = useRef(false)
  const info = useRef(false)

  // Delta batching: streamed text/reasoning chunks accumulate in a
  // ref and flush at most once per 16ms. Every delta otherwise
  // triggers an O(messages) array spread + O(content) string concat +
  // full markdown re-parse of the streaming block. Any non-delta
  // action flushes synchronously first so part ordering is preserved.
  const deltas = useRef({ text: "", think: "", timer: null as ReturnType<typeof setTimeout> | null })

  const store = useCallback((key?: string, id?: string) => {
    const sid = key ?? id
    if (!sid) return
    ctx.current.setDurable(sid)
    ctx.current.launchRef.current = { mode: "resume", sid, splash: false }
    preferences.set("lastSessionId", sid)
  }, [])

  const flush = useCallback(() => {
    const d = deltas.current
    if (d.timer) { clearTimeout(d.timer); d.timer = null }
    if (d.think) { ctx.current.dispatch({ kind: "thinking", text: d.think, final: false }); d.think = "" }
    if (d.text) { ctx.current.dispatch({ kind: "message.delta", chunk: d.text }); d.text = "" }
  }, [])

  const sync = useCallback((ms = 0) => {
    const sid = ctx.current.sidRef.current
    if (!sid) return
    const run = () => gw.request<{ title?: string; session_key?: string }>("session.title", { session_id: sid })
      .then(r => {
        if (ctx.current.sidRef.current !== sid) return
        ctx.current.setTitle(r.title ?? "")
        store(r.session_key)
      })
      .catch(() => {})
    if (ms <= 0) return run()
    const id = setTimeout(() => {
      timers.current = timers.current.filter(t => t !== id)
      run()
    }, ms)
    timers.current.push(id)
  }, [gw])

  const retitle = useCallback((sid?: string, title?: string) => {
    if (!sid || title === undefined) return
    if (sid === ctx.current.sidRef.current) ctx.current.setTitle(title)
    home.update("recentSessions", rows => rows.map(r => r.id === sid ? { ...r, title } : r))
  }, [])

  const handle = useCallback((ev: GatewayEvent) => {
    const x = ctx.current
    if (ev.type === "gateway.ready") info.current = false
    if (ev.type === "message.start") x.start()
    if (ev.type === "background.complete" && ev.session_id && x.sidRef.current
        && ev.session_id !== x.sidRef.current) {
      bg.unregister(ev.payload.task_id)
      return
    }
    const shared = ev.type === "background.complete" && !ev.session_id
    if (ev.session_id && x.sidRef.current && ev.session_id !== x.sidRef.current && !ev.type.startsWith("gateway.") && !shared) return
    // The agent's stream-retry loop (run_agent._call) classifies the
    // force-closed httpx socket from an interrupt as a transient drop
    // and emits "Reconnecting…" lifecycle status before the top-of-loop
    // interrupt guard catches it. Drain those (and any ghost stream
    // events from the clear_interrupt race) until the next user send.
    if (interrupted.current) {
      if (STREAM_EVENTS.has(ev.type)) return
      if (ev.type === "status.update" && ev.payload?.kind === "lifecycle") return
    }
    const action = mapEvent(ev, {
      onReady: () => {
        x.session.boot(x.launchRef.current).then((r) => {
          x.setSid(r.id)
          store(r.key, r.id)
          if (r.info) { x.setInfo(r.info); x.setUsage(r.info.usage) }
          x.sessionStart.current = Date.now()
          if (r.messages.length) x.dispatch({ kind: "load", messages: r.messages })
          if (r.note) toast.show({ variant: "info", message: r.note })
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          gw.setSession("")
          x.setSid("")
          x.setReady(false)
          x.setStarting(false)
          x.setSplash(false)
          x.setStatus(`session boot failed: ${msg}`)
          x.setErrorPulse(true)
          x.dispatch({ kind: "system", text: `Failed to start session: ${msg}` })
        })
      },
      onSessionInfo: (si) => {
        x.setInfo(si)
        if (si.usage) x.setUsage(si.usage)
        x.setReady(true)
        if (si.running === false) {
          x.start()
          x.setStarting(false)
          x.setStatus("")
        }
        if (si.session_id) x.setSid(si.session_id)
        if (si.stored_session_id) store(si.stored_session_id, si.session_id ?? ev.session_id)
        x.settle()
        // Use title from session.info directly — avoids a redundant
        // session.title RPC that would re-emit session.info and create
        // a feedback loop (config.get ↔ session.title ↔ session.info).
        if (si.title !== undefined) x.setTitle(si.title)
        const bad = (si.mcp_servers ?? []).filter(s => !s.connected)
        if (bad.length) x.dispatch({
          kind: "system",
          text: `MCP: ${bad.length} server(s) failed to connect — ${bad.map(s => s.name + (s.error ? ` (${s.error})` : "")).join(", ")}`,
        })
        gw.request<{ value?: string }>("config.get", { key: "busy" }).then(r => {
          const m = r.value
          if (m === "queue" || m === "steer" || m === "interrupt") x.setBusy(m)
        }).catch(() => {})
      },
      onUsage: (u) => x.setUsage(u),
      onTurnComplete: () => {
        x.setStarting(false)
        x.setStatus("")
        spawnHistory.flush(gw, x.sidRef.current)
        x.goalHook.check(x.sidRef.current)
        TITLE_DELAYS.forEach(sync)
      },
      onBackground: (tid, text) => {
        const title = bg.label(tid)
        bg.unregister(tid)
        x.dispatch({ kind: "background", id: tid, title, text })
      },
      onBtw: (text) => {
        const head = text.split("\n")[0].slice(0, 80)
        x.dispatch({ kind: "system", text: `◈ btw — ${head}` })
        toast.show({
          variant: "info", title: "btw", message: head, duration: 8000,
          action: { label: "view", run: () => openAlert(dialog, "btw", text) },
        })
      },
      onStatus: (text) => x.setStatus(text),
      onSessionTitle: retitle,
      onApprovalRemembered: (fallback) => {
        const sid = x.sidRef.current
        void gw.request("approval.respond", { choice: "always" }).catch((err: Error) => {
          if (ctx.current.sidRef.current !== sid) return
          x.dispatch(fallback)
          toast.show({ variant: "error", message: err.message })
        })
      },
      onSkin: (s) => x.setSkin(deriveSkin(s)),
      onVoiceStatus: x.onVoiceStatus,
      onVoiceTranscript: x.onVoiceTranscript,
      notices: toast,
    })
    if (!action) return
    if (ev.type === "session.info") {
      if (info.current) return
      info.current = true
    }
    const d = deltas.current
    if (action.kind === "message.delta") {
      if (d.think) flush()
      d.text += action.chunk
      d.timer ??= setTimeout(flush, 16)
      return
    }
    if (action.kind === "thinking" && !action.final) {
      if (d.text) flush()
      d.think += action.text
      d.timer ??= setTimeout(flush, 16)
      return
    }
    flush()
    if (action.kind === "message.start") {
      x.setStarting(false)
      x.setStatus("")
    }
    if (action.kind === "error") x.setStarting(false)
    if (action.kind === "error") x.setErrorPulse(true)
    x.dispatch(action)
  }, [gw, dialog, toast, flush, bg, retitle])

  useGatewayEvent(handle)

  const doInterrupt = useCallback(() => {
    interrupted.current = true
    // Drop any 16ms-batched deltas that haven't hit the reducer yet —
    // flushing them would append post-interrupt text.
    const d = deltas.current
    if (d.timer) { clearTimeout(d.timer); d.timer = null }
    d.text = ""; d.think = ""
    void ctx.current.session.interrupt().catch((err: Error) => {
      interrupted.current = false
      toast.show({ variant: "error", message: err.message })
    })
  }, [toast])

  return { interrupted, doInterrupt }
}
