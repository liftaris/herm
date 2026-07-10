import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { act } from "react"
import { mount, until, MockGateway } from "./harness"
import * as prefs from "../src/context/preferences"
import { fallbacks, matchSub } from "../src/app/slashCommands"
import { configDir } from "../src/utils/paths"
import base from "../src/theme/themes/default.json"

const type = async (t: Awaited<ReturnType<typeof mount>>, s: string) => {
  await act(async () => { await t.keys.typeText(s) })
  await t.settle()
  // First Enter accepts the subcommand-popover entry (writes `/skin X `),
  // second submits. No-arg / unknown-arg have no popover, first submits.
  act(() => t.keys.pressEnter()); await t.settle()
  act(() => t.keys.pressEnter()); await t.settle()
}

const local = (name: string) => {
  mkdirSync(join(process.env.HERMES_HOME!, "skins"), { recursive: true })
  writeFileSync(join(process.env.HERMES_HOME!, "skins", `${name}.yaml`), `name: ${name}\ndescription: test skin\n`)
  mkdirSync(join(configDir(), "themes"), { recursive: true })
  writeFileSync(join(configDir(), "themes", `${name}.json`), JSON.stringify(base, null, 2))
}

describe("/skin", () => {
  test("with arg: writes gateway config, applies theme, clears eikon pref", async () => {
    prefs.set("theme", "tokyonight")
    prefs.set("eikon", "manual")

    const gw = new MockGateway()
    gw.on$("config.set", p => {
      if (p.key === "skin")
        queueMicrotask(() => gw.push({ type: "skin.changed",
          payload: { name: String(p.value), colors: {}, branding: {} } }))
      return { value: String(p.value) }
    })

    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await type(t, "/skin ares")
    await until(t, () => t.frame().includes("skin → ares"))

    const call = gw.last("config.set")!
    expect(call.params.key).toBe("skin")
    expect(call.params.value).toBe("ares")
    expect(prefs.get("theme")).toBe("ares")
    expect(prefs.get("eikon")).toBeUndefined()

    await type(t, "/skin default")
    await until(t, () => t.frame().includes("skin → default"))
    expect(prefs.get("theme")).toBe("default")

    t.destroy()
  })

  test("no arg: prints current + list, no config.set", async () => {
    const gw = new MockGateway()
    gw.push({ type: "skin.changed", payload: { name: "mono", colors: {}, branding: {} } })
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await type(t, "/skin")
    await until(t, () => t.frame().includes("skin: mono"))
    expect(t.frame()).toMatch(/default.*ares.*mono.*slate/)
    expect(gw.last("config.set")).toBeUndefined()
    t.destroy()
  })

  test("unknown name → error toast, no write", async () => {
    const gw = new MockGateway()
    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await type(t, "/skin bogus")
    await until(t, () => t.frame().includes("unknown skin: bogus"))
    expect(gw.last("config.set")).toBeUndefined()
    t.destroy()
  })

  test("user skin YAML is accepted by /skin", async () => {
    const dir = join(process.env.HERMES_HOME!, "skins")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "local-tango.yaml"), "name: local-tango\ndescription: test skin\n")

    const gw = new MockGateway()
    gw.on$("config.set", p => {
      if (p.key === "skin")
        queueMicrotask(() => gw.push({ type: "skin.changed",
          payload: { name: String(p.value), colors: {}, branding: {} } }))
      return { value: String(p.value) }
    })

    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await act(async () => { await t.keys.typeText("/skin local-tango") })
    await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    await until(t, () => t.frame().includes("skin → local-tango"))

    const call = gw.last("config.set")!
    expect(call.params.key).toBe("skin")
    expect(call.params.value).toBe("local-tango")
    t.destroy()
  })

  test("light skin switches resolver mode to light", async () => {
    local("tango-light")
    prefs.set("themeMode", "dark")

    const gw = new MockGateway()
    gw.on$("config.set", p => {
      if (p.key === "skin")
        queueMicrotask(() => gw.push({ type: "skin.changed",
          payload: { name: String(p.value), colors: {}, branding: {} } }))
      return { value: String(p.value) }
    })

    const t = await mount({ gw })
    await until(t, () => t.frame().includes("Ready"))

    await type(t, "/skin tango-light")
    await until(t, () => t.frame().includes("skin → tango-light"))

    expect(prefs.get("theme")).toBe("tango-light")
    expect(prefs.get("themeMode")).toBe("light")
    t.destroy()
  })

  test("subcommand completion surfaces SKINS", () => {
    const m = matchSub(fallbacks(), "/skin po")
    expect(m?.map(c => c.name)).toEqual(["skin poseidon"])
  })

  test("subcommand completion reads user skins at call time", () => {
    local("zeta-skin")
    const m = matchSub(fallbacks(), "/skin ze")
    expect(m?.map(c => c.name)).toEqual(["skin zeta-skin"])
  })
})
