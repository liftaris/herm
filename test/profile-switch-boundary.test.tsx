import { describe, expect, test } from "bun:test"
import { act } from "react"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mount, until, MockGateway } from "./harness"
import { rehome } from "../src/home/rehome"
import type { HermPlugin } from "../src/plugins/types"

const base = () => join(process.env.HOME || homedir(), ".hermes")

type Fx = {
  root: string
  coder: string
  home?: string
  cfg?: string
}

function write(root: string, rel: string, body: string) {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

function profile(root: string, name: string) {
  const dir = name === "default" ? root : join(root, "profiles", name)
  mkdirSync(join(dir, "skills"), { recursive: true })
  write(dir, "config.yaml", "model:\n  default: test-model\n  provider: test\n")
  write(dir, "SOUL.md", `${name} soul\n`)
  return dir
}

function setup(): Fx {
  const fx = {
    root: mkdtempSync(join(tmpdir(), "herm-profile-boundary-")),
    coder: "",
    home: process.env.HERMES_HOME,
    cfg: process.env.HERM_CONFIG_DIR,
  }
  profile(fx.root, "default")
  fx.coder = profile(fx.root, "coder")
  write(fx.root, "herm/tui.json", JSON.stringify({ plugin: { enabled: { "profile.switch": true } } }))
  write(fx.coder, "herm/tui.json", JSON.stringify({ plugin: { enabled: { "profile.switch": false } } }))
  delete process.env.HERM_CONFIG_DIR
  rehome(fx.root)
  return fx
}

function restore(fx: Fx) {
  if (fx.cfg) process.env.HERM_CONFIG_DIR = fx.cfg
  else delete process.env.HERM_CONFIG_DIR
  rehome(fx.home ?? base())
  if (!fx.home) delete process.env.HERMES_HOME
  rmSync(fx.root, { recursive: true, force: true })
}

function catalog() {
  return { pairs: [["/profiles", "Profiles"]] }
}

function cfg() {
  return {
    home: process.env.HERMES_HOME,
    display: process.env.HERMES_HOME?.endsWith("/profiles/coder") ? "coder" : "default",
  }
}

async function openProfiles(t: Awaited<ReturnType<typeof mount>>) {
  await act(async () => { await t.keys.typeText("/profiles") })
  act(() => t.keys.pressEnter())
  await until(t, () => t.frame().includes("Profiles (2)"))
}

async function switchToCoder(t: Awaited<ReturnType<typeof mount>>) {
  await openProfiles(t)
  act(() => t.keys.pressArrow("down"))
  await until(t, () => t.frame().includes("coder"))
  await act(async () => { await t.keys.typeText("s") })
  await until(t, () => t.frame().includes("Switch to 'coder'?"))
  await act(async () => { await t.keys.typeText("y") })
}

describe("profile switch runtime boundary", () => {
  test("remounts profile-owned providers and respects the new profile preferences", async () => {
    const fx = setup()
    let aborts = 0
    let boots = 0
    let kills = 0
    const plugin: HermPlugin = {
      id: "profile.switch",
      enabled: false,
      tui(api) {
        api.lifecycle.signal.addEventListener("abort", () => { aborts++ })
        api.route.register([{ name: "OldPlugin", render: () => <text>old plugin body</text> }])
      },
    }
    const gw = new MockGateway({
      "commands.catalog": catalog,
      "config.get": p => p.key === "profile" ? cfg() : p.key === "busy" ? { value: "queue" } : { config: {} },
      "session.create": () => ({ session_id: `sid-${++boots}` }),
    })
    const start = gw.start.bind(gw)
    const kill = gw.kill.bind(gw)
    gw.start = () => { start() }
    gw.kill = () => { kills++; kill() }

    try {
      await using t = await mount({ gw, plugins: [plugin], launch: { mode: "new", splash: false }, width: 200 })
      await until(t, () => t.frame().includes("Ready") && t.frame().includes("OldPlugin"))
      expect(boots).toBe(1)

      await switchToCoder(t)
      await until(t, () => process.env.HERMES_HOME === fx.coder && boots === 2 && t.frame().includes("Ready"))

      expect(aborts).toBeGreaterThan(0)
      expect(kills).toBeGreaterThan(0)
      expect(t.frame()).not.toContain("OldPlugin")
      await act(async () => { await t.keys.typeText("new profile prompt") })
      act(() => t.keys.pressEnter())
      await until(t, () => gw.last("prompt.submit")?.params.text === "new profile prompt")
      expect(gw.last("prompt.submit")?.params.session_id).toBe("sid-2")
    } finally {
      restore(fx)
    }
  })

  test("failed post-switch boot leaves a fresh new-profile runtime", async () => {
    const fx = setup()
    let aborts = 0
    let boots = 0
    const plugin: HermPlugin = {
      id: "profile.switch",
      enabled: false,
      tui(api) {
        api.lifecycle.signal.addEventListener("abort", () => { aborts++ })
        api.route.register([{ name: "OldPlugin", render: () => <text>old plugin body</text> }])
      },
    }
    const gw = new MockGateway({
      "commands.catalog": catalog,
      "config.get": p => p.key === "profile" ? cfg() : p.key === "busy" ? { value: "queue" } : { config: {} },
      "session.create": () => {
        boots++
        if (boots === 1) return { session_id: "sid-old" }
        throw new Error("boot exploded")
      },
    })

    try {
      await using t = await mount({ gw, plugins: [plugin], launch: { mode: "new", splash: false }, width: 200 })
      await until(t, () => t.frame().includes("Ready") && t.frame().includes("OldPlugin"))

      await switchToCoder(t)
      await until(t, () => process.env.HERMES_HOME === fx.coder && t.frame().includes("Failed to start session: boot exploded"))

      expect(aborts).toBeGreaterThan(0)
      expect(t.frame()).not.toContain("OldPlugin")
      await act(async () => { await t.keys.typeText("should not submit") })
      act(() => t.keys.pressEnter())
      await t.settle()
      expect(gw.calls.filter(c => c.method === "prompt.submit")).toHaveLength(0)
    } finally {
      restore(fx)
    }
  })
})
