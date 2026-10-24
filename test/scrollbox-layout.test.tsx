import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, createRef, useState } from "react"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"

test("late-loaded growing scrollbox preserves fixed siblings inside its column", async () => {
  const scroll = createRef<ScrollBoxRenderable>()
  const bottom = createRef<BoxRenderable>()
  let load!: () => void
  function View() {
    const [loaded, setLoaded] = useState(false)
    load = () => setLoaded(true)
    return (
      <box flexDirection="column" width={60} height={30}>
        <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} border padding={1}>
          <box height={1}><text>Header</text></box>
          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            {!loaded ? <box height={1}><text>Loading</text></box> : (
              <box flexDirection="column" flexGrow={1} overflow="hidden">
                <box height={10} flexShrink={0}><text>Fixed above</text></box>
                <scrollbox ref={scroll} scrollY flexGrow={1} flexShrink={1} flexBasis={0} minHeight={1}>
                  <box flexDirection="column" width="100%">
                    <box height={1}><text>Loaded row</text></box>
                    <box height={1}><text>Second row</text></box>
                  </box>
                </scrollbox>
                <box ref={bottom} height={6} flexShrink={0}><text>Fixed below</text></box>
              </box>
            )}
          </box>
        </box>
      </box>
    )
  }
  const t = await testRender(<View />, { width: 70, height: 34 })
  try {
    await t.renderOnce()
    act(() => load())
    await t.renderOnce()
    await t.renderOnce()
    expect(t.captureCharFrame()).toContain("Loaded row")
    expect(t.captureCharFrame()).toContain("Fixed below")
    expect(scroll.current!.height).toBe(9)
    expect(bottom.current!.height).toBe(6)
    expect(bottom.current!.y + bottom.current!.height).toBeLessThanOrEqual(28)
  } finally {
    act(() => t.renderer.destroy())
  }
})
