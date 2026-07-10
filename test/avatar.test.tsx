import { describe, test, expect, mock } from "bun:test"
import { mountNode, until } from "./harness"
import { AnimatedAvatar } from "../src/components/avatar/AnimatedAvatar"
import type { ParsedEikon } from "../src/components/avatar/eikon"

type TestGlobal = typeof globalThis & { __hermAvatarRenders?: number }

const eikon = (frames: string[][], loopFrom = 0): ParsedEikon => {
  const states = new Map([["idle", { fps: 30, loopFrom, frames }]])
  return {
    meta: { name: "test", version: "1", width: 1, height: 1, states: {} } as unknown as ParsedEikon["meta"],
    states,
    resolve: signal => states.get(signal.replace(/^state\./, "")),
  }
}

describe("AnimatedAvatar", () => {
  test("animated frames advance without React re-rendering the avatar", async () => {
    process.env.HERM_TEST_PERF = "1"
    const g = globalThis as TestGlobal
    g.__hermAvatarRenders = 0
    const t = await mountNode(<AnimatedAvatar state="idle" eikon={eikon([["A"], ["B"]])} />, { width: 12, height: 4 })
    await until(t, () => t.frame().includes("A"))
    const renders = g.__hermAvatarRenders

    await until(t, () => t.frame().includes("B"))

    expect(t.frame()).toContain("B")
    expect(g.__hermAvatarRenders).toBe(renders)
    t.destroy()
    delete process.env.HERM_TEST_PERF
  })

  test("play-once states hold the final frame and fire onHold", async () => {
    const onHold = mock(() => {})
    const t = await mountNode(
      <AnimatedAvatar state="idle" eikon={eikon([["A", "tail"], ["B"]], 2)} onHold={onHold} />,
      { width: 12, height: 4 },
    )

    await until(t, () => t.frame().includes("B"))
    await until(t, () => onHold.mock.calls.length > 0)

    expect(t.frame()).toContain("B")
    expect(t.frame()).not.toContain("tail")
    expect(onHold).toHaveBeenCalledWith("idle")
    t.destroy()
  })
})
