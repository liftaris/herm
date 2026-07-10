import { test, expect } from "bun:test"
import { useEffect, useState } from "react"
import { mountNode, until } from "./harness"
import { useDialog } from "../src/ui/dialog"

// DialogHost Boundary — a dialog body that throws during render must
// (a) not crash the TUI and (b) surface via the toast layer.

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error("boom")
  return <text>safe</text>
}

function Opener({ arm }: { arm: boolean }) {
  const dialog = useDialog()
  const [opened, setOpened] = useState(false)
  useEffect(() => {
    if (opened) return
    setOpened(true)
    dialog.replace(<Bomb armed={arm} />)
  }, [dialog, opened, arm])
  return null
}

test("dialog boundary: thrown render dismisses dialog + toasts error", async () => {
  // A live boundary logs via console.error — silence it for this test
  // so bun test output stays clean. The boundary still fires onError.
  const origErr = console.error
  console.error = () => {}
  try {
    await using t = await mountNode(<Opener arm={true} />)
    // Toast appears with the thrown message and the dialog is gone.
    await until(t, () => t.frame().includes("boom"))
    expect(t.frame()).toContain("Error")
  } finally {
    console.error = origErr
  }
})

test("dialog boundary: well-behaved dialog still renders", async () => {
  await using t = await mountNode(<Opener arm={false} />)
  await until(t, () => t.frame().includes("safe"))
  expect(t.frame()).toContain("safe")
})
