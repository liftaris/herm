import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { RGBA } from "@opentui/core"
import { mount, mountNode } from "./harness"
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
