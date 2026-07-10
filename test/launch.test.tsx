import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { parseLaunch, type Launch } from "../src/app/launch"
import { openStateDb } from "./fixtures/state-db"
import { resetDb, lastReal, byId } from "../src/service/sessions-db"
import * as preferences from "../src/context/preferences"
import { useSession, normalize } from "../src/app/useSession"
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
    [["-c", "--no-splash"], { mode: "resume", splash: false }],
    [["--profile", "coder"], { mode: "new", profile: "coder", splash: true }],
    [["--resume", "abc123", "--profile", "coder"], { mode: "resume", profile: "coder", sid: "abc123", splash: true }],
  ]
  for (const [argv, want] of cases) {
    test(JSON.stringify(argv), () => expect(parseLaunch(argv)).toEqual(want))
  }

  test("requires a profile name", () => {
    expect(() => parseLaunch(["--profile"])).toThrow("--profile requires a name")
    expect(() => parseLaunch(["--profile", "--resume"])).toThrow("--profile requires a name")
  })
})

describe("normalize", () => {
  test("accepts db ids and session json filenames", () => {
    expect(normalize("20260509_002407_e8b6e4")).toBe("20260509_002407_e8b6e4")
    expect(normalize(" session_20260509_002407_e8b6e4.json ")).toBe("20260509_002407_e8b6e4")
    expect(normalize("session_not-a-date.json")).toBe("session_not-a-date")
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
  extra: Record<string, string | number | null> = {},
) => {
  const row: Record<string, string | number | null> = {
    id, source, started_at: ts, message_count, ...extra,
  }
  const cols = Object.keys(row)
  db.prepare(
    `INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...Object.values(row))
}

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

  test("mode:new reuses standalone empty stub instead of creating", async () => {
    preferences.set("lastSessionId", "stub")
    const gw = new MockGateway()
    const r = await boot(gw, { mode: "new" })
    expect(r.id).toBe("stub")
    expect(gw.calls.some(c => c.method === "session.create")).toBe(false)
    expect(gw.last("session.resume")?.params.session_id).toBe("stub")
  })

  test("mode:new creates instead of resuming empty compression-chain tip", async () => {
    const db = seed()
    sess(db, "root", "tui", 1000, 296, { ended_at: 2000, end_reason: "compression" })
    sess(db, "tip",  "tui", 2100,   0, { parent_session_id: "root" })
    db.close()
    resetDb()
    preferences.set("lastSessionId", "root")
    const gw = new MockGateway()
    await boot(gw, { mode: "new" })
    expect(gw.calls.some(c => c.method === "session.create")).toBe(true)
    expect(gw.calls.some(c => c.method === "session.resume")).toBe(false)
  })

  test("mode:new creates instead of reusing stored empty continuation", async () => {
    const db = seed()
    sess(db, "root", "tui", 1000, 296, { ended_at: 2000, end_reason: "compression" })
    sess(db, "tip",  "tui", 2100,   0, { parent_session_id: "root" })
    db.close()
    resetDb()
    preferences.set("lastSessionId", "tip")
    const gw = new MockGateway()
    await boot(gw, { mode: "new" })
    expect(gw.calls.some(c => c.method === "session.create")).toBe(true)
    expect(gw.calls.some(c => c.method === "session.resume")).toBe(false)
  })

  test("mode:new creates when lastSessionId is non-empty session", async () => {
    // herm-1jd: bare `herm` is fresh. `-c` is resume. Non-empty stored
    // id is NOT reused — that's an explicit choice, not a loss.
    preferences.set("lastSessionId", "real")
    const gw = new MockGateway()
    const r = await boot(gw, { mode: "new" })
    expect(gw.calls.some(c => c.method === "session.create")).toBe(true)
    expect(r.messages).toEqual([])
  })

  test("mode:resume (no sid) targets lastReal()", async () => {
    const gw = new MockGateway()
    await boot(gw, { mode: "resume" })
    expect(gw.last("session.resume")?.params.session_id).toBe("real")
  })

  test("mode:resume targets zero-message compression tip", async () => {
    const db = seed()
    sess(db, "root", "tui", 1000, 296, { ended_at: 2000, end_reason: "compression" })
    sess(db, "tip", "tui", 2100, 0, { parent_session_id: "root" })
    db.close()
    resetDb()

    const gw = new MockGateway()
    await boot(gw, { mode: "resume" })
    expect(gw.last("session.resume")?.params.session_id).toBe("tip")
  })

  test("mode:resume ignores stored provider/model", async () => {
    const db = seed()
    sess(db, "past", "tui", 1005, 5, { model: "gpt-5.5-free", billing_provider: "openai-codex" })
    db.close()
    resetDb()

    const gw = new MockGateway({
      "session.resume": p => ({ session_id: "live-past", resumed: p.session_id, messages: [] }),
      "config.set": () => { throw new Error("unexpected model switch") },
    })
    gw.setSession("old")
    const r = await boot(gw, { mode: "resume", sid: "past" })

    expect(gw.last("session.resume")?.params.session_id).toBe("past")
    expect(r.id).toBe("live-past")
    expect(r.note).toBeUndefined()
    expect(gw.calls.some(c => c.method === "config.set")).toBe(false)
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
