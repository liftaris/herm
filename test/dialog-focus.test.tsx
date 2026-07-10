import { describe, test, expect } from "bun:test"
import { act, useEffect } from "react"
import { useRenderer } from "@opentui/react"
import type { Renderable } from "@opentui/core"
import { mountNode, until } from "./harness"
import { useDialog } from "../src/ui/dialog"
import { openConfirm } from "../src/dialogs/confirm"

// Probe that holds a focused <input> and exposes the renderer's
// currentFocusedRenderable + a dialog handle.
let probe: { dialog: ReturnType<typeof useDialog>; focused: () => Renderable | null }

const Probe = () => {
  const renderer = useRenderer()
  const dialog = useDialog()
  useEffect(() => {
    probe = { dialog, focused: () => renderer.currentFocusedRenderable }
  })
  return <input focused value="seed" onInput={() => {}} />
}

describe("DialogProvider focus restore", () => {
  test("open → close restores focus to the renderable that held it before open", async () => {
    await using t = await mountNode(<Probe />)
    await until(t, () => probe.focused() !== null)
    const before = probe.focused()
    expect(before).not.toBeNull()

    let result: boolean | undefined
    act(() => { void openConfirm(probe.dialog, { title: "Hm", body: "ok?" }).then(r => { result = r }) })
    await until(t, () => t.frame().includes("Hm"))
    // Dialog's own overlay blurred the original input.
    expect(probe.focused()).not.toBe(before)

    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("Hm"))
    // Promise resolved false via provider onClose path.
    expect(result).toBe(false)
    // refocus() runs on setTimeout(0); give it one extra settle.
    await act(async () => { await Bun.sleep(5) })
    await t.settle()
    expect(probe.focused()).toBe(before)
  })

  test("replace() calls onClose of the entry it displaces", async () => {
    await using t = await mountNode(<Probe />)
    await t.settle()
    let closed = 0
    act(() => probe.dialog.replace(<text>one</text>, () => { closed++ }))
    await until(t, () => t.frame().includes("one"))
    act(() => probe.dialog.replace(<text>two</text>))
    await until(t, () => t.frame().includes("two"))
    expect(closed).toBe(1)
    act(() => probe.dialog.clear())
    await t.settle()
  })

  test("context identity stays stable while its stack getter remains live", async () => {
    await using t = await mountNode(<Probe />)
    await t.settle()
    const dialog = probe.dialog

    act(() => dialog.replace(<text>stable context</text>))
    await until(t, () => t.frame().includes("stable context"))
    expect(probe.dialog).toBe(dialog)
    expect(dialog.stack).toHaveLength(1)

    act(() => dialog.clear())
    await until(t, () => !t.frame().includes("stable context"))
    expect(probe.dialog).toBe(dialog)
    expect(dialog.stack).toHaveLength(0)
  })
})
