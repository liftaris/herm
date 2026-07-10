import { describe, test, expect, beforeEach } from "bun:test"
import { useEffect } from "react"
import { act } from "react"
import { mkdirSync, writeFileSync } from "fs"
import { hermesPath } from "../src/service/hermes-home"
import { mountNode, until, MockGateway } from "./harness"
import { openCurator } from "../src/dialogs/curator"
import { useDialog } from "../src/ui/dialog"

describe("curator dialog", () => {
  beforeEach(() => {
    mkdirSync(hermesPath("logs/curator/20260501-100000"), { recursive: true })
    writeFileSync(
      hermesPath("logs/curator/20260501-100000/REPORT.md"),
      "# Curator Run\n\n- pruned `dead-skill`\n- **3 stale** flagged\n",
    )
    mkdirSync(hermesPath("skills"), { recursive: true })
    writeFileSync(
      hermesPath("skills/.curator_state"),
      JSON.stringify({
        run_count: 2,
        last_run_at: "2026-05-01T10:00:00Z",
        last_run_summary: "auto: 2 marked stale; llm: tightened `foo-skill`",
        paused: false,
      }),
    )
  })

  const Open = () => {
    const d = useDialog()
    useEffect(() => openCurator(d), [])
    return null
  }

  test("REPORT.md renders via <markdown> (headings styled, not raw #)", async () => {
    const t = await mountNode(<Open />, { width: 130, height: 40 })
    await until(t, () => t.frame().includes("Curator Run"))
    // Heading marker concealed by the markdown renderable; plain <text>
    // would have shown the literal "# ".
    expect(t.frame()).not.toMatch(/#\s+Curator Run/)
    expect(t.frame()).toContain("pruned")
    expect(t.frame()).toContain("2 runs")
    // last_run_summary also goes through <markdown> — backticks concealed.
    expect(t.frame()).toContain("foo-skill")
    expect(t.frame()).not.toContain("`foo-skill`")
    // Bordered scrollbox around the report body.
    expect(t.frame()).toMatch(/│.*pruned/)
    t.destroy()
  })

  test("next-run from last+interval; r/p shell to hermes curator (c8w.3)", async () => {
    // last_run_at = now-1d so last+168h is always ~6d out, wall-clock-safe.
    writeFileSync(hermesPath("skills/.curator_state"), JSON.stringify({
      run_count: 2, paused: false,
      last_run_at: new Date(Date.now() - 86400_000).toISOString(),
    }))
    writeFileSync(hermesPath("config.yaml"),
      "curator:\n  interval_hours: 168\n  stale_after_days: 30\n  archive_after_days: 90\n")
    const calls: string[] = []
    const gw = new MockGateway({
      "shell.exec": (p) => { calls.push(String(p.command)); return { stdout: "ok", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Open />, { width: 130, height: 40, gw })
    await until(t, () => t.frame().includes("Next run"))
    const f = t.frame()
    expect(f).toMatch(/Next run\s+in [56]d/)
    expect(f).toContain("Interval     168h")
    expect(f).toContain("Stale after  30d")
    expect(f).toContain("r run now")
    expect(f).toContain("p pause")

    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => calls.includes("hermes curator run"))
    await act(async () => { await t.keys.typeText("p") })
    await until(t, () => calls.includes("hermes curator pause"))
    t.destroy()
  })

  test("paused state: next-run masked, p resumes", async () => {
    writeFileSync(hermesPath("skills/.curator_state"),
      JSON.stringify({ run_count: 1, last_run_at: "2026-05-01T10:00:00Z", paused: true }))
    const calls: string[] = []
    const gw = new MockGateway({
      "shell.exec": (p) => { calls.push(String(p.command)); return { stdout: "", stderr: "", code: 0 } },
    })
    const t = await mountNode(<Open />, { width: 130, height: 40, gw })
    await until(t, () => t.frame().includes("· paused"))
    expect(t.frame()).toMatch(/Next run\s+— \(paused\)/)
    expect(t.frame()).toContain("p resume")
    await act(async () => { await t.keys.typeText("p") })
    await until(t, () => calls.includes("hermes curator resume"))
    t.destroy()
  })

  test("archived count + 'a' opens picker + Enter restores (t_54e1b527)", async () => {
    const calls: string[] = []
    const gw = new MockGateway({
      "shell.exec": (p) => {
        const cmd = String(p.command)
        calls.push(cmd)
        if (cmd === "hermes curator list-archived") {
          return { stdout: "dead-skill\nstale-skill\nghost-skill\n", stderr: "", code: 0 }
        }
        return { stdout: "ok", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Open />, { width: 130, height: 40, gw })
    // Count appears in the left KVBlock.
    await until(t, () => t.frame().includes("Archived     3"))
    expect(t.frame()).toContain("a archived skills")

    // 'a' switches the right pane to the archived list.
    await act(async () => { await t.keys.typeText("a") })
    await until(t, () => t.frame().includes("Archived skills (3)"))
    expect(t.frame()).toContain("▸ dead-skill")
    expect(t.frame()).toContain("  stale-skill")
    expect(t.frame()).toContain("  ghost-skill")

    // ↓ moves selection.
    await act(async () => { await t.keys.pressArrow("down") })
    await until(t, () => t.frame().includes("▸ stale-skill"))

    // Enter restores the selected skill.
    await act(async () => { await t.keys.pressEnter() })
    await until(t, () => calls.includes("hermes curator restore stale-skill"))
    // Restored row disappears from the list. (A toast in the top-right may
    // still echo "Restored stale-skill" — assert on list count + remaining rows.)
    await until(t, () => t.frame().includes("Archived skills (2)"))
    expect(t.frame()).toContain("▸ dead-skill")
    expect(t.frame()).toContain("  ghost-skill")
    // The archived pane showed 3 rows; after restore it shows 2.
    const panelLines = t.frame().split("\n").filter(l => /dead-skill|stale-skill|ghost-skill/.test(l))
    expect(panelLines.filter(l => l.includes("stale-skill")).every(l => l.includes("Restored"))).toBe(true)

    // Esc returns to report pane.
    await act(async () => { await t.keys.pressEscape() })
    await until(t, () => t.frame().includes("Report · "))
    t.destroy()
  })

  test("archived skill names are shell quoted on restore", async () => {
    const calls: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const cmd = String(p.command)
        calls.push(cmd)
        if (cmd === "hermes curator list-archived")
          return { stdout: "bad; echo PWN\n", stderr: "", code: 0 }
        return { stdout: "ok", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Open />, { width: 130, height: 40, gw })
    await until(t, () => t.frame().includes("Archived     1"))
    await act(async () => { await t.keys.typeText("a") })
    await act(async () => { await t.keys.pressEnter() })
    await until(t, () => calls.length === 2)
    expect(calls[1]).toBe("hermes curator restore 'bad; echo PWN'")
    t.destroy()
  })

  test("same-frame restore confirmation dispatches once", async () => {
    const calls: string[] = []
    const gw = new MockGateway({
      "shell.exec": p => {
        const cmd = String(p.command)
        calls.push(cmd)
        return { stdout: cmd.endsWith("list-archived") ? "dead-skill\n" : "ok", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Open />, { width: 130, height: 40, gw })
    await until(t, () => t.frame().includes("Archived     1"))
    await act(async () => { await t.keys.typeText("a") })
    act(() => {
      t.keys.pressEnter()
      t.keys.pressEnter()
    })
    await until(t, () => calls.some(c => c.includes("restore")))
    expect(calls.filter(c => c.includes("restore"))).toHaveLength(1)
    t.destroy()
  })

  test("no archived skills: 'a' hint hidden, no Archived row", async () => {
    const gw = new MockGateway({
      "shell.exec": () => ({ stdout: "", stderr: "", code: 0 }),
    })
    const t = await mountNode(<Open />, { width: 130, height: 40, gw })
    await until(t, () => t.frame().includes("Next run"))
    const f = t.frame()
    expect(f).not.toContain("Archived ")
    expect(f).not.toContain("a archived skills")
    t.destroy()
  })

  test("archived list failure is visible", async () => {
    const gw = new MockGateway({
      "shell.exec": p => {
        if (p.command === "hermes curator list-archived") throw new Error("archive list unavailable")
        return { stdout: "", stderr: "", code: 0 }
      },
    })
    const t = await mountNode(<Open />, { width: 130, height: 40, gw })
    await until(t, () => t.frame().includes("archive list unavailable"))
    t.destroy()
  })
})
