import asset from "../default.eikon" with { type: "file" }
import { parseEikonFile, type ParsedEikon, type EikonState } from "../eikon"

export type AvatarState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "error"

let cached: ParsedEikon | undefined

export function defaultFrames(state: AvatarState): EikonState {
  const eikon = cached ??= parseEikonFile(asset)
  const clip = eikon.states.get(state)
  if (!clip) throw new Error(`Bundled default eikon has no ${state} state`)
  return clip
}
