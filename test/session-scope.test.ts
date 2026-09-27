import { describe, expect, test } from "bun:test"
import { sessionScope } from "../src/context/session-scope"
import { SESSION_SCOPED } from "../src/context/session-scope.gen"

// Protects the wire contract with tui_gateway: Params models are
// `extra="forbid"`, so a session_id on a method that does not declare it is a
// hard 4000, not a no-op. The plausible production fault is a blanket session
// injection that silently breaks every non-session method — /journey
// (learning.frames) and the Skills tab (skills.manage) are the visible
// casualties on a real backend.
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

  test("the learning family and skills.manage are unscoped", () => {
    // The regression: the backend declares no session_id on any of these, so
    // the blanket injection answered 4000 and both surfaces failed.
    for (const method of ["learning.frames", "learning.detail", "learning.edit", "learning.delete", "skills.manage"]) {
      expect(sessionScope.scoped(method)).toBe(false)
    }
  })

  test("the client consults every method the generated contract scopes", () => {
    // The generated artifact is the single source of truth; drift between it
    // and the set the client consults would silently reintroduce the fault.
    for (const method of SESSION_SCOPED) {
      expect(sessionScope.scoped(method)).toBe(true)
    }
    expect(SESSION_SCOPED.length).toBeGreaterThan(0)
  })
})
