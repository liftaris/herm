import { expect, test } from "bun:test"
import { mountBudget } from "../src/components/chat/mount-budget"

test("the mount budget retains a tail and reveals bounded chunks without negative indices", () => {
  expect([0, 20, 40, 41, 200].map(mountBudget.start)).toEqual([0, 0, 0, 1, 160])
  expect([160, 100, 40, 0].map(mountBudget.older)).toEqual([100, 40, 0, 0])
})
