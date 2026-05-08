import { describe, test, expect, beforeAll } from "bun:test"
import { act } from "react"
import { useEffect } from "react"
import { Database } from "bun:sqlite"
import { join } from "path"
import { mkdirSync } from "fs"
import { mountNode, until, MockGateway } from "./harness"
import { openCountdown } from "../src/dialogs/countdown"
import { makeGoalHook } from "../src/app/goalHook"
import { useDialog } from "../src/ui/dialog"
import { goalState, resetDb } from "../src/utils/sessions-db"

// ─── goalState reader ────────────────────────────────────────────────

describe("sessions-db.goalState", () => {
  const HH = process.env.HERMES_HOME!

  beforeAll(() => {
    mkdirSync(HH, { recursive: true })
    const db = new Database(join(HH, "state.db"))
    db.run("CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT)")
    db.run("INSERT OR REPLACE INTO state_meta VALUES (?, ?)", [
      "goal:sid-done",
      JSON.stringify({ goal: "ship it", status: "done", turn_count: 3, max_turns: null }),
    ])
    db.run("INSERT OR REPLACE INTO state_meta VALUES (?, ?)", [
      "goal:sid-active", JSON.stringify({ goal: "wip", status: "active" }),
    ])
    db.close()
    resetDb() // drop any cached handle so q() reopens against the now-seeded file
  })

  test("parses done + active; null on missing", () => {
    const d = goalState("sid-done")
    expect(d?.status).toBe("done")
    expect(d?.goal).toBe("ship it")
    expect(d?.turn_count).toBe(3)
    expect(goalState("sid-active")?.status).toBe("active")
    expect(goalState("nope")).toBeNull()
  })
})

// ─── countdown dialog ────────────────────────────────────────────────

const Host = (p: { seconds: number; out: { v?: boolean } }) => {
  const dialog = useDialog()
  useEffect(() => {
    void openCountdown(dialog, {
      title: "Goal complete — suspending",
      body: "ship it",
      action: "→ systemctl suspend",
      seconds: p.seconds,
    }).then(ok => { p.out.v = ok })
  }, [])
  return null
}

describe("countdown dialog", () => {
  test("seconds=0 fires immediately", async () => {
    const out: { v?: boolean } = {}
    const t = await mountNode(<Host seconds={0} out={out} />)
    await until(t, () => out.v !== undefined)
    expect(out.v).toBe(true)
    t.destroy()
  })

  test("any key cancels before fire", async () => {
    const out: { v?: boolean } = {}
    const t = await mountNode(<Host seconds={10} out={out} />)
    await until(t, () => t.frame().includes("systemctl suspend"))
    expect(t.frame()).toContain("10s")
    expect(t.frame()).toContain("press any key to cancel")
    await act(async () => { await t.keys.typeText("x") })
    await until(t, () => out.v !== undefined)
    expect(out.v).toBe(false)
    t.destroy()
  })
})

// ─── goalHook.cmd → command.dispatch ─────────────────────────────────

describe("goalHook.cmd", () => {
  const mk = () => {
    const calls: Record<string, unknown>[] = []
    const gw = new MockGateway({
      "command.dispatch": (p) => {
        calls.push(p)
        if (String(p.arg).startsWith("ship")) return {
          type: "send",
          notice: "  ⊙ Goal set (20-turn budget): x\n  \x1b[2mAfter each turn…\x1b[22m",
          message: String(p.arg),
        }
        return { type: "exec", output: String(p.arg) ? `ok ${String(p.arg)}` : "No active goal" }
      },
    })
    const dialog = { replace: () => {}, clear: () => {}, stack: [] as const, open: () => false }
    const toast = { show: () => {} }
    const hook = makeGoalHook(gw, dialog, toast)
    return { hook, calls }
  }

  test("verbs pass through to command.dispatch; no kick", async () => {
    const { hook, calls } = mk()
    for (const v of ["status", "pause", "resume", "clear", "done"]) {
      const r = await hook.cmd(v)
      expect(r.kick).toBeNull()
    }
    expect(calls.map(c => c.arg)).toEqual([
      "status", "pause", "resume", "clear", "done",
    ])
    expect(calls.every(c => c.name === "goal")).toBe(true)
  })

  test("bare /goal → status; no kick", async () => {
    const { hook, calls } = mk()
    const r = await hook.cmd("")
    expect(calls[0]).toMatchObject({ name: "goal", arg: "" })
    expect(r.kick).toBeNull()
  })

  test("free text → set; kick = goal text; ANSI stripped from output", async () => {
    const { hook, calls } = mk()
    const r = await hook.cmd("ship the $(thing)")
    expect(calls[0]).toMatchObject({ name: "goal", arg: "ship the $(thing)" })
    expect(r.kick).toBe("ship the $(thing)")
    // _DIM/_RST stripped; lines trimmed.
    expect(r.line).toContain("⊙ Goal set")
    expect(r.line).not.toContain("\x1b[")
  })

  // Regression guard: the original implementation smuggled goal text
  // through shell.exec → `python3 -c '…'`, which tui_gateway's
  // shell.exec handler hard-rejects via detect_dangerous_command
  // ("script execution via -e/-c flag"). No shell.exec, ever.
  test("never dispatches shell.exec", async () => {
    let touched = false
    const gw = new MockGateway({
      "command.dispatch": () => ({ type: "exec", output: "ok" }),
      "shell.exec": () => { touched = true; return { stdout: "", stderr: "", code: 0 } },
    })
    const hook = makeGoalHook(gw,
      { replace: () => {}, clear: () => {}, stack: [] as const, open: () => false },
      { show: () => {} })
    await hook.cmd("anything")
    await hook.cmd("done")
    expect(touched).toBe(false)
  })
})
