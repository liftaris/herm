// Parse and match voice record keys from `voice.record_key` config.
// Simplified from upstream hermes-ink's platform.ts for OpenTUI.

import type { VoiceKey, VoiceMod } from "./types"
import type { ParsedKey } from "@opentui/core"

/** Documented default: Ctrl+B. */
const DEFAULT_VOICE_KEY: VoiceKey = {
  mod: "ctrl",
  ch: "b",
  raw: "ctrl+b",
}

const MOD_ALIASES: Record<string, VoiceMod> = {
  alt: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  option: "alt",
  opt: "alt",
}

/** Parse `voice.record_key` config string into a VoiceKey.
 *  Falls back to Ctrl+B on malformed / empty / unparseable input. */
export function parseVoiceRecordKey(raw: unknown): VoiceKey {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_VOICE_KEY
  const lower = raw.trim().toLowerCase()
  const parts = lower.split("+").map(p => p.trim()).filter(Boolean)
  if (parts.length < 2) return DEFAULT_VOICE_KEY
  if (parts.length > 2) return DEFAULT_VOICE_KEY // no multi-modifier
  const [modRaw, chRaw] = parts
  const mod = MOD_ALIASES[modRaw]
  if (!mod) return DEFAULT_VOICE_KEY
  if (chRaw.length !== 1) return DEFAULT_VOICE_KEY // single char only
  // Block reserved ctrl chords (interrupt / quit / clear).
  if (mod === "ctrl" && (chRaw === "c" || chRaw === "d" || chRaw === "l"))
    return DEFAULT_VOICE_KEY
  return { mod, ch: chRaw, raw: lower }
}

/** Render a parsed key as "Ctrl+B" / "Alt+R" for display. */
export function formatVoiceRecordKey(v: VoiceKey): string {
  const mod = v.mod[0].toUpperCase() + v.mod.slice(1)
  return `${mod}+${v.ch.toUpperCase()}`
}

/** Match an OpenTUI ParsedKey against a parsed voice record key.
 *  In OpenTUI: `meta` = Alt/Option, `super` = Cmd/Win, `ctrl` = Ctrl. */
export function isVoiceToggleKey(
  key: ParsedKey,
  configured: VoiceKey = DEFAULT_VOICE_KEY,
): boolean {
  if (key.name.toLowerCase() !== configured.ch) return false
  if (key.shift) return false // no shift-modified chords
  switch (configured.mod) {
    case "ctrl":
      return key.ctrl && !key.meta && !key.super
    case "alt":
      return key.meta && !key.ctrl && !key.super
  }
}
