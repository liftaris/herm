import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { installReloadSignal, RELOAD_SIGNAL } from "../src/app/reloadSignal"
import * as prefs from "../src/context/preferences"

// Contract: a desktop theme switch rewrites tui.json (and drops a theme into
// <configDir>/themes) underneath an already-running Herm, then signals it.
// The process must pick the new preferences up without relaunching. The fault
// this detects is the signal handler going missing — after which desktop theme
// sync silently stops working, and, because SIGUSR2's default disposition is
// Term, the same hook starts killing live sessions instead.
test("SIGUSR2 re-reads tui.json in a running process", () => {
  const prior = { home: process.env.HERMES_HOME, cfg: process.env.HERM_CONFIG_DIR }
  const root = mkdtempSync(join(tmpdir(), "herm-reload-signal-"))
  let uninstall: (() => void) | undefined
  try {
    delete process.env.HERM_CONFIG_DIR
    process.env.HERMES_HOME = root
    const dir = join(root, "herm")
    mkdirSync(dir, { recursive: true })

    writeFileSync(join(dir, "tui.json"), JSON.stringify({ theme: "nord" }))
    prefs.reload()
    expect(prefs.get("theme")).toBe("nord")

    const before = process.listenerCount(RELOAD_SIGNAL)
    uninstall = installReloadSignal()
    // Registering any handler is what displaces the default Term disposition.
    expect(process.listenerCount(RELOAD_SIGNAL)).toBe(before + 1)

    writeFileSync(join(dir, "tui.json"), JSON.stringify({ theme: "gruvbox" }))
    expect(prefs.get("theme")).toBe("nord")

    process.emit(RELOAD_SIGNAL)
    expect(prefs.get("theme")).toBe("gruvbox")

    uninstall()
    uninstall = undefined
    expect(process.listenerCount(RELOAD_SIGNAL)).toBe(before)
  } finally {
    uninstall?.()
    if (prior.home === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = prior.home
    if (prior.cfg === undefined) delete process.env.HERM_CONFIG_DIR
    else process.env.HERM_CONFIG_DIR = prior.cfg
    prefs.reload()
    rmSync(root, { recursive: true, force: true })
  }
})
