import { test, expect } from "bun:test"
import { createRef } from "react"
import { act } from "react"
import { mountNode, until } from "./harness"
import { tmpHome } from "./fixture/home"
import { openThemePicker } from "../src/dialogs/theme-picker"
import { useDialog } from "../src/ui/dialog"
import { useTheme } from "../src/theme"

type Handle = { open: () => void; theme: () => string; mode: () => "dark" | "light" }

const Probe = ({ handle }: { handle: React.RefObject<Handle | null> }) => {
  const dialog = useDialog()
  const ctx = useTheme()
  handle.current = {
    open: () => openThemePicker(dialog, ctx),
    theme: () => ctx.name,
    mode: () => ctx.mode,
  }
  return <text>{"probe"}</text>
}

// Regression: opening the picker and navigating used to blow up with
// "Maximum update depth exceeded" — live-preview onMove → prefs.set →
// provider re-render → new options identity → move effect re-fires.
// prefs.set() now no-ops on unchanged values, breaking the cycle.
test("theme picker: open + navigate does not loop, preview applies", async () => {
  const handle = createRef<Handle>()
  await using t = await mountNode(<Probe handle={handle} />)

  act(() => handle.current!.open())
  await until(t, () => t.frame().includes("Switch Theme"))
  expect(t.frame()).not.toContain("Maximum update depth")

  const before = handle.current!.theme()
  await act(async () => { t.keys.pressArrow("down") })
  await until(t, () => handle.current!.theme() !== before)
  expect(t.frame()).not.toContain("Maximum update depth")
  expect(t.frame()).toContain("Switch Theme")

  // Esc reverts the preview to the saved theme
  act(() => t.keys.pressEscape())
  await until(t, () => !t.frame().includes("Switch Theme"))
  expect(handle.current!.theme()).toBe(before)
})

test("theme picker: Tab toggles mode, Esc reverts, Enter keeps it", async () => {
  await using _home = await tmpHome({ prefs: { theme: "tokyonight", themeMode: "dark" } })
  const handle = createRef<Handle>()
  await using t = await mountNode(<Probe handle={handle} />)

  act(() => handle.current!.open())
  await until(t, () => t.frame().includes("Mode: dark"))

  act(() => t.keys.pressTab())
  await until(t, () => handle.current!.mode() === "light" && t.frame().includes("Mode: light"))
  act(() => t.keys.pressEscape())
  await until(t, () => !t.frame().includes("Switch Theme"))
  expect(handle.current!.mode()).toBe("dark")

  act(() => handle.current!.open())
  await until(t, () => t.frame().includes("Mode: dark"))
  act(() => t.keys.pressTab())
  await until(t, () => handle.current!.mode() === "light")
  act(() => t.keys.pressEnter())
  await until(t, () => !t.frame().includes("Switch Theme"))
  expect(handle.current!.mode()).toBe("light")
})
