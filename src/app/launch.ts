// Launch intent parsed from argv before the renderer starts.
// Bare `herm` → fresh session (splash shows continue-prompt).
// `-c` / `--continue` / `--resume [id]` → resume (splash shows Loading…).
// `--no-splash` → skip splash in either mode.

import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"

// Runtime read so the published bundle picks up dist/package.json (which
// @semantic-release/npm stamps), not the build-time root value. Walks up
// from this file's dir so dev (src/app/ → ../../package.json) and dist
// (./package.json) both resolve.
const pkgVersion = (d: string, up = 4): string => {
  const p = join(d, "package.json")
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")).version
  return up > 0 ? pkgVersion(dirname(d), up - 1) : "0.0.0"
}

export const VERSION = pkgVersion(import.meta.dirname)

export type Launch =
  | { mode: "new"; profile?: string; splash?: boolean }
  | { mode: "resume"; profile?: string; sid?: string; splash?: boolean }

/** Parse process argv (everything after the script path). No deps. */
export function parseLaunch(argv: readonly string[]): Launch {
  let splash = true
  let mode: "new" | "resume" = "new"
  let profile: string | undefined
  let sid: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--no-splash") { splash = false; continue }
    if (a === "--profile") {
      const next = argv[i + 1]
      if (!next || next.startsWith("-")) throw new Error("--profile requires a name")
      profile = next
      i++
      continue
    }
    if (a === "-c" || a === "--continue") { mode = "resume"; continue }
    if (a === "--resume") {
      const next = argv[i + 1]
      mode = "resume"
      if (next && !next.startsWith("-")) { sid = next; i++ }
    }
  }
  if (mode === "resume") return { mode, ...(profile ? { profile } : {}), ...(sid ? { sid } : {}), splash }
  return { mode, ...(profile ? { profile } : {}), splash }
}

export const HELP = `\
herm — OpenTUI client for hermes-agent

Usage:
  herm                    start a fresh session
  herm -c, --continue     resume the last real TUI session
  herm --resume [id]      resume last (or the given) session
  herm --profile <name>   start once with a profile; do not change the default
  herm --no-splash        skip the launch splash
  herm -v, --version      print version
  herm -h, --help         show this help
`
