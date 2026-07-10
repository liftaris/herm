// Voice mode state hook for herm TUI.
// Manages runtime voice state: enabled/recording/processing flags,
// record key parsing from config, and actions (toggle, record start/stop).

import { useState, useCallback, useMemo, useRef } from "react"
import type { VoiceState, VoiceToggleResponse, VoiceRecordResponse } from "./types"
import { parseVoiceRecordKey, formatVoiceRecordKey } from "./platform"

/** Shape of the gateway client's `request` method — subset needed for voice. */
type GwRpc = <T>(method: string, params: Record<string, unknown>) => Promise<T>

export type VoiceApi = {
  state: VoiceState
  /** Toggle voice mode (on/off/tts/status) via gateway. */
  toggle: (action: string, sid: string) => Promise<void>
  /** Start or stop VAD-bounded recording via gateway. */
  record: (sid: string) => Promise<void>
  /** Set voice enabled from event (e.g. no_speech_limit auto-off). */
  setEnabled: (v: boolean) => void
  /** Set recording state from voice.status event. */
  setRecording: (v: boolean) => void
  /** Set processing state from voice.status event. */
  setProcessing: (v: boolean) => void
  /** Update record key from config (called after voice.toggle response). */
  setRecordKey: (raw: string | undefined) => void
  /** Reset runtime-only state after the gateway process is replaced. */
  reset: () => void
  /** Formatted display string for the record key (e.g. "Ctrl+B"). */
  keyLabel: string
  /** Callback for voice transcript — inserts text into composer. */
  onTranscript: ((text: string) => void) | null
  setOnTranscript: (fn: ((text: string) => void) | null) => void
}

export function useVoice(gw: GwRpc, sys: (text: string) => void): VoiceApi {
  const [enabled, setEnabled] = useState(false)
  const [recording, setRecording] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [recordKeyRaw, setRecordKeyRaw] = useState<string>()
  const [tts, setTts] = useState(false)
  const [onTranscript, setTranscript] = useState<((text: string) => void) | null>(null)
  const pending = useRef(0)
  const recordGen = useRef(0)
  const toggleGen = useRef(0)
  const setOnTranscript = useCallback((fn: ((text: string) => void) | null) =>
    setTranscript(fn ? () => fn : null), [])
  const reset = useCallback(() => {
    toggleGen.current++
    recordGen.current++
    pending.current = 0
    setEnabled(false)
    setRecording(false)
    setProcessing(false)
    setTts(false)
  }, [])

  const recordKey = useMemo(
    () => parseVoiceRecordKey(recordKeyRaw),
    [recordKeyRaw],
  )

  const keyLabel = useMemo(
    () => formatVoiceRecordKey(recordKey),
    [recordKey],
  )

  const state: VoiceState = useMemo(() => ({
    enabled, recording, processing, recordKey, tts,
  }), [enabled, recording, processing, recordKey, tts])

  const toggle = useCallback(async (action: string, sid: string) => {
    const current = ++toggleGen.current
    try {
      const r = await gw<VoiceToggleResponse>("voice.toggle", {
        action,
        session_id: sid,
      })
      if (toggleGen.current !== current) return
      if (r.enabled !== undefined) {
        setEnabled(r.enabled)
        if (!r.enabled) {
          recordGen.current++
          setRecording(false)
          setProcessing(false)
        }
      }
      if (r.tts !== undefined) setTts(r.tts)
      if (r.record_key) setRecordKeyRaw(r.record_key)
      const label = formatVoiceRecordKey(parseVoiceRecordKey(r.record_key))
      const ttsMsg = r.tts ? " · tts on" : ""
      const details = action === "status" && r.details?.trim() ? ` · ${r.details.trim()}` : ""
      sys(`voice ${r.enabled ? "on" : "off"}${ttsMsg} [${label}]${details}`)
    } catch (e) {
      if (toggleGen.current !== current) return
      sys(`voice: ${e instanceof Error ? e.message : "gateway error"}`)
    }
  }, [gw, sys])

  const record = useCallback(async (sid: string) => {
    if (!enabled) {
      sys("voice: mode is off — enable with /voice on")
      return
    }
    if (pending.current) return
    const current = ++recordGen.current
    pending.current = current
    const starting = !recording
    const action = starting ? "start" : "stop"
    // Optimistic UI update
    if (starting) {
      setRecording(true)
    } else {
      setRecording(false)
      setProcessing(false)
    }
    try {
      const r = await gw<VoiceRecordResponse>("voice.record", {
        action,
        session_id: sid,
      })
      if (recordGen.current !== current) return
      // Reconcile on failure
      if (starting && r.status !== "recording") {
        setRecording(false)
        if (r.status === "busy") {
          setProcessing(true)
          sys("voice: still transcribing; try again shortly")
        }
      }
    } catch (e) {
      if (recordGen.current !== current) return
      setRecording(!starting)
      sys(`voice error: ${e instanceof Error ? e.message : "gateway error"}`)
    } finally {
      if (pending.current === current) pending.current = 0
    }
  }, [enabled, recording, gw, sys])

  return {
    state, toggle, record,
    setEnabled, setRecording, setProcessing,
    setRecordKey: setRecordKeyRaw,
    reset,
    keyLabel,
    onTranscript, setOnTranscript,
  }
}
