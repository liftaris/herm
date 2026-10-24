// Open files and URLs in the OS default handler. Fire-and-forget.
// openFile: local paths via the `open` package. openUrl: http(s) only,
// spawned with an argv array so shell metacharacters in the URL are inert.

import { spawn, type SpawnOptions } from "node:child_process"
import { platform } from "node:os"
import open from "open"

export function openFile(path: string): void {
  void open(path)
}

export type Deps = {
  spawn?: typeof spawn
  platform?: () => string
}

/** Returns false if the URL was rejected or no opener is known. */
export function openUrl(raw: string, deps: Deps = {}): boolean {
  const url = parseSafeUrl(raw)
  if (!url) return false

  const spawnFn = deps.spawn ?? spawn
  const id = deps.platform?.() ?? platform()
  const cmd = openCommand(id)
  if (!cmd) return false

  const child = spawnFn(cmd.command, [...cmd.args, url.toString()], {
    // stdio ignore: Chrome's stderr otherwise lands in the alt screen.
    detached: true,
    stdio: "ignore",
  } satisfies SpawnOptions)

  child.unref()

  return true
}

export function parseSafeUrl(value: string): null | URL {
  if (!value || typeof value !== "string") return null

  const url = URL.parse(value)
  if (!url) return null

  // file:, data:, javascript: etc. would invoke a local handler on click.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null

  // Some Node versions accept 'http:///foo'.
  if (!url.hostname.trim()) return null

  return url
}

type OpenCommand = { command: string; args: readonly string[] }

// win32 uses explorer.exe, not `cmd /c start` — cmd's tokenizer reparses
// the URL and & | ^ < > become command syntax. Unknown platforms get null.
export function openCommand(id: string): OpenCommand | null {
  if (id === "darwin") return { command: "open", args: [] }
  if (id === "win32") return { command: "explorer.exe", args: [] }

  const xdg = new Set(["linux", "freebsd", "openbsd", "netbsd", "dragonfly"])
  if (xdg.has(id)) return { command: "xdg-open", args: [] }

  return null
}
