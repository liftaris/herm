import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { RGBA } from "@opentui/core"
import { mount, mountNode, until } from "./harness"
import base from "../src/theme/themes/default.json"
import { useTheme, ThemeProvider } from "../src/theme"
import { configDir } from "../src/utils/paths"
import { KeysProvider } from "../src/keys"
import { TabBar } from "../src/components/tabs/TabBar"
import * as prefs from "../src/context/preferences"

const writeTheme = (name: string, menu?: string) => {
  const dir = join(configDir(), "themes")
  mkdirSync(dir, { recursive: true })
  const json = menu
    ? { ...base, theme: { ...base.theme, backgroundMenu: menu } }
    : base
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(json, null, 2))
}

function Probe(props: { seen: (v: { names: readonly string[]; mode: string }) => void }) {
  const theme = useTheme()
  props.seen({ names: theme.names, mode: theme.mode })
  return <box><text>{`${theme.name}:${theme.mode}`}</text></box>
}

describe("user themes", () => {
  test("ThemeProvider includes themes dropped in configDir/themes", async () => {
    writeTheme("local-tango")
    let seen!: { names: readonly string[]; mode: string }
    const t = await mountNode(<Probe seen={v => { seen = v }} />)

    expect(seen.names).toContain("local-tango")
    t.destroy()
  })

  test("preference reload refreshes themes when the saved name is unchanged", async () => {
    const prior = { home: process.env.HERMES_HOME, cfg: process.env.HERM_CONFIG_DIR }
    const a = mkdtempSync(join(tmpdir(), "herm-theme-a-"))
    const b = mkdtempSync(join(tmpdir(), "herm-theme-b-"))
    let t: Awaited<ReturnType<typeof mountNode>> | undefined
    try {
      delete process.env.HERM_CONFIG_DIR
      for (const [root, name] of [[a, "alpha-theme"], [b, "beta-theme"]] as const) {
        const dir = join(root, "herm")
        mkdirSync(join(dir, "themes"), { recursive: true })
        writeFileSync(join(dir, "tui.json"), JSON.stringify({ theme: "default" }))
        writeFileSync(join(dir, "themes", `${name}.json`), JSON.stringify(base))
      }
      process.env.HERMES_HOME = a
      prefs.reload()
      let names: readonly string[] = []
      t = await mountNode(<Probe seen={v => { names = v.names }} />)
      expect(names).toContain("alpha-theme")

      process.env.HERMES_HOME = b
      prefs.reload()
      await until(t, () => names.includes("beta-theme"))
      expect(names).not.toContain("alpha-theme")
    } finally {
      t?.destroy()
      if (prior.home === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = prior.home
      if (prior.cfg === undefined) delete process.env.HERM_CONFIG_DIR
      else process.env.HERM_CONFIG_DIR = prior.cfg
      prefs.reload()
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  test("themeMode preference selects the resolver mode", async () => {
    prefs.set("themeMode", "light")
    let seen!: { names: readonly string[]; mode: string }
    const t = await mountNode(<Probe seen={v => { seen = v }} />)

    expect(seen.mode).toBe("light")
    t.destroy()
  })

  test("/theme light persists themeMode", async () => {
    const t = await mount()

    await t.settle()
    await act(async () => { await t.keys.typeText("/theme light") })
    await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()
    act(() => t.keys.pressEnter()); await t.settle()

    expect(prefs.get("themeMode")).toBe("light")
    t.destroy()
  })

  test("top tab bar paints the theme menu rail", async () => {
    writeTheme("menu-rail", "#123456")
    prefs.set("theme", "menu-rail")
    prefs.set("themeMode", "dark")
    const setup = await testRender(
      <ThemeProvider>
        <KeysProvider>
          <TabBar
            tabs={[
              { name: "Chat", description: "Chat" },
              { name: "Sessions", description: "Sessions" },
            ]}
            activeTab={0}
            onTabChange={() => {}}
          />
        </KeysProvider>
      </ThemeProvider>,
      { width: 80, height: 4, exitOnCtrlC: false, kittyKeyboard: true },
    )

    await act(async () => { await setup.renderOnce() })
    const menu = RGBA.fromHex("#123456")
    expect(setup.captureSpans().lines[0].spans.some(s =>
      s.text.includes("Sessions") && s.bg.equals(menu),
    )).toBe(true)
    setup.renderer.destroy()
  })
})
