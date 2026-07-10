import defaultEikonText from "../default.eikon" with { type: "text" };
import { parseEikon, type EikonState } from "../eikon";

export type AvatarState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "error";

// The bundled default avatar (built via eikon/scripts/mk_eikon.ts) is
// the source of truth; `/eikon`-picked files override per state. A
// one-frame blank guards against a malformed bundle — the sidebar box
// is fixed-height so worst case is an empty pillar, not a crash.
const BLANK: EikonState = { fps: 1, loopFrom: 1, frames: [[""]] };

const DEFAULT_EIKON = (() => {
  try { return parseEikon(defaultEikonText) } catch { return undefined }
})();

export const STATE_FRAMES: Record<AvatarState, EikonState> = {
  idle: DEFAULT_EIKON?.states.get("idle") ?? BLANK,
  listening: DEFAULT_EIKON?.states.get("listening") ?? BLANK,
  thinking: DEFAULT_EIKON?.states.get("thinking") ?? BLANK,
  speaking: DEFAULT_EIKON?.states.get("speaking") ?? BLANK,
  working: DEFAULT_EIKON?.states.get("working") ?? BLANK,
  error: DEFAULT_EIKON?.states.get("error") ?? BLANK,
};
