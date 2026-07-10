import { describe, expect, test } from "bun:test"
import { act, createRef } from "react"
import { mountNode, until } from "./harness"
import { Composer, type ComposerHandle } from "../src/components/chat/Composer"
import { BackgroundProvider, useBackground } from "../src/app/background"

const noop = () => {}

// Surface the bg API next to the Composer so the test can register/unregister
// without reaching into provider internals.
const Host = ({ grab, composerRef, subagents = 0, streaming = false }: {
  grab: (api: ReturnType<typeof useBackground>) => void
  composerRef: React.Ref<ComposerHandle>
  subagents?: number
  streaming?: boolean
}) => {
  const api = useBackground()
  grab(api)
  return (
    <Composer
      ref={composerRef}
      focused
      canSubmitPrompt={true}
      ready
      streaming={streaming}
      subagents={subagents}
      cmds={[]}
      model="test-model"
      onSend={noop}
      onSlash={noop}
    />
  )
}

const mountComposer = async (opts: { subagents?: number; streaming?: boolean } = {}) => {
  const ref = createRef<ComposerHandle>()
  let api: ReturnType<typeof useBackground> | undefined
  const t = await mountNode(
    <BackgroundProvider>
      <Host grab={a => { api = a }} composerRef={ref} subagents={opts.subagents} streaming={opts.streaming} />
    </BackgroundProvider>,
    { width: 80, height: 8 },
  )
  return { t, get: () => api!, ref }
}

describe("Composer background fragment", () => {
  test("absent when no background tasks", async () => {
    const { t } = await mountComposer()
    expect(t.frame()).not.toContain("▶")
    t.destroy()
  })

  test("shows ▶ 1 with one task", async () => {
    const { t, get } = await mountComposer()
    act(() => { get().register("task-a") })
    await until(t, () => t.frame().includes("▶ 1"))
    t.destroy()
  })

  test("shows ▶ 3 with three tasks", async () => {
    const { t, get } = await mountComposer()
    act(() => {
      get().register("a")
      get().register("b")
      get().register("c")
    })
    await until(t, () => t.frame().includes("▶ 3"))
    t.destroy()
  })

  test("disappears when count returns to zero", async () => {
    const { t, get } = await mountComposer()
    act(() => { get().register("a") })
    await until(t, () => t.frame().includes("▶ 1"))
    act(() => { get().unregister("a") })
    await until(t, () => !t.frame().includes("▶"))
    t.destroy()
  })

  test("shows idle subagent auto-resume hint", async () => {
    const { t } = await mountComposer({ subagents: 1 })
    expect(t.frame()).toContain("↩ resumes when subagent finishes")
    t.destroy()
  })

  test("pluralizes idle subagent auto-resume hint", async () => {
    const { t } = await mountComposer({ subagents: 3 })
    expect(t.frame()).toContain("↩ resumes when 3 subagents finish")
    t.destroy()
  })

  test("hides subagent auto-resume hint while streaming", async () => {
    const { t } = await mountComposer({ subagents: 2, streaming: true })
    expect(t.frame()).not.toContain("resumes when")
    t.destroy()
  })

  test("hides subagent auto-resume hint when count is zero", async () => {
    const { t } = await mountComposer({ subagents: 0 })
    expect(t.frame()).not.toContain("resumes when")
    t.destroy()
  })
})
