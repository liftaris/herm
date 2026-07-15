// Single exit path. Latched so a double keypress or an exit racing a
// signal can't re-enter renderer.destroy() (OpenTUI is not idempotent
// there — second call throws on a disposed native handle).
//
// The resume banner writes *after* renderer.destroy() has left the alt
// screen (?1049l) so it lands on the primary scrollback the user
// actually returns to. terminal-reset's `exit` hook then flushes the
// mode-reset blob synchronously on process.exit().
//
// Parity: opencode context/exit.tsx — minus onBeforeExit/onExit (no
// plugin runtime) and the win32 input-buffer flush (tracked as a bead).

import { writeSync } from "node:fs"

let done = false

export function quit(
  renderer: { destroy: () => void; setTerminalTitle: (t: string) => void },
  sid?: string,
  title?: string,
  gw?: { kill: () => void },
): never {
  if (done) process.exit(0)
  done = true
  // Explicit SIGTERM to the gateway so its signal handler runs the
  // graceful sys.exit(0) → atexit → _shutdown_sessions path inside the
  // grace window. Without this we rely on stdin EOF, which works, but
  // the explicit signal starts cleanup sooner and matches Ink TUI's
  // setupGracefulExit cleanup.
  try { gw?.kill() } catch {}
  try { renderer.setTerminalTitle("") } catch {}
  renderer.destroy()
  if (process.stdout.isTTY) {
    const banner = sid
      ? `\n  continue  herm --resume ${sid}${title ? `  —  ${title.slice(0, 60)}` : ""}\n\n`
      : `\n  bye\n\n`
    writeSync(1, banner)
  }
  process.exit(0)
}
