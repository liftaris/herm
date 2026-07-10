#!/usr/bin/env bun
// NOTE: CPU usage at idle (~40-80% of one core) comes from OpenTUI's render loop,
// not React's scheduler. The TUI framework renders frames at targetFps (30) to the
// terminal, which is an inherent cost of continuous TUI rendering. The scheduler
// override (MessageChannel/setImmediate = undefined) was a red herring — verified
// via per-thread profiling that the main JS thread drives the render loop.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { parseLaunch, HELP, VERSION } from "./app/launch";
import { handleEikonCli } from "./app/eikon-cli";
import * as perf from "./utils/perf";
import { warm as warmIO } from "./io";
import { skills } from "./service/bundled-skills";
import { plugins } from "./service/bundled-plugins";
import * as control from "./app/control";
import * as preferences from "./context/preferences";
import { resetTerminalModes, installExitResetHooks } from "./utils/terminal-reset";
import { clampStdoutDimensions } from "./utils/terminal-size";
import { warmup as warmTokens } from "./utils/tokens";
import { prime as primeTheme, DEFAULT_THEME } from "./theme";
import { resolveProfileHome } from "./service/hermes-profiles";
import { rehome } from "./home/rehome";

// Static ESM imports hoist above module-level code, so the only
// honest import-graph measurement is process-uptime at the point
// this line actually runs. Captured once; reported by perf.boot().
perf.boot("import-graph", Bun.nanoseconds() / 1e6)

const argv = Bun.argv.slice(2)
if (argv[0] === "eikon" && argv[1] === "install") plugins.sync()
const eikonCliExit = await handleEikonCli(argv)
if (eikonCliExit !== null) process.exit(eikonCliExit)
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(VERSION + "\n")
  process.exit(0)
}
const launch = parseLaunch(argv)
if (launch.profile) {
  const home = resolveProfileHome(launch.profile)
  if (!home) throw new Error(`profile not found: ${launch.profile}`)
  rehome(home)
}

// Initialize and render
const main = async () => {
  // Self-heal a tab that a prior crashed TUI left with mouse / focus
  // / bracketed-paste / kitty-keyboard modes stuck on. @opentui/core
  // only resets ?1049 (alt-screen), so without this the composer
  // gets poisoned by raw escape sequences on startup.
  resetTerminalModes()
  // And on our own exit paths, so we don't poison the next process.
  installExitResetHooks()
  clampStdoutDimensions()

  perf.mem("pre-renderer")

  const prefs = preferences.load()

  const end = perf.mark("renderer-init")
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // We handle Ctrl+C ourselves
    useMouse: prefs.mouse ?? true,
    targetFps: prefs.targetFps ?? 30,
    gatherStats: false,
  });
  // Multi-pane screens legitimately mount more than EventEmitter's default
  // ten selection-aware scrollboxes. Set the budget before React subscribes.
  renderer.setMaxListeners(64)
  end()

  // OpenTUI's setupTerminal emits CSI >4;1m (modifyOtherKeys=1), then
  // upgrades to kitty (CSI >4;0m + CSI >{flags}u) only if the async
  // CSI ?u probe gets a reply. Level 1 does NOT disambiguate Ctrl+digit
  // — they arrive as legacy control bytes (Ctrl+2=NUL, Ctrl+3=ESC,
  // Ctrl+4=FS…) so `key.ctrl` is never true and tab-jump is dead on
  // terminals without kitty support. Level 2 encodes every modified key
  // as CSI 27;m;c~ which parseKeypress handles. setupTerminal is awaited
  // inside createCliRenderer, so >4;1m is already out; this lands after.
  // If kitty detection later fires, its >4;0m overrides this — harmless.
  // Re-asserted on focus since a suspended child may have reset modes.
  const bump = () => renderer.capabilities?.kitty_keyboard
    || (process.stdout.isTTY && process.stdout.write("\x1b[>4;2m"))
  bump()
  renderer.on("focus", bump)

  perf.mem("post-renderer")

  // Theme JSONs load lazily (src/theme/load.ts). Prime the active
  // theme here so the first frame has its colors — otherwise the
  // provider falls back to DEFAULT_THEME for one tick while the
  // import() resolves.
  await primeTheme(prefs.theme ?? DEFAULT_THEME)

  const root = createRoot(renderer);

  const endRender = perf.mark("first-render")
  root.render(<App initialTheme={prefs.theme} launch={launch} />);
  endRender()
  perf.boot("first-render", Bun.nanoseconds() / 1e6)

  // gpt-tokenizer is ~170ms to import and not needed for first frame;
  // kick it off the hot path so the first count() call doesn't stall.
  warmTokens()
  warmIO()
  // First-launch copies only; steady state is two existsSync per
  // bundled skill/plugin. Off the first-render path so a slow fs doesn't
  // delay the frame.
  skills.sync()
  plugins.sync()

  perf.mem("post-first-render")

  // Periodic memory monitor (every 15s when PERF=1)
  perf.monitor(15_000)

  // Control server for headless interaction (CONTROL=1)
  control.start()
};

main().catch(console.error);

export {};
