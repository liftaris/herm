import { act } from "react"
import { describe, test } from "bun:test"
import { mount, until } from "./harness"

describe("notification events", () => {
  test("sticky credit notice renders and keyed clear removes it", async () => {
    const t = await mount({ width: 120, height: 32 })
    await until(t, () => t.frame().includes("Ready"))

    act(() => t.gw.push({
      type: "notification.show",
      payload: { text: "Credit access paused", level: "error", kind: "sticky", key: "credits.depleted" },
    }))
    await until(t, () => t.frame().includes("Credit access paused"))

    act(() => t.gw.push({ type: "notification.clear", payload: { key: "credits.depleted" } }))
    await until(t, () => !t.frame().includes("Credit access paused"))
    t.destroy()
  })
})
