import { platform } from "os"
import type { ToastContext } from "../ui/toast"

// Terminals known to correctly implement OSC 52 clipboard writes. On these,
// firing a native tool (wl-copy/xclip/pbcopy) alongside OSC 52 races the
// terminal's own clipboard write and can corrupt it — wl-copy on Wayland
// in particular forks a daemon whose write stacks with the terminal's own
// OSC 52 handling (~30% empty-clipboard rate reported on Ghostty + Wayland;
// symptom: Ctrl+Shift+C works on the 3rd attempt).
//
// Conservative list (matches upstream hermes-ink): terminals with flaky or
// disabled-by-default OSC 52 (iTerm2, Alacritty) are NOT on this list; users
// there keep the existing behaviour where native fires alongside OSC 52.
const OSC52_CAPABLE = ["ghostty", "kitty", "WezTerm", "windows-terminal", "vscode"]

function detect(): string | null {
  const env = process.env
  if (env.CURSOR_TRACE_ID) return "cursor"
  if (env.TERM === "xterm-ghostty") return "ghostty"
  if (env.TERM?.includes("kitty")) return "kitty"
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM
  if (env.TMUX) return "tmux"
  if (env.STY) return "screen"
  if (env.KITTY_WINDOW_ID) return "kitty"
  if (env.WT_SESSION) return "windows-terminal"
  return env.TERM ?? null
}

const terminal = detect()

export function supportsOsc52Clipboard(t: string | null = terminal): boolean {
  return OSC52_CAPABLE.includes(t ?? "")
}

/**
 * Decide whether copy() should also fire a native clipboard tool alongside
 * OSC 52. Default is "yes, native fires" — it's the historical safety net
 * for terminals where OSC 52 coverage is patchy. Suppress when:
 *
 *  1. SSH — native tools would write to the remote machine's clipboard;
 *     OSC 52 (travelling back over the pty to the local terminal) is the
 *     right path.
 *
 *  2. Allowlisted OSC-52-capable terminal AND not inside tmux/screen. On
 *     these terminals the OSC 52 write is reliable on its own, and racing
 *     it with a native tool is destructive.
 *
 *     The TMUX/STY guard matters: detect() prefers TERM_PROGRAM over TMUX,
 *     so a tmux session inside Ghostty reports terminal='ghostty'. But
 *     inside tmux we rely on tmux passthrough (which depends on the user's
 *     `allow-passthrough`/`set-clipboard` config), so keep native as a
 *     safety net there.
 */
export function shouldUseNativeClipboard(env: NodeJS.ProcessEnv = process.env, t: string | null = terminal): boolean {
  if (env.SSH_CONNECTION) return false
  if (env.TMUX || env.STY) return true
  if (!process.stdout.isTTY) return true
  return !supportsOsc52Clipboard(t)
}

/**
 * Writes text to clipboard via OSC 52 escape sequence.
 * Works over SSH by having the terminal emulator handle it locally.
 */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const pass = process.env["TMUX"] || process.env["STY"]
  const seq = pass ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
  process.stdout.write(seq)
}

async function nativeCopy(text: string): Promise<void> {
  const os = platform()

  if (os === "darwin") {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" })
    proc.stdin.write(text)
    proc.stdin.end()
    await proc.exited
    return
  }

  if (os === "linux") {
    if (process.env["WAYLAND_DISPLAY"]) {
      try {
        const proc = Bun.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited
        return
      } catch {}
    }
    try {
      const proc = Bun.spawn(["xclip", "-selection", "clipboard"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
      proc.stdin.write(text)
      proc.stdin.end()
      await proc.exited
      return
    } catch {}
    try {
      const proc = Bun.spawn(["xsel", "--clipboard", "--input"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
      proc.stdin.write(text)
      proc.stdin.end()
      await proc.exited
      return
    } catch {}
  }
}

export async function copy(text: string): Promise<void> {
  writeOsc52(text)
  if (shouldUseNativeClipboard()) {
    await nativeCopy(text).catch(() => {})
  }
}

function copied(toast: ToastContext, message = "Copied to clipboard"): void {
  toast.show({ key: "clipboard.copy", variant: "success", message })
}

export function copyText(text: string, toast?: ToastContext, message = "Copied to clipboard"): Promise<void> {
  const p = copy(text)
  if (toast) copied(toast, message)
  return p
}

export function copySelection(renderer: { getSelection: () => { getSelectedText: () => string } | null; clearSelection: () => void }, toast?: ToastContext): boolean {
  const sel = renderer.getSelection()
  const text = sel?.getSelectedText()
  if (!text) return false

  copyText(text, toast).catch(() => {})
  renderer.clearSelection()
  return true
}

export * as Clipboard from "./clipboard"
