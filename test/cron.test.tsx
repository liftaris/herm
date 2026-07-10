import { describe, test, expect } from "bun:test"
import { act } from "react"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mountNode, until, MockGateway } from "./harness"
import { Cron } from "../src/tabs/Cron"
import { cronModel } from "../src/tabs/cron-model"

const HH = process.env.HERMES_HOME!
const iso = (dsec: number) => new Date(Date.now() + dsec * 1000).toISOString()
const ago = (s: number) => iso(-s)
const hence = (s: number) => iso(s)

const JOBS = [
  {
    job_id: "a1b2c3", name: "nightly-digest", schedule: "0 9 * * *",
    enabled: true, state: "scheduled", deliver: "discord",
    last_run_at: ago(3600), next_run_at: hence(7200),
    last_status: "ok", model: "claude-opus", workdir: "/tmp/proj",
    prompt: "Summarize yesterday's commits",
  },
  {
    job_id: "d4e5f6", name: "broken-job", schedule: "every 30m",
    enabled: true, state: "scheduled", deliver: "local",
    last_run_at: ago(600), next_run_at: hence(1200),
    last_status: "error", last_delivery_error: "timeout",
    prompt: "Fetch feed",
  },
  {
    job_id: "g7h8i9", name: "disabled-one", schedule: "every 1h",
    enabled: false, state: "scheduled", deliver: "local",
    paused_reason: "manual", prompt: "noop",
  },
]

const mk = () => new MockGateway({
  "cron.manage": (p) => p.action === "list" ? { jobs: JOBS } : { ok: true },
})

