/**
 * Live config reload on SIGUSR2.
 *
 * Desktop environments retint a running TUI by signalling it rather than
 * restarting it — Omarchy drives opencode (`killall -SIGUSR2 opencode`),
 * btop and helix exactly this way. Herm already has every piece needed to
 * take part: `preferences.reload()` re-reads tui.json and bumps `rev`, and
 * ThemeProvider re-scans `userThemes()` from disk whenever `rev` changes.
 * This wires the signal to that path so a theme written into
 * `<configDir>/themes/` lands without relaunching the session.
 *
 * Registering a handler also replaces SIGUSR2's default disposition, which
 * is Term — so a desktop hook that signals Herm can no longer kill the
 * user's session on a build that predates this.
 */

import * as preferences from "../context/preferences"

/** The signal desktop environments send to ask a TUI to re-read its config. */
export const RELOAD_SIGNAL = "SIGUSR2" as const

/** Start listening for reload signals. Returns an uninstall function. */
export function installReloadSignal(): () => void {
  const onReload = () => preferences.reload()
  process.on(RELOAD_SIGNAL, onReload)
  return () => { process.off(RELOAD_SIGNAL, onReload) }
}
