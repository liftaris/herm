import { expect, test, spyOn } from "bun:test"
import { act, useEffect } from "react"
import { mount, mountNode, until, MockGateway } from "./harness"
import { tmpHome } from "./fixture/home"
import { useGateway } from "../src/context/gateway"
import { useToast } from "../src/ui/toast"
import { useDialog } from "../src/ui/dialog"
import { useKanbanDiagnostics } from "../src/tabs/kanban-diagnostics"
import { Agents } from "../src/tabs/Agents"
import { EikonStudio, resetToolsetsCache } from "../src/tabs/EikonStudio"
import { gen } from "../src/service/eikon-gen"
import { makeGoalHook } from "../src/app/goalHook"
import * as history from "../src/app/spawnHistory"
import { FNS } from "../src/io/fns"

for (const key of ["catalog", "busy", "title"]) {
  test(`${key} RPC failures show their raw message`, async () => {
    await using h = await tmpHome()
    const message = `${key} RPC unavailable: storage denied`
    await using t = await mount({ handlers: {
      ...(key === "catalog" ? { "commands.catalog": () => { throw new Error(message) } } : {}),
      ...(key === "busy" ? { "config.get": (p: Record<string, unknown>) => {
        if (p.key === "busy") throw new Error(message)
        return {}
      } } : {}),
      ...(key === "title" ? { "session.title": () => { throw new Error(message) } } : {}),
    } })
    if (key === "title") {
      act(() => t.gw.push({ type: "message.complete", session_id: "test-sid", payload: { status: "complete" } }))
    }
    await until(t, () => t.frame().includes(message), 4000)
    expect(t.frame()).toContain(message)
  })
}

const Diagnostics = () => {
  const gw = useGateway()
  const diagnostics = useKanbanDiagnostics(gw)
  useEffect(() => { void diagnostics.refresh([{ slug: "default", name: "Default" }]) }, [])
  return null
}

test("diagnostic request failure reaches a toast instead of clearing badges silently", async () => {
  await using h = await tmpHome()
  await using t = await mountNode(<Diagnostics />, { handlers: {
    "shell.exec": () => { throw new Error("diagnostic transport unavailable") },
  } })
  await until(t, () => t.frame().includes("diagnostic transport unavailable"))
  expect(t.frame()).toContain("diagnostic transport unavailable")
})

test("profile lookup failure is visible instead of listing the wrong home", async () => {
  await using h = await tmpHome()
  await using t = await mountNode(<Agents focused sessionId="test-sid" />, { handlers: {
    "config.get": () => { throw new Error("profile lookup denied") },
  } })
  await until(t, () => t.frame().includes("profile lookup denied"))
  expect(t.frame()).toContain("profile lookup denied")
})

test("generation capability probe failures reach the studio toast", async () => {
  await using h = await tmpHome()
  resetToolsetsCache()
  gen.setProbe(async () => { throw new Error("generation probe unavailable") })
  try {
    await using t = await mountNode(<EikonStudio focused />)
    await until(t, () => t.frame().includes("generation probe unavailable"))
    expect(t.frame()).toContain("generation probe unavailable")
  } finally {
    gen.setProbe(null)
    resetToolsetsCache()
  }
})

const Goal = () => {
  const dialog = useDialog()
  const toast = useToast()
  useEffect(() => { makeGoalHook(dialog, toast).check("raw-error-goal") }, [])
  return null
}

test("goal read failures reach the existing toast", async () => {
  await using h = await tmpHome()
  const probe = spyOn(FNS, "goalState").mockImplementation(() => { throw new Error("goal state unavailable") })
  try {
    await using t = await mountNode(<Goal />)
    await until(t, () => t.frame().includes("goal state unavailable"))
    expect(t.frame()).toContain("goal state unavailable")
  } finally { probe.mockRestore() }
})

test("spawn persistence rejects with the transport error", async () => {
  const gw = new MockGateway({ "spawn_tree.save": () => { throw new Error("spawn history write denied") } })
  history.record("start", { subagent_id: "raw-error-child", task_index: 0, goal: "test" })
  await expect(history.flush(gw, "test-sid")).rejects.toThrow("spawn history write denied")
  history.clear()
})
