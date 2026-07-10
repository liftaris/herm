// Voice recording indicator — renders in the composer bar while recording/processing.

import { useTheme } from "../theme"
import type { VoiceState } from "./types"

type Props = { voice: VoiceState; keyLabel: string }

/** Status line shown in the composer area during voice activity. */
export function VoiceIndicator({ voice, keyLabel }: Props) {
  const theme = useTheme().theme
  if (!voice.enabled && !voice.recording && !voice.processing) return null

  let text: string
  let fg = theme.text
  if (voice.recording) {
    text = "● recording"
    fg = theme.error
  } else if (voice.processing) {
    text = "◌ transcribing"
    fg = theme.warning
  } else {
    text = `voice ready [${keyLabel}]`
    fg = theme.textMuted
  }

  return (
    <text>
      <span fg={fg}>{text}  </span>
    </text>
  )
}