describe("Cron tab", () => {
  test("stale list response cannot replace a newer refresh", async () => {
    let stale!: (value: unknown) => void
    let lists = 0
    const gw = new MockGateway({
      "cron.manage": p => {
        if (p.action !== "list") return {}
        if (lists++ === 0) return { jobs: JOBS }
        if (lists === 2) return new Promise(resolve => { stale = resolve })
        return { jobs: [{ ...JOBS[0], name: "fresh-job" }] }
      },
    })
    await using t = await mountNode(<Cron focused />, { gw })
    await until(t, () => t.frame().includes("Cron Jobs (3)"))
    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => lists === 2)
    await act(async () => { await t.keys.typeText("r") })
    await until(t, () => t.frame().includes("fresh-job"))

    stale({ jobs: [{ ...JOBS[0], name: "stale-job" }] })
    await act(async () => { await Bun.sleep(0) })
    await t.settle()
    expect(t.frame()).toContain("fresh-job")
    expect(t.frame()).not.toContain("stale-job")
  })

  test("renders jobs with enabled/disabled glyphs and detail pane", async () => {
    await using t = await mountNode(<Cron focused />, { gw: mk() })
    await until(t, () => t.frame().includes("Cron Jobs (3)"))

    const f = t.frame()
    expect(f).toContain("● nightly-digest")
    expect(f).toContain("● broken-job")
    expect(f).toContain("○ disabled-one")
    expect(f).not.toMatch(/broken-job.*ERR/)
    expect(f).toContain("Model")
    expect(f).toContain("claude-opus")
    expect(f).toContain("Workdir")
    expect(f).toContain("/tmp/proj")
    expect(f).not.toContain("Skills")
    expect(f).toMatch(/Last Run\s+.*·\s+ok/)
  })

  test("down to disabled job shows paused_reason; next_run reads 'paused'", async () => {
    await using t = await mountNode(<Cron focused />, { gw: mk() })
    await until(t, () => t.frame().includes("Cron Jobs (3)"))

    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressArrow("down"))
    await until(t, () => t.frame().includes("g7h8i9"))

    const f = t.frame()
    expect(f).toMatch(/Paused\s+manual/)
    expect(f).toMatch(/Next Run\s+paused/)
    expect(f).not.toContain("claude-opus")
  })

  test("detail pane shows last-output tail; '(none yet)' otherwise", async () => {
    const dir = join(HH, "cron", "output", "a1b2c3")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "20260426_090000.md"), "## Digest\nitem one\nitem two")

    await using t = await mountNode(<Cron focused />, { gw: mk() })
    await until(t, () => t.frame().includes("Last Output"))
    await until(t, () => t.frame().includes("item two"))
    expect(t.frame()).toContain("## Digest")

    act(() => t.keys.pressArrow("down"))
    await until(t, () => /ID\s+d4e5f6/.test(t.frame()))
    await until(t, () => t.frame().includes("(none yet)"))
    expect(t.frame()).not.toContain("item two")
  })

  test("detail pane hidden below 120 cols", async () => {
    await using t = await mountNode(<Cron focused />, { gw: mk(), width: 110 })
    await until(t, () => t.frame().includes("Cron Jobs (3)"))
    expect(t.frame()).not.toContain("Job Detail")
  })

  const TIMING_JOBS = [
    { job_id: "j1", name: "nightly", schedule: "0 3 * * *", enabled: true,
      last_run_at: iso(-3600), next_run_at: iso(1800) },
    { job_id: "j2", name: "paused-job", schedule: "every 1h", enabled: false,
      last_run_at: iso(-120), next_run_at: iso(60) },
    { job_id: "j3", name: "overdue", schedule: "every 5m", enabled: true,
      next_run_at: iso(-30) },
  ]

  test("renders rows; next uses until() for future, 'due' for past, 'paused' when disabled", async () => {
    const gw = new MockGateway({ "cron.manage": () => ({ jobs: TIMING_JOBS }) })
    await using t = await mountNode(<Cron focused />, { gw, width: 180 })
    await until(t, () => t.frame().includes("Cron Jobs (3)"))

    const f = t.frame()
    const row = (name: string) => f.split("\n").find(l => /[●○]/.test(l) && l.includes(name))!

    expect(row("nightly")).toContain("last: 1h ago")
    expect(row("nightly")).toMatch(/next: in (29|30)m/)
    expect(row("paused-job")).toContain("next: paused")
    expect(row("overdue")).toContain("next: due")
    expect(row("nightly")).not.toContain("next: just now")
  })

  test("Space toggles enabled via cron.manage pause/resume", async () => {
    let paused = ""
    const gw = new MockGateway({
      "cron.manage": p => {
        if (p.action === "list") return { jobs: TIMING_JOBS }
        if (p.action === "pause" || p.action === "resume") { paused = `${p.action}:${p.name}`; return {} }
        return {}
      },
    })
    await using t = await mountNode(<Cron focused />, { gw, width: 180 })
    await until(t, () => t.frame().includes("nightly"))

    await act(async () => { await t.keys.typeText(" ") })
    await t.settle()
    expect(paused).toBe("pause:j1")
  })

  const ADV_JOB = {
    job_id: "adv1",
    name: "advanced",
    schedule: "every 1h",
    enabled: true,
    prompt_preview: "hello",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    base_url: "https://llm.example/v1",
    no_agent: true,
    attach_to_session: true,
    script: "jobs/ping.py",
    enabled_toolsets: ["web", "terminal"],
    repeat: "3 times",
  }

  test("normalizes and validates execution content", () => {
    expect(cronModel.normalize(ADV_JOB)).toMatchObject({
      id: "adv1",
      provider: "openrouter",
      base_url: "https://llm.example/v1",
      no_agent: true,
      attach_to_session: true,
      enabled_toolsets: ["web", "terminal"],
      repeat: "3 times",
    })
    expect(cronModel.validate({ ...cronModel.draft(), schedule: "every 1h" })).toBe("Agent jobs require a prompt, skill, or script")
    expect(cronModel.validate({ ...cronModel.draft(), schedule: "every 1h", no_agent: true })).toBe("No-agent jobs require a script")
    expect(cronModel.validate({ ...cronModel.draft(), schedule: "every 1h", skills: "one, two" })).toBeNull()
  })

  test("builds payloads with execution fields and clearable list fields", () => {
    const d = {
      ...cronModel.draft(cronModel.normalize(ADV_JOB)),
      context_from: "upstream-a, upstream-b",
      repeat: "3",
    }
    expect(cronModel.payload("add", d)).toMatchObject({
      action: "add",
      name: "advanced",
      schedule: "every 1h",
      prompt: "hello",
      deliver: "local",
      no_agent: true,
      attach_to_session: true,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      base_url: "https://llm.example/v1",
      script: "jobs/ping.py",
      enabled_toolsets: ["web", "terminal"],
      context_from: ["upstream-a", "upstream-b"],
      repeat: 3,
    })
    expect(cronModel.payload("update", { ...cronModel.draft(cronModel.normalize(ADV_JOB)), skills: "", enabled_toolsets: "" })).toMatchObject({
      action: "update",
      name: "adv1",
      skills: [],
      enabled_toolsets: [],
      attach_to_session: true,
    })
    const limited = cronModel.payload("update", d, { fields: new Set(["script"]) })
    expect(limited).toMatchObject({ action: "update", name: "adv1", script: "jobs/ping.py" })
    expect(limited).not.toHaveProperty("provider")
    expect(limited).not.toHaveProperty("no_agent")

    const cleared = cronModel.payload("update", {
      ...cronModel.draft(cronModel.normalize(ADV_JOB)),
      provider: "", model: "", base_url: "", script: "", workdir: "", repeat: "",
    })
    expect(cleared).toMatchObject({
      provider: "", model: "", base_url: "", script: "", workdir: "", repeat: 0,
    })
  })

  test("create opens editor and sends only basic fields when gateway lacks advanced support", async () => {
    const calls: Record<string, unknown>[] = []
    const gw = new MockGateway({
      "cron.manage": p => {
        calls.push(p)
        if (p.action === "list") return { jobs: [] }
        return { ok: true }
      },
    })
    await using t = await mountNode(<Cron focused />, { gw })
    await until(t, () => t.frame().includes("No cron jobs"))

    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Cron Job"))
    expect(t.frame()).toContain("Current gateway only accepts name, schedule, and prompt")
    expect(t.frame()).not.toContain("No Agent")
    expect(t.frame()).not.toContain("Provider")
    await act(async () => { await t.keys.typeText("every 5m") })
    act(() => t.keys.pressEnter())
    await act(async () => { await t.keys.typeText("say hi") })
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => calls.some(c => c.action === "add"))

    expect(calls.find(c => c.action === "add")).toMatchObject({ action: "add", name: "", schedule: "every 5m", prompt: "say hi" })
    expect(calls.find(c => c.action === "add")).not.toHaveProperty("no_agent")
    expect(calls.find(c => c.action === "add")).not.toHaveProperty("attach_to_session")
  })

  test("create exposes advanced fields when gateway advertises them", async () => {
    const gw = new MockGateway({
      "cron.manage": p => p.action === "list"
        ? { jobs: [], fields: ["script", "provider", "model", "repeat"] }
        : { ok: true },
    })
    await using t = await mountNode(<Cron focused />, { gw })
    await until(t, () => t.frame().includes("No cron jobs"))

    await act(async () => { await t.keys.typeText("n") })
    await until(t, () => t.frame().includes("New Cron Job"))

    expect(t.frame()).toContain("Script")
    expect(t.frame()).toContain("Provider")
    expect(t.frame()).toContain("Model")
    expect(t.frame()).toContain("Repeat")
    expect(t.frame()).not.toContain("No agent")
  })

  test("detail panel displays upstream execution fields from list output", async () => {
    const gw = new MockGateway({
      "cron.manage": p => p.action === "list" ? { jobs: [ADV_JOB] } : { ok: true },
    })
    await using t = await mountNode(<Cron focused />, { gw, width: 160, height: 40 })
    await until(t, () => t.frame().includes("Job Detail"))

    expect(t.frame()).toContain("Provider")
    expect(t.frame()).toContain("openrouter")
    expect(t.frame()).toContain("Base URL")
    expect(t.frame()).toContain("No Agent")
    expect(t.frame()).toContain("Attach")
    expect(t.frame()).toContain("Session")
    expect(t.frame()).toContain("Toolsets")
    expect(t.frame()).toContain("web, terminal")
    expect(t.frame()).toContain("Repeat")
  })

  test("advanced editor sends update when gateway advertises update support", async () => {
    const calls: Record<string, unknown>[] = []
    const gw = new MockGateway({
      "cron.manage": p => {
        calls.push(p)
        if (p.action === "list") return { jobs: [ADV_JOB], actions: ["update"], fields: ["script", "no_agent", "attach_to_session"] }
        return { ok: true }
      },
    })
    await using t = await mountNode(<Cron focused />, { gw })
    await until(t, () => t.frame().includes("Cron Jobs (1)"))

    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Edit Cron Job"))
    act(() => t.keys.pressEnter({ ctrl: true }))
    await until(t, () => calls.some(c => c.action === "update"))

    expect(calls.find(c => c.action === "update")).toMatchObject({
      action: "update",
      name: "adv1",
      schedule: "every 1h",
      no_agent: true,
      attach_to_session: true,
    })
  })

  test("advanced editor is read-only for existing jobs without update support", async () => {
    const calls: Record<string, unknown>[] = []
    const gw = new MockGateway({
      "cron.manage": p => {
        calls.push(p)
        if (p.action === "list") return { jobs: [ADV_JOB] }
        return { ok: true }
      },
    })
    await using t = await mountNode(<Cron focused />, { gw })
    await until(t, () => t.frame().includes("Cron Jobs (1)"))

    act(() => t.keys.pressEnter())
    await t.settle()

    expect(t.frame()).not.toContain("Edit Cron Job")
    expect(calls.filter(c => c.action !== "list")).toEqual([])
  })
})
