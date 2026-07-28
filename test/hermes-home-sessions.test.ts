import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { openStateDb } from "./fixtures/state-db"
import { searchSessions, queryRecentSessions, querySubagents, queryLineage } from "../src/service/hermes-home"
import { kind, resetDb, peek, lastReal, chainTip, remove } from "../src/service/sessions-db"

// Seeds a clean state.db and exercises the real SQL paths in
// sessions-db.ts via the hermes-home re-exports.
//
// The sandbox state.db is process-wide (see test/preload.ts), so we
// wipe tables before each seed AND at the end, leaving the DB empty
// for unrelated tests that expect "No sessions" rendering.

const wipe = () => {
  const db = openStateDb()
  db.run("DELETE FROM messages")
  db.run("DELETE FROM sessions")
  db.close()
}

const seed = () => {
  const db = openStateDb()
  db.run("DELETE FROM messages")
  db.run("DELETE FROM sessions")
  return db
}

const resetMessagesSchema = () => {
  const db = openStateDb()
  db.run("DROP TRIGGER IF EXISTS messages_fts_insert")
  db.run("DROP TRIGGER IF EXISTS messages_fts_delete")
  db.run("DROP TABLE IF EXISTS messages_fts")
  db.run("DROP TABLE IF EXISTS messages")
  db.close()
  openStateDb().close()
  resetDb()
}

const addMessageProvenanceColumns = (db: ReturnType<typeof openStateDb>) => {
  db.run("ALTER TABLE messages ADD COLUMN platform_message_id TEXT")
  db.run("ALTER TABLE messages ADD COLUMN observed INTEGER DEFAULT 0")
}

