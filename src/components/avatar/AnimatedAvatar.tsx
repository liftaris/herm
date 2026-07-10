import { useEffect, useRef, memo } from "react"
import type { TextNodeRenderable } from "@opentui/core"
import { STATE_FRAMES, type AvatarState } from "./states"
import type { ParsedEikon, EikonState } from "./eikon"
import { useTheme } from "../../theme"
import * as prefs from "../../context/preferences"
import * as perf from "../../utils/perf"

/**
 * Forward-only state driver (SPEC.md Playback Rules):
 *
 *   intro:  0 .. loopFrom-1   played once on state entry
 *   loop:   loopFrom .. N-1   repeated
 *
 * loopFrom = 0       → no intro, loop whole sequence
 * loopFrom = N       → play once, hold last frame (timer stops)
 *
 * State change restarts from frame 0, so the intro always plays.
 * When an `eikon` is supplied and defines the current state, it wins;
 * states missing from the eikon fall back to the baked-in set (which
 * palindromes its frames to preserve the legacy ping-pong look under
 * this forward-only driver).
 */

type PerfGlobal = typeof globalThis & {
  __hermAvatarRenders?: number
  __hermAvatarTimerStarts?: number
}

const maxLines = (frames: string[][]): number => frames.reduce((n, f) => Math.max(n, f.length), 0)

export const AnimatedAvatar = memo(({ state = "idle", eikon, onHold }: {
  state?: AvatarState
  eikon?: ParsedEikon
  /** Fired once when a play-once state (loopFrom === frames.length)
   *  reaches its last frame. Consumer decides fallthrough policy. */
  onHold?: (state: AvatarState) => void
}) => {
  const g = globalThis as PerfGlobal
  if (process.env.HERM_TEST_PERF === "1") g.__hermAvatarRenders = (g.__hermAvatarRenders ?? 0) + 1
  const theme = useTheme().theme
  const refs = useRef<Array<TextNodeRenderable | null>>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdRef = useRef(onHold); holdRef.current = onHold

  const signal = `state.${state}`
  const clip: EikonState = eikon?.resolve(signal) ?? eikon?.states.get(state) ?? STATE_FRAMES[state]
  const { frames, fps, loopFrom } = clip
  const count = frames.length
  const lines = maxLines(frames)
  const first = frames[0] ?? []

  const animate = prefs.usePref("animations") !== false
  const targetFps = prefs.usePref("targetFps") ?? 30
  const dt = 1000 / Math.max(1, Math.min(fps, targetFps))

  useEffect(() => {
    const paint = (idx: number) => {
      const frame = frames[Math.min(idx, count - 1)] ?? []
      for (let i = 0; i < lines; i++) {
        const node = refs.current[i]
        if (node) node.children = [frame[i] ?? ""]
      }
    }

    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    paint(0)
    if (!animate || count < 2) return
    perf.count("avatar:timer:start")
    if (process.env.HERM_TEST_PERF === "1") g.__hermAvatarTimerStarts = (g.__hermAvatarTimerStarts ?? 0) + 1
    let idx = 0

    const tick = () => {
      perf.count("avatar:tick")
      idx++
      if (idx >= count) {
        if (loopFrom >= count) { timer.current = null; paint(count - 1); holdRef.current?.(state); return }
        idx = loopFrom
      }
      paint(idx)
      timer.current = setTimeout(tick, dt)
    }

    timer.current = setTimeout(tick, dt)
    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        perf.count("avatar:timer:stop")
      }
    }
  }, [state, frames, count, loopFrom, animate, dt, lines, g])

  const end = perf.mark("avatar:render")
  const result = (
    <box flexDirection="column">
      {Array.from({ length: lines }, (_, i) => (
        <text key={i}>
          <span ref={el => { refs.current[i] = el }} fg={theme.hermAvatar}>{first[i] ?? ""}</span>
        </text>
      ))}
    </box>
  )
  end()
  return result
})
