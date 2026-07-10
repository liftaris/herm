import { expect, test } from "bun:test"
import { useEffect } from "react"
import { useDialog } from "../src/ui/dialog"
import { useGateway } from "../src/context/gateway"
import { openSpawnHistory } from "../src/dialogs/spawn-history"
import { mountNode, until } from "./harness"

const Host = () => {
  const dialog = useDialog()
  const gw = useGateway()
  useEffect(() => { openSpawnHistory(dialog, gw, "sid") }, [])
  return null
}

test("spawn history list failure stays visible", async () => {
  const t = await mountNode(<Host />, {
    handlers: { "spawn_tree.list": () => { throw new Error("spawn list unavailable") } },
  })
  await until(t, () => t.frame().includes("spawn list unavailable"))
  t.destroy()
})

test("closing the loading dialog prevents a late list from reopening it", async () => {
  let resolve!: (value: unknown) => void
  const t = await mountNode(<Host />, {
    handlers: { "spawn_tree.list": () => new Promise(done => { resolve = done }) },
  })
  await t.settle()
  t.keys.pressEscape()
  await t.settle()
  resolve({ entries: [{
    path: "/tmp/late.json", session_id: "sid", count: 1,
    label: "late tree", finished_at: Date.now() / 1000,
  }] })
  await new Promise(done => setTimeout(done, 20))
  await t.settle()
  expect(t.frame()).not.toContain("late tree")
  t.destroy()
})

test("spawn snapshot failure stays visible", async () => {
  const t = await mountNode(<Host />, {
    handlers: {
      "spawn_tree.list": () => ({ entries: [{
        path: "/tmp/spawn.json", session_id: "sid", count: 1,
        label: "one agent", finished_at: Date.now() / 1000,
      }] }),
      "spawn_tree.load": () => { throw new Error("spawn snapshot unavailable") },
    },
  })
  await until(t, () => t.frame().includes("one agent"))
  t.keys.pressEnter()
  await until(t, () => t.frame().includes("spawn snapshot unavailable"))
  t.destroy()
})

test("spawn snapshot replaces its loading state", async () => {
  const t = await mountNode(<Host />, {
    handlers: {
      "spawn_tree.list": () => ({ entries: [{
        path: "/tmp/spawn.json", session_id: "sid", count: 1,
        label: "one agent", finished_at: Date.now() / 1000,
      }] }),
      "spawn_tree.load": () => ({
        started_at: 10,
        finished_at: 12,
        subagents: [{
          subagent_id: "sub-1", goal: "inspect gateway", status: "completed",
          depth: 0, tool_count: 2, started_at: 10, finished_at: 12,
        }],
      }),
    },
  })
  await until(t, () => t.frame().includes("one agent"))
  t.keys.pressEnter()
  await until(t, () => t.frame().includes("inspect gateway"))
  t.destroy()
})
