import { describe, test, expect } from "bun:test"
import type { ParsedKey, Renderable } from "@opentui/core"
import { Selection } from "../src/utils/selection"

const key = (name: string, ctrl = false): ParsedKey =>
  ({ name, ctrl, meta: false, shift: false, option: false, number: false,
     raw: name, sequence: name, eventType: "press" }) as ParsedKey

function stub(text: string, focused?: Renderable, inSel: Renderable[] = []) {
  let cleared = false
  let toasts = 0
  return {
    renderer: {
      getSelection: () => text
        ? { getSelectedText: () => text, selectedRenderables: inSel }
        : null,
      clearSelection: () => { cleared = true },
      currentFocusedRenderable: focused ?? null,
    },
    toast: {
      show: () => { toasts++ },
      clear: () => {},
      error: () => {},
    },
    cleared: () => cleared,
    toasts: () => toasts,
  }
}

describe("Selection.key", () => {
  test("no selection → passes through", () => {
    const s = stub("")
    expect(Selection.key(s.renderer, key("escape"))).toBe(false)
    expect(Selection.key(s.renderer, key("c", true))).toBe(false)
  })

  test("Esc with selection → clears + consumes", () => {
    const s = stub("highlighted text")
    expect(Selection.key(s.renderer, key("escape"))).toBe(true)
    expect(s.cleared()).toBe(true)
  })

  test("Ctrl+C with selection → yanks + consumes", () => {
    const s = stub("highlighted text")
    expect(Selection.key(s.renderer, key("c", true), s.toast)).toBe(true)
    expect(s.cleared()).toBe(true)
    expect(s.toasts()).toBe(1)
  })

  test("other key clears unless selection is inside focused renderable", () => {
    const focused = {} as Renderable
    const s1 = stub("x", focused, [focused])
    expect(Selection.key(s1.renderer, key("a"))).toBe(false)
    expect(s1.cleared()).toBe(false)

    const s2 = stub("x", focused, [])
    expect(Selection.key(s2.renderer, key("a"))).toBe(false)
    expect(s2.cleared()).toBe(true)
  })
})