const sess = (
  db: ReturnType<typeof openStateDb>,
  id: string,
  source: string,
  ts: number,
  extra: Record<string, string | number | null> = {},
) => {
  // Extras win over defaults — merge then emit distinct columns.
  const fields: Record<string, string | number | null> = {
    id, source, started_at: ts, message_count: 1, ...extra,
  }
  const cols = Object.keys(fields)
  const vals = Object.values(fields)
  const q = `INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
  db.prepare(q).run(...vals)
}

const msg = (
  db: ReturnType<typeof openStateDb>,
  sid: string,
  role: string,
  content: string,
  ts = 1000,
) => {
  db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)")
    .run(sid, role, content, ts)
}

describe("remove", () => {
  afterAll(wipe)

  test("keeps parent, child, and messages when fallback deletion faults after orphaning", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000)
    sess(db, "child", "tui", 1700000001, { parent_session_id: "root" })
    msg(db, "root", "user", "parent content")
    db.run(`CREATE TRIGGER stab_remove_fault
      BEFORE DELETE ON messages WHEN old.session_id = 'root'
      BEGIN SELECT RAISE(FAIL, 'fault delete message'); END`)
    db.close()

    expect(() => remove("root")).toThrow("fault delete message")

    const check = openStateDb()
    try {
      const rows = check.query("SELECT id, parent_session_id FROM sessions ORDER BY id").all() as Array<{
        id: string
        parent_session_id: string | null
      }>
      const count = check.query("SELECT COUNT(*) AS c FROM messages WHERE session_id = 'root'").get() as { c: number }
      expect(rows).toEqual([
        { id: "child", parent_session_id: "root" },
        { id: "root", parent_session_id: null },
      ])
      expect(count.c).toBe(1)
    } finally {
      check.run("DROP TRIGGER IF EXISTS stab_remove_fault")
      check.close()
    }
  })
})

describe("searchSessions (gsk.12: all sources, not just tui/cli)", () => {
  beforeEach(() => {
    const db = seed()
    // One session per surface, all containing the same FTS keyword.
    for (const [id, source] of [
      ["t1", "tui"], ["c1", "cli"], ["d1", "discord"],
      ["g1", "telegram"], ["a1", "api_server"], ["s1", "slack"],
    ] as const) {
      sess(db, id, source, 1700000000)
      msg(db, id, "user", `please find the unicornkeyword here (${source})`, 1700000001)
    }
    db.close()
  })
  afterAll(wipe)

  test("returns hits from every source, not just tui and cli", () => {
    const hits = searchSessions("unicornkeyword", 20)
    const sources = hits.map(h => h.source).sort()
    expect(sources).toEqual(
      ["api_server", "cli", "discord", "slack", "telegram", "tui"].sort(),
    )
  })

  test("discord-only session content is searchable", () => {
    const hits = searchSessions("unicornkeyword", 20).filter(h => h.source === "discord")
    expect(hits).toHaveLength(1)
    expect(hits[0].session_id).toBe("d1")
    expect(hits[0].snippet).toContain("unicornkeyword")
  })
})

describe("queryRecentSessions (baseline — all sources surface)", () => {
  beforeEach(() => {
    const db = seed()
    sess(db, "t1", "tui", 1700000100)
    sess(db, "d1", "discord", 1700000200)
    sess(db, "g1", "telegram", 1700000300)
    msg(db, "t1", "user", "tui content")
    msg(db, "d1", "user", "discord content")
    msg(db, "g1", "user", "telegram content")
    db.close()
  })
  afterAll(wipe)

  test("lists every source with no filter", () => {
    const rows = queryRecentSessions(10)
    const sources = rows.map(r => r.sessionSource).sort()
    expect(sources).toEqual(["discord", "telegram", "tui"])
  })
})

describe("queryRecentSessions (gsk.13: root-only + subagent_count + tip projection)", () => {
  afterAll(wipe)

  test("hides subagents (child started before parent ended)", () => {
    const db = seed()
    // Parent still live — ended_at NULL. Child spawned while live.
    sess(db, "root", "tui", 1700000000)
    sess(db, "sub", "tui", 1700000010, { parent_session_id: "root" })
    db.close()

    const rows = queryRecentSessions(10)
    expect(rows.map(r => r.id)).toEqual(["root"])
    expect(rows[0].subagent_count).toBe(1)
  })

  test("hides subagents spawned BEFORE parent ended_at", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000, { ended_at: 1700001000 })
    sess(db, "sub1", "tui", 1700000500, { parent_session_id: "root" })
    sess(db, "sub2", "tui", 1700000800, { parent_session_id: "root" })
    db.close()

    const rows = queryRecentSessions(10)
    expect(rows.map(r => r.id)).toEqual(["root"])
    expect(rows[0].subagent_count).toBe(2)
  })

  test("shows branch children as top-level siblings", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000, { ended_at: 1700001000, end_reason: "branched" })
    sess(db, "branch", "tui", 1700002000, { parent_session_id: "root" })
    db.close()

    const rows = queryRecentSessions(10)
    const ids = rows.map(r => r.id).sort()
    expect(ids).toEqual(["branch", "root"])
  })

  test("projects compression root forward to tip (one row, tip identity, root started_at)", () => {
    const db = seed()
    // Root (compressed) → continuation A (compressed) → continuation B (live tip).
    sess(db, "root", "tui", 1700000000,
      { ended_at: 1700001000, end_reason: "compression", message_count: 100, title: "Root title" })
    sess(db, "contA", "tui", 1700001100,
      { parent_session_id: "root", ended_at: 1700002000, end_reason: "compression",
        message_count: 50, title: "Cont A" })
    sess(db, "contB", "tui", 1700002100,
      { parent_session_id: "contA", message_count: 20, title: "Live tip" })
    db.close()

    const rows = queryRecentSessions(10)
    // Only ONE row surfaces (the root, projected forward).
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("contB")               // tip's identity
    expect(rows[0].message_count).toBe(20)         // tip's stats
    expect(rows[0].title).toBe("Live tip")         // tip's title
    expect(rows[0].started_at).toBe(1700000000)    // root's started_at (Detail: Started/Duration span chain)
    expect(rows[0].lineage_root_id).toBe("root")   // lineage pointer to original root
    expect(rows[0].end_reason).toBe(null)          // tip isn't ended
  })

  test("projected row carries both sort keys (root started_at, tip last_active)", () => {
    // Regression guard for PR #27: the Sessions tab sorts by either
    // started_at or last_active. A projected chain row must expose
    // the root's start (for "started" sort + Detail panel) AND the
    // tip's activity (for "active" sort) on the same row.
    const db = seed()
    sess(db, "root", "tui", 1600000000,
      { ended_at: 1600001000, end_reason: "compression" })
    sess(db, "tip", "tui", 1700099500,
      { parent_session_id: "root", message_count: 5, title: "tip" })
    msg(db, "tip", "user", "ping", 1700099999)
    db.close()

    const rows = queryRecentSessions(10)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("tip")
    expect(rows[0].started_at).toBe(1600000000)    // root's
    expect(rows[0].last_active).toBe(1700099999)   // tip's
  })

  test("non-chain roots get lineage_root_id = null", () => {
    const db = seed()
    sess(db, "plain", "tui", 1700000000)
    db.close()

    const rows = queryRecentSessions(10)
    expect(rows[0].lineage_root_id).toBe(null)
    expect(rows[0].subagent_count).toBe(0)
  })

  test("subagent_count excludes branches and compression continuations", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000, { ended_at: 1700001000, end_reason: "compression" })
    // Subagent during life
    sess(db, "sub", "tui", 1700000500, { parent_session_id: "root" })
    // Two compression continuations after end — the later one becomes the tip.
    sess(db, "contA", "tui", 1700001100, { parent_session_id: "root" })
    sess(db, "contB", "tui", 1700001200, { parent_session_id: "root" })
    db.close()

    const rows = queryRecentSessions(10)
    // Root is projected to contB (latest continuation). Its subagent_count
    // is 0 because the SUBAGENT hangs off root, not contB.
    expect(rows).toHaveLength(1)
    expect(rows[0].lineage_root_id).toBe("root")
    expect(rows[0].id).toBe("contB")
    expect(rows[0].subagent_count).toBe(0)
  })
})

describe("querySubagents (gsk.14: fetch children for expansion)", () => {
  afterAll(wipe)

  test("returns children that spawned while parent was live", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000, { ended_at: 1700001000 })
    sess(db, "sub1", "tui", 1700000500, { parent_session_id: "root", title: "First sub" })
    sess(db, "sub2", "tui", 1700000800, { parent_session_id: "root", title: "Second sub" })
    db.close()

    const subs = querySubagents("root")
    expect(subs.map(s => s.id)).toEqual(["sub1", "sub2"])
    expect(subs.map(s => s.title)).toEqual(["First sub", "Second sub"])
  })

  test("returns empty array for parent with no subagents", () => {
    const db = seed()
    sess(db, "alone", "tui", 1700000000)
    db.close()

    expect(querySubagents("alone")).toEqual([])
  })

  test("returns empty array for unknown parent id", () => {
    wipe()
    expect(querySubagents("does-not-exist")).toEqual([])
  })

  test("excludes branches and compression continuations (started_at >= parent.ended_at)", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000, { ended_at: 1700001000, end_reason: "branched" })
    // Subagent: started BEFORE end
    sess(db, "sub", "tui", 1700000500, { parent_session_id: "root" })
    // Branch: started at exactly ended_at
    sess(db, "branch", "tui", 1700001000, { parent_session_id: "root" })
    // Continuation-like: well after end
    sess(db, "cont", "tui", 1700002000, { parent_session_id: "root" })
    db.close()

    const subs = querySubagents("root")
    expect(subs.map(s => s.id)).toEqual(["sub"])
  })

  test("treats live parent (ended_at NULL) as 'currently running' — all children are subs", () => {
    const db = seed()
    sess(db, "live", "tui", 1700000000)
    sess(db, "sub1", "tui", 1700000500, { parent_session_id: "live" })
    sess(db, "sub2", "tui", 1700000800, { parent_session_id: "live" })
    db.close()

    expect(querySubagents("live").map(s => s.id)).toEqual(["sub1", "sub2"])
  })

  test("subagent rows carry real subagent_count (N-level recursion)", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000)
    sess(db, "sub", "tui", 1700000500, { parent_session_id: "root" })
    sess(db, "grand1", "tool", 1700000600, { parent_session_id: "sub" })
    sess(db, "grand2", "tool", 1700000700, { parent_session_id: "sub" })
    db.close()

    const subs = querySubagents("root")
    expect(subs[0].id).toBe("sub")
    expect(subs[0].subagent_count).toBe(2)
    expect(subs[0].lineage_root_id).toBe(null)
    expect(querySubagents("sub").map(s => s.id)).toEqual(["grand1", "grand2"])
  })
})

describe("queryLineage (gsk.16: compression chain predecessor/successor)", () => {
  afterAll(wipe)

  test("empty info when session has no compression lineage", () => {
    const db = seed()
    sess(db, "plain", "tui", 1700000000)
    db.close()
    expect(queryLineage("plain")).toEqual({})
  })

  test("compressedTo populated when this session has a compression child", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000,
      { ended_at: 1700001000, end_reason: "compression", title: "Root title" })
    sess(db, "cont", "tui", 1700001100,
      { parent_session_id: "root", title: "Cont title" })
    db.close()

    const info = queryLineage("root")
    expect(info.continuesFrom).toBeUndefined()
    expect(info.compressedTo).toEqual({ id: "cont", title: "Cont title" })
  })

  test("continuesFrom populated when this session IS a compression child", () => {
    const db = seed()
    sess(db, "root", "tui", 1700000000,
      { ended_at: 1700001000, end_reason: "compression", title: "Root title" })
    sess(db, "cont", "tui", 1700001100,
      { parent_session_id: "root", title: "Cont title" })
    db.close()

    const info = queryLineage("cont")
    expect(info.continuesFrom).toEqual({ id: "root", title: "Root title" })
    expect(info.compressedTo).toBeUndefined()
  })

  test("mid-chain row surfaces both ends", () => {
    const db = seed()
    sess(db, "a", "tui", 1700000000,
      { ended_at: 1700001000, end_reason: "compression", title: "A" })
    sess(db, "b", "tui", 1700001100,
      { parent_session_id: "a", ended_at: 1700002000, end_reason: "compression", title: "B" })
    sess(db, "c", "tui", 1700002100,
      { parent_session_id: "b", title: "C" })
    db.close()

    const info = queryLineage("b")
    expect(info.continuesFrom).toEqual({ id: "a", title: "A" })
    expect(info.compressedTo).toEqual({ id: "c", title: "C" })
  })

  test("subagent parent link is NOT a compression lineage", () => {
    const db = seed()
    sess(db, "live", "tui", 1700000000)
    sess(db, "sub", "tui", 1700000500, { parent_session_id: "live" })
    db.close()
    expect(queryLineage("sub")).toEqual({})
    expect(queryLineage("live")).toEqual({})
  })

  test("branched parent link is NOT a compression lineage", () => {
    const db = seed()
    sess(db, "src", "tui", 1700000000, { ended_at: 1700001000, end_reason: "branched" })
    sess(db, "br", "tui", 1700001100, { parent_session_id: "src" })
    db.close()
    expect(queryLineage("br").continuesFrom).toBeUndefined()
    expect(queryLineage("src").compressedTo).toBeUndefined()
  })
})

describe("kind() — pure classifier (single source of truth for parent→child semantics)", () => {
  test("null parent → root", () => {
    expect(kind(null, { started_at: 100 })).toBe("root")
  })
  test("parent still live → subagent regardless of end_reason", () => {
    expect(kind({ ended_at: null, end_reason: null }, { started_at: 100 })).toBe("subagent")
    expect(kind({ ended_at: null, end_reason: "compression" }, { started_at: 100 })).toBe("subagent")
  })
  test("child started before parent ended → subagent", () => {
    expect(kind({ ended_at: 200, end_reason: "compression" }, { started_at: 100 })).toBe("subagent")
  })
  test("child started at/after compression-ended parent → continuation", () => {
    expect(kind({ ended_at: 100, end_reason: "compression" }, { started_at: 100 })).toBe("continuation")
    expect(kind({ ended_at: 100, end_reason: "compression" }, { started_at: 500 })).toBe("continuation")
  })
  test("child started at/after branched parent → branch", () => {
    expect(kind({ ended_at: 100, end_reason: "branched" }, { started_at: 200 })).toBe("branch")
  })
  test("parent ended normally, child after → subagent (degenerate: orphaned child)", () => {
    expect(kind({ ended_at: 100, end_reason: "exit" }, { started_at: 200 })).toBe("subagent")
  })
})

describe("lastReal() — compression chain walk", () => {
  afterAll(wipe)

  test("returns root TUI session when it has messages (no compression)", () => {
    const db = seed()
    // Root started first, still has messages
    sess(db, "r1", "tui", 1700000000, {
      ended_at: 1700000100, end_reason: "exit", message_count: 3,
    })
    db.close()
    resetDb()

    const result = lastReal()
    expect(result?.id).toBe("r1")
    expect(result?.message_count).toBe(3)
  })

  test("skips root and returns continuation when root has no messages", () => {
    const db = seed()
    // Root compressed at 2000 with no remaining messages
    sess(db, "root", "tui", 1700000000, {
      ended_at: 2000, end_reason: "compression", message_count: 0,
    })
    // Continuation started after root ended, has messages
    sess(db, "cont", "tui", 2100, {
      ended_at: null, end_reason: null, message_count: 5,
      parent_session_id: "root",
    })
    db.close()
    resetDb()

    // lastReal must walk the chain and return the continuation tip
    const result = lastReal()
    expect(result?.id).toBe("cont")
    expect(result?.message_count).toBe(5)
  })

  test("returns multi-link chain tip (root → cont1 → cont2)", () => {
    const db = seed()
    sess(db, "A", "tui", 1000, {
      ended_at: 2000, end_reason: "compression", message_count: 0,
    })
    sess(db, "B", "tui", 2100, {
      ended_at: 3000, end_reason: "compression", message_count: 0,
      parent_session_id: "A",
    })
    sess(db, "C", "tui", 3100, {
      ended_at: null, end_reason: null, message_count: 4,
      parent_session_id: "B",
    })
    db.close()
    resetDb()

    // Must walk two links: root→cont1→cont2 and return C
    const result = lastReal()
    expect(result?.id).toBe("C")
    expect(result?.message_count).toBe(4)
  })

  test("returns zero-message tip when the chain has a real predecessor", () => {
    const db = seed()
    sess(db, "root", "tui", 1000, {
      ended_at: 2000, end_reason: "compression", message_count: 296,
    })
    sess(db, "tip", "tui", 2100, {
      parent_session_id: "root", message_count: 0,
    })
    db.close()
    resetDb()

    const result = lastReal()
    expect(result?.id).toBe("tip")
    expect(result?.message_count).toBe(0)
  })

  test("returns CLI session when no TUI sessions exist (CLI sessions are valid for herm -c)", () => {
    const db = seed()
    sess(db, "cli-sess", "cli", 1700000000, {
      ended_at: 1700000100, end_reason: "exit", message_count: 1,
    })
    db.close()
    resetDb()

    expect(lastReal()?.id).toBe("cli-sess")
  })

  test("ignores subagent rows even when newest", () => {
    const db = seed()
    sess(db, "parent", "tui", 1000, {
      ended_at: null, end_reason: null, message_count: 3,
    })
    sess(db, "sub", "tui", 1500, {
      parent_session_id: "parent", message_count: 9,
    })
    db.close()
    resetDb()

    expect(lastReal()?.id).toBe("parent")
  })

  test("standalone root is its own tip", () => {
    const db = seed()
    sess(db, "solo", "tui", 1700000000, {
      ended_at: null, end_reason: null, message_count: 2,
    })
    db.close()
    resetDb()

    // No chain to walk; root itself is returned
    const result = lastReal()
    expect(result?.id).toBe("solo")
  })
})

describe("chainTip() — returns tip regardless of message_count", () => {
  afterAll(wipe)

  test("returns same id when passed a standalone root", () => {
    const db = seed()
    sess(db, "solo", "tui", 1700000000)
    db.close()
    resetDb()

    expect(chainTip("solo")).toBe("solo")
  })

  test("does not cross subagent links in either direction", () => {
    const db = seed()
    sess(db, "root", "tui", 1000, {
      ended_at: 2000, end_reason: "compression",
    })
    sess(db, "sub", "tui", 1500, {
      parent_session_id: "root", message_count: 4,
    })
    sess(db, "cont", "tui", 2100, {
      parent_session_id: "root", message_count: 2,
    })
    db.close()
    resetDb()

    expect(chainTip("root")).toBe("cont")
    expect(chainTip("sub")).toBe("sub")
  })

  test("returns continuation when passed a compressed root", () => {
    const db = seed()
    sess(db, "root", "tui", 1000, {
      ended_at: 2000, end_reason: "compression", message_count: 0,
    })
    sess(db, "cont", "tui", 2100, {
      parent_session_id: "root", message_count: 5,
    })
    db.close()
    resetDb()

    expect(chainTip("root")).toBe("cont")
  })

  test("walks multi-link chain and returns live tip", () => {
    const db = seed()
    sess(db, "A", "tui", 1000, {
      ended_at: 2000, end_reason: "compression", message_count: 0,
    })
    sess(db, "B", "tui", 2100, {
      ended_at: 3000, end_reason: "compression", message_count: 0,
      parent_session_id: "A",
    })
    sess(db, "C", "tui", 3100, {
      parent_session_id: "B", message_count: 8,
    })
    db.close()
    resetDb()

    // Pass the root → should walk to tip C
    expect(chainTip("A")).toBe("C")
    // Pass the middle → should walk to C
    expect(chainTip("B")).toBe("C")
    // Pass the tip → should return itself
    expect(chainTip("C")).toBe("C")
  })

  test("stub-reuse scenario: stored lastSessionId points to ended continuation with 296 msgs", () => {
    // Simulates: user stored "lastSessionId" = parent continuation id (296 msgs).
    // boot() calls chainTip(storedId) → walks to stub → stub has 0 msgs.
    // The 0-msg stub should be resumed, not skipped.
    const db = seed()
    // Root ended at compression
    sess(db, "root", "tui", 1700000000, {
      ended_at: 1700001000, end_reason: "compression", message_count: 0,
    })
    // Parent continuation ended (the one stored in lastSessionId)
    sess(db, "parent-cont", "tui", 1700001100, {
      ended_at: 1700002000, end_reason: "compression", message_count: 296,
      parent_session_id: "root",
    })
    // Live stub (0 msgs) — this is what boot() should find
    sess(db, "stub", "tui", 1700002100, {
      parent_session_id: "parent-cont", message_count: 0,
    })
    db.close()
    resetDb()

    expect(chainTip("parent-cont")).toBe("stub")
  })
})

afterAll(() => { wipe(); resetDb() })

describe("peek() — first/last transcript preview", () => {
  beforeEach(resetMessagesSchema)
  afterAll(wipe)

  test("returns every row when the transcript has four or fewer messages", () => {
    const db = seed()
    addMessageProvenanceColumns(db)
    sess(db, "px", "tui", 1700000000)
    for (let i = 0; i < 4; i++) msg(db, "px", "user", `m${i}`, 1000 + i)
    db.close()

    const rows = peek("px")
    expect(rows.map(r => r.content)).toEqual(["m0", "m1", "m2", "m3"])
    expect(rows[0].role).toBe("user")
  })

  test("returns first two and last two rows for longer transcripts", () => {
    const db = seed()
    addMessageProvenanceColumns(db)
    sess(db, "px", "tui", 1700000000)
    for (let i = 0; i < 5; i++) msg(db, "px", "user", `m${i}`, 1000 + i)
    db.close()

    expect(peek("px").map(r => r.content)).toEqual(["m0", "m1", "m3", "m4"])
  })

  test("includes tool_name and tool_calls columns", () => {
    const db = seed()
    addMessageProvenanceColumns(db)
    sess(db, "px", "tui", 1700000000)
    db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?,?,?,?,?)")
      .run("px", "assistant", null, '[{"name":"terminal"}]', 1000)
    db.prepare("INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)")
      .run("px", "tool", "output", "terminal", 1001)
    db.close()

    const rows = peek("px", 10)
    expect(rows[0].tool_calls).toContain("terminal")
    expect(rows[1].tool_name).toBe("terminal")
  })

  test("omits v13 provenance fields when the messages table is old schema", () => {
    const db = seed()
    sess(db, "px", "tui", 1700000000)
    msg(db, "px", "user", "legacy", 1000)
    db.close()

    const rows = peek("px", 10)
    expect(rows[0].platform_message_id).toBeUndefined()
    expect(rows[0].observed).toBeUndefined()
  })

  test("includes v13 provenance fields when the messages table has them", () => {
    const db = seed()
    addMessageProvenanceColumns(db)
    sess(db, "px", "tui", 1700000000)
    db.prepare("INSERT INTO messages (session_id, role, content, platform_message_id, observed, timestamp) VALUES (?,?,?,?,?,?)")
      .run("px", "user", "from discord", "discord-42", 1, 1000)
    db.close()
    resetDb()

    const rows = peek("px", 10)
    expect(rows[0].platform_message_id).toBe("discord-42")
    expect(rows[0].observed).toBe(1)
  })

  test("unknown session → empty", () => {
    const db = seed()
    addMessageProvenanceColumns(db)
    db.close()
    resetDb()

    expect(peek("nope", 10)).toEqual([])
  })
})
