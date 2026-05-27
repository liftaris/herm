// Git branch for the sidebar. One-shot resolve + fs.watch on
// `<gitdir>/HEAD` so checkout/switch is picked up without polling.
// Ink's equivalent polls every 15s; the watcher is strictly cheaper
// and fires exactly on the event that matters.

import { useEffect, useState } from "react"
import { watch, type FSWatcher } from "node:fs"

const TIMEOUT = 500

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  let p
  try {
    p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" })
  } catch {
    // git not installed or not on PATH — surf as null so callers
    // (branch / status / hooks) quietly render nothing.
    return null
  }
  const t = setTimeout(() => p.kill(), TIMEOUT)
  const out = await new Response(p.stdout).text()
  clearTimeout(t)
  return (await p.exited) === 0 ? out.trimEnd() : null
}

/** Branch name for `cwd`, or null when not in a repo / detached HEAD. */
export async function branch(cwd: string): Promise<string | null> {
  const b = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
  return !b || b === "HEAD" ? null : b
}

/** Absolute .git dir for `cwd` (handles worktrees via git's own resolver). */
export async function gitdir(cwd: string): Promise<string | null> {
  return git(cwd, "rev-parse", "--absolute-git-dir")
}

export function useGitBranch(cwd: string | undefined): string | null {
  const [val, set] = useState<string | null>(null)

  useEffect(() => {
    if (!cwd) { set(null); return }
    let dead = false
    let w: FSWatcher | undefined
    const read = () => branch(cwd).then(b => { if (!dead) set(b) })
    void read()
    // HEAD is rewritten (not edited in-place) on checkout — watch the
    // parent dir and filter on basename so rename-into-place fires.
    gitdir(cwd).then(dir => {
      if (dead || !dir) return
      try {
        w = watch(dir, { persistent: false }, (_ev, f) => {
          if (f === "HEAD") void read()
        })
      } catch { /* unwatchable fs */ }
    })
    return () => { dead = true; w?.close() }
  }, [cwd])

  return val
}

/** Right-ellipsise keeping the discriminating tail (feature/foo → …e/foo). */
export const rtrunc = (s: string, max: number) =>
  s.length <= max ? s : "…" + s.slice(-(max - 1))

/** Parsed `git status --porcelain` entry. */
export type File = { file: string; code: string }

/** Parsed working-tree status for cwd, or null when not in a repo. */
export async function status(cwd: string): Promise<{
  files: File[]
  added: number
  modified: number
  deleted: number
} | null> {
  const out = await git(cwd, "status", "--porcelain")
  if (!out) return null
  const files = out.split("\n").filter(Boolean).map(line => ({
    code: line.slice(0, 2),
    file: line.slice(3),
  }))
  let added = 0
  let modified = 0
  let deleted = 0
  for (const f of files) {
    const idx = f.code[0]
    const wt = f.code[1]
    if (idx === "?" && wt === "?") { added++; continue }
    if (idx === "A") { added++; continue }
    if (idx === "D" || wt === "D") { deleted++; continue }
    if (idx === "M" || wt === "M" || idx === "R") modified++
  }
  return { files, added, modified, deleted }
}

/** Reactive hook: re-reads `git status` when .git/index changes. */
export function useGitStatus(cwd: string | undefined): {
  files: File[]
  added: number
  modified: number
  deleted: number
} | null {
  const [val, set] = useState<{
    files: File[]; added: number; modified: number; deleted: number
  } | null>(null)

  useEffect(() => {
    if (!cwd) { set(null); return }
    let dead = false
    let w: FSWatcher | undefined
    const read = () => status(cwd).then(s => { if (!dead) set(s) })
    void read()
    gitdir(cwd).then(dir => {
      if (dead || !dir) return
      try {
        w = watch(dir, { persistent: false }, (_ev, f) => {
          if (f === "index") void read()
        })
      } catch { /* unwatchable fs */ }
    })
    return () => { dead = true; w?.close() }
  }, [cwd])

  return val
}

export * as git from "./git"
