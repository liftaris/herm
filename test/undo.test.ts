import { expect, test } from "bun:test"
import { undo } from "../src/app/undo"
import { MockGateway } from "./harness"

test("undo stops at the first rejected turn", async () => {
  let calls = 0
  const gw = new MockGateway({
    "session.undo": () => {
      calls++
      if (calls === 2) throw new Error("undo failed")
      return { removed: 2 }
    },
  })

  await expect(undo(gw, 3)).rejects.toThrow("undo failed")
  expect(calls).toBe(2)
})

test("undo targets an explicit branch session", async () => {
  const gw = new MockGateway()
  await undo(gw, 2, "branch-sid")
  expect(gw.calls.filter(c => c.method === "session.undo").map(c => c.params.session_id))
    .toEqual(["branch-sid", "branch-sid"])
})
