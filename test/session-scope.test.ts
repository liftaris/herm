import { describe, expect, test } from "bun:test"
import { sessionScope } from "../src/context/session-scope"

// Protects the wire contract with tui_gateway: Params models are
// `extra="forbid"`, so a session_id on a method that does not declare it is a
// hard 4000, not a no-op. The plausible production fault is a blanket session
// injection that silently breaks every non-session method (the /journey tab
// sends learning.frames with no session_id; injecting one kills the tab).
describe("session scope", () => {
  test("methods that do not declare session_id are left untouched", () => {
    const params = { cols: 80, frames: 2, rows: 6 }
    expect(sessionScope.merge("learning.frames", "sess-1", params)).toEqual(params)
  })

  test("methods that declare session_id receive the active session", () => {
    expect(sessionScope.merge("prompt.submit", "sess-1", { text: "hi" }))
      .toEqual({ session_id: "sess-1", text: "hi" })
  })

  test("an explicit caller-supplied session_id wins over the active session", () => {
    // /resume and the Sessions-tab lineage walk pass exact ids on purpose.
    expect(sessionScope.merge("session.resume", "active", { session_id: "target" }))
      .toEqual({ session_id: "target" })
  })

  test("no active session means no injection even on a scoped method", () => {
    expect(sessionScope.merge("prompt.submit", "", { text: "hi" })).toEqual({ text: "hi" })
  })

  test("the learning family is unscoped across all four journey operations", () => {
    for (const method of ["learning.frames", "learning.detail", "learning.edit", "learning.delete"]) {
      expect(sessionScope.scoped(method)).toBe(false)
    }
  })
})
