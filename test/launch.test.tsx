import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { parseLaunch, type Launch } from "../src/app/launch"
import { openStateDb } from "./fixtures/state-db"
import { resetDb, lastReal, byId } from "../src/utils/sessions-db"
import * as preferences from "../src/utils/preferences"
import { useSession, normalizeSessionId } from "../src/app/useSession"
import { MockGateway, mountNode } from "./harness"

// ─── argv parse ──────────────────────────────────────────────────────

describe("parseLaunch", () => {
  const cases: Array<[string[], Launch]> = [
    [[], { mode: "new", splash: true }],
    [["-c"], { mode: "resume", splash: true }],
    [["--continue"], { mode: "resume", splash: true }],
    [["--resume"], { mode: "resume", splash: true }],
    [["--resume", "abc123"], { mode: "resume", sid: "abc123", splash: true }],
    [["--resume", "--foo"], { mode: "resume", splash: true }],
    [["--foo", "-c"], { mode: "resume", splash: true }],
    [["--no-splash"], { mode: "new", splash: false }],
    [["--no-splash", "-c"], { mode: "resume", splash: false }],
  ]
  for (const [argv, want] of cases) {
    test(JSON.stringify(argv), () => expect(parseLaunch(argv)).toEqual(want))
  }
})

describe("normalizeSessionId", () => {
  test("accepts db ids and session json filenames", () => {
    expect(normalizeSessionId("20260509_002407_e8b6e4")).toBe("20260509_002407_e8b6e4")
    expect(normalizeSessionId(" session_20260509_002407_e8b6e4.json ")).toBe("20260509_002407_e8b6e4")
    expect(normalizeSessionId("session_not-a-date.json")).toBe("session_not-a-date")
  })
})

// ─── sessions-db helpers ─────────────────────────────────────────────

const seed = () => {
  const db = openStateDb()
  db.run("DELETE FROM messages")
  db.run("DELETE FROM sessions")
  return db
}
const wipe = () => { const db = seed(); db.close(); resetDb() }

const sess = (
  db: ReturnType<typeof openStateDb>,
  id: string,
  source: string,
  ts: number,
  message_count = 1,
) => db.prepare(
  "INSERT INTO sessions (id, source, started_at, message_count) VALUES (?,?,?,?)",
).run(id, source, ts, message_count)

describe("lastReal / byId", () => {
  beforeEach(() => {
    const db = seed()
    sess(db, "stub", "tui", 1004, 0)     // newest but empty
    sess(db, "real", "tui", 1003, 7)     // ← target
    sess(db, "disc", "discord", 1002, 3) // non-tui
    sess(db, "old", "tui", 1001, 2)
    db.close()
    resetDb()
  })
  afterAll(wipe)

  test("lastReal skips empty stubs and non-tui sources", () => {
    expect(lastReal()?.id).toBe("real")
  })

  test("byId returns message_count for stub-reuse check", () => {
    expect(byId("stub")?.message_count).toBe(0)
    expect(byId("real")?.message_count).toBe(7)
    expect(byId("nope")).toBeNull()
  })
})

// ─── boot(launch) ────────────────────────────────────────────────────

/** Mount a probe that exposes useSession() without the full <App>. */
const boot = async (gw: MockGateway, launch: Launch) => {
  let ops: ReturnType<typeof useSession> | undefined
  const Probe = () => { ops = useSession(); return null }
  const t = await mountNode(<Probe />, { gw })
  const r = await ops!.boot(launch)
  t.destroy()
  return r
}

describe("useSession.boot", () => {
  beforeEach(() => {
    const db = seed()
    sess(db, "stub", "tui", 1004, 0)
    sess(db, "real", "tui", 1003, 5)
    db.close()
    resetDb()
  })
  afterAll(wipe)

  test("mode:new reuses own empty stub instead of creating", async () => {
    preferences.set("lastSessionId", "stub")
    const gw = new MockGateway()
    const r = await boot(gw, { mode: "new" })
    expect(r.id).toBe("stub")
    expect(gw.calls.some(c => c.method === "session.create")).toBe(false)
    expect(gw.last("session.resume")?.params.session_id).toBe("stub")
  })

  test("mode:new resumes when lastSessionId points to a non-empty session (fixes herm -c)", async () => {
    // Previously, non-empty lastSessionId fell through to fresh() — the stored
    // session was silently abandoned. Now we resume it so no work is lost.
    preferences.set("lastSessionId", "real")
    const gw = new MockGateway()
    const r = await boot(gw, { mode: "new" })
    expect(gw.calls.some(c => c.method === "session.create")).toBe(false)
    expect(gw.last("session.resume")?.params.session_id).toBe("real")
    expect(r.messages).toEqual([])
  })

  test("mode:resume (no sid) targets lastReal()", async () => {
    const gw = new MockGateway()
    await boot(gw, { mode: "resume" })
    expect(gw.last("session.resume")?.params.session_id).toBe("real")
  })

  test("mode:resume normalizes session_*.json filenames", async () => {
    const gw = new MockGateway()
    await boot(gw, { mode: "resume", sid: "session_20260509_002407_e8b6e4.json" })
    expect(gw.last("session.resume")?.params.session_id).toBe("20260509_002407_e8b6e4")
  })

  test("mode:resume sid rejection falls through to fresh + note", async () => {
    const gw = new MockGateway({
      "session.resume": () => { throw new Error("nope") },
    })
    const r = await boot(gw, { mode: "resume", sid: "deadbeef" })
    expect(r.note).toContain("deadbeef")
    expect(gw.calls.some(c => c.method === "session.create")).toBe(true)
  })
})
