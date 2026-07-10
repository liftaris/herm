// bun test preload — isolate filesystem side effects.
// Runs before any src/ module import, so module-level const paths
// (preferences.ts, hermes-home.ts) resolve to the sandbox.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach } from "bun:test"
import { getTreeSitterClient } from "@opentui/core"

const root = mkdtempSync(join(tmpdir(), "herm-test-"))
const cfg = join(root, "config")

process.env.HERM_CONFIG_DIR = cfg
process.env.HERMES_HOME = join(root, "hermes")
process.env.HERMES_AGENT_ROOT = join(root, "agent")
process.env.HERM_IO_INLINE = "1"
process.env.CONTROL = ""
process.env.PERF = ""

// OpenTUI's own Markdown.test.ts pattern: one TreeSitterClient for the
// whole suite, created in beforeAll, destroyed in afterAll. Under bun
// test every t.destroy() drops rendererTracker's set to 0, which
// destroys + re-singletons the client — ~16 worker spawn/terminate
// cycles per run. Bun 1.3.x segfaults in the worker's node:module
// bootstrap (generateNativeModule_NodeModule → getPropertySlot @ 0x5,
// oven-sh/bun#19650/#27463) under that churn. Seed the singleton once
// and pin a sentinel in the tracker so size never hits 0; the single
// worker lives for the process and tears down with it.
await getTreeSitterClient().initialize()
const bag = (globalThis as Record<symbol, unknown>)[Symbol.for("@opentui/core/singleton")] as
  { RendererTracker?: { renderers?: Set<unknown> } }
bag.RendererTracker?.renderers?.add({})

// Theme bodies load lazily in prod (src/theme/load.ts). Prime the default
// so ThemeProvider paints on the first frame in every test mount, matching
// src/index.tsx's boot sequence.
const { prime, DEFAULT_THEME } = await import("../src/theme")
await prime(DEFAULT_THEME)

// tips.ts scrapes <agent>/hermes_cli/tips.py at first call and caches
// module-level. Provide a fixture so loadTips() exercises the scraper
// (not FALLBACK) on machines without a real hermes-agent checkout.
mkdirSync(join(root, "agent", "hermes_cli"), { recursive: true })
writeFileSync(join(root, "agent", "hermes_cli", "tips.py"), `\
TIPS = [
    "/model <name> switches the active model.",
    "/title \\"my project\\" names the session.",
    "@file:path injects file contents.",
    "Ctrl+G opens $EDITOR.",
    "Click a user message to rewind.",
    "\`/new\` starts a fresh session.",
    "Ctrl+Z suspends to the shell; \`fg\` resumes.",
    "Pasting 5+ lines collapses to a placeholder.",
    "/keys opens the keybinding editor.",
    "/compress shrinks the context window.",
    "/help lists all slash commands.",
    "/fast toggles the speed model.",
]
`)

// The home store is a module-level singleton. Any mount() that renders a
// useHome() consumer caches slices against whatever the sandbox held at
// that moment, and later files that write fixtures see stale values.
// Reset it between tests. Dynamic import because a static one would be
// hoisted above the env assignments and resolve hermesPath to ~/.hermes.
afterEach(async () => {
  const { home } = await import("../src/home/store")
  home.close()
  // preferences.ts is likewise a module singleton backed by a file in
  // the sandbox; tests that set() a key (e.g. keys.test, app rebind test)
  // would otherwise leak overrides into later tests via disk.
  const prefs = await import("../src/context/preferences")
  prefs.reset()
  rmSync(join(cfg, "tui.json"), { force: true })
})

// AnimatedAvatar ticks via setTimeout outside act() — harmless, but noisy.
const err = console.error
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("not wrapped in act")) return
  err(...args)
}
