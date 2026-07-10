import { describe, test, expect } from "bun:test"
import { act, useEffect } from "react"
import { mountNode, until, MockGateway } from "./harness"
import { openRollback } from "../src/dialogs/rollback"
import { useDialog } from "../src/ui/dialog"
import { useToast } from "../src/ui/toast"
import { useGateway } from "../src/context/gateway"

const POINTS = [
  { hash: "a1b2c3d4e5f6", timestamp: Math.floor(Date.now() / 1000) - 120, message: "write parser" },
  { hash: "b2c3d4e5f6a1", timestamp: Math.floor(Date.now() / 1000) - 3600, message: "refactor auth" },
]

const Host = () => {
  const dialog = useDialog()
  const toast = useToast()
  const gw = useGateway()
  useEffect(() => { openRollback(dialog, gw, toast) }, [])
  return null
}

describe("Rollback dialog", () => {
  test("list failure surfaces the gateway error", async () => {
    const gw = new MockGateway({
      "rollback.list": () => { throw new Error("rollback unavailable") },
    })
    const t = await mountNode(<Host />, { gw })
    await until(t, () => t.frame().includes("rollback unavailable"))
    t.destroy()
  })

  test("disabled → shows notice", async () => {
    const gw = new MockGateway({
      "rollback.list": () => ({ enabled: false, checkpoints: [] }),
    })
    const t = await mountNode(<Host />, { gw })
    await until(t, () => t.frame().includes("Checkpoints disabled"))
    expect(t.frame()).toContain("Enable checkpoints")
    t.destroy()
  })

  test("lists checkpoints, Enter→diff, r→y→restore", async () => {
    const restored: string[] = []
    const gw = new MockGateway({
      "rollback.list": () => ({ enabled: true, checkpoints: POINTS }),
      "rollback.diff": p => ({
        stat: "2 files changed",
        diff: `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old ${p.hash}\n+new line`,
      }),
      "rollback.restore": p => { restored.push(p.hash as string); return { success: true, history_removed: 3 } },
    })
    const t = await mountNode(<Host />, { gw, width: 140, height: 40 })
    await until(t, () => t.frame().includes("2 checkpoints"))

    const f = t.frame()
    expect(f).toContain("a1b2c3d")
    expect(f).toContain("write parser")
    expect(f).toContain("b2c3d4e")
    expect(f).toContain("refactor auth")
    expect(t.gw.last("rollback.list")).toBeDefined()

    // ↓ then Enter opens diff for second checkpoint
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("2 files changed"))
    expect(t.gw.last("rollback.diff")?.params.hash).toBe("b2c3d4e5f6a1")
    expect(t.frame()).toContain("+new line")
    expect(t.frame()).toContain("[r] restore")

    // r → confirm prompt
    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => t.frame().includes("Restore this checkpoint?"))

    // y → rollback.restore called, dialog closes, toast shown
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => restored.length > 0)
    expect(restored).toEqual(["b2c3d4e5f6a1"])
    await until(t, () => t.frame().includes("Restored b2c3d4e"))
    expect(t.frame()).not.toContain("2 files changed")
    t.destroy()
  })

  test("late diff cannot mismatch the selected restore target", async () => {
    let stale!: (value: unknown) => void
    const restored: string[] = []
    const gw = new MockGateway({
      "rollback.list": () => ({ enabled: true, checkpoints: POINTS }),
      "rollback.diff": p => p.hash === POINTS[0].hash
        ? new Promise(resolve => { stale = resolve })
        : { stat: "fresh stat", diff: "fresh second diff" },
      "rollback.restore": p => { restored.push(p.hash as string); return { success: true } },
    })
    const t = await mountNode(<Host />, { gw, width: 140, height: 40 })
    await until(t, () => t.frame().includes("2 checkpoints"))

    act(() => t.keys.pressEnter())
    await until(t, () => gw.calls.filter(c => c.method === "rollback.diff").length === 1)
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("fresh second diff"))
    expect(t.frame()).toContain("b2c3d4e")

    stale({ stat: "stale stat", diff: "stale first diff" })
    await act(async () => { await Bun.sleep(0) })
    await t.settle()
    expect(t.frame()).toContain("fresh second diff")
    expect(t.frame()).not.toContain("stale first diff")

    await act(async () => { await t.keys.typeText("r") })
    await act(async () => { await t.keys.typeText("y") })
    await until(t, () => restored.length === 1)
    expect(restored).toEqual([POINTS[1].hash])
    t.destroy()
  })

  test("restore confirmation cannot dispatch twice", async () => {
    let restores = 0
    const gw = new MockGateway({
      "rollback.list": () => ({ enabled: true, checkpoints: POINTS }),
      "rollback.diff": () => ({ stat: "stat", diff: "diff" }),
      "rollback.restore": () => { restores++; return new Promise(() => {}) },
    })
    const t = await mountNode(<Host />, { gw })
    await until(t, () => t.frame().includes("2 checkpoints"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("[r] restore"))
    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => t.frame().includes("Restore this checkpoint?"))

    act(() => {
      t.keys.pressKey("y")
      t.keys.pressKey("y")
    })
    await until(t, () => restores > 0)
    expect(restores).toBe(1)
    t.destroy()
  })

  test("Esc in diff view returns to list", async () => {
    const gw = new MockGateway({
      "rollback.list": () => ({ enabled: true, checkpoints: POINTS }),
      "rollback.diff": () => ({ stat: "stat", diff: "@@ -1 +1 @@\n-a\n+b" }),
    })
    const t = await mountNode(<Host />, { gw })
    await until(t, () => t.frame().includes("2 checkpoints"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("[r] restore"))

    act(() => t.keys.pressEscape())
    await until(t, () => t.frame().includes("2 checkpoints"))
    expect(t.frame()).toContain("write parser")
    t.destroy()
  })
})
