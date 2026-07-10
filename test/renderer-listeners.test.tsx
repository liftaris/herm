import { expect, test } from "bun:test"
import { getEventListeners, getMaxListeners } from "node:events"
import { act } from "react"
import { mount, mountNode, until } from "./harness"
import { Kanban } from "../src/tabs/Kanban"

test("renderer listener budget covers multi-scrollbox tabs", async () => {
  await using t = await mountNode(<Kanban focused />)
  expect(getMaxListeners(t.renderer)).toBeGreaterThanOrEqual(64)
})

test("tab remounts release renderer selection listeners", async () => {
  await using t = await mount()
  await until(t, () => t.frame().includes("Ready"))
  const count = () => getEventListeners(t.renderer, "selection").length
  const before = count()
  for (let i = 0; i < 20; i++) {
    act(() => t.keys.pressArrow("right", { meta: true }))
    await t.settle()
    act(() => t.keys.pressArrow("left", { meta: true }))
    await t.settle()
  }
  expect(count()).toBe(before)
})
