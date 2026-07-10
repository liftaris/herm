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

export type File = { file: string; code: string }
export type Status = {
  files: File[]
  added: number
  modified: number
  deleted: number
}

export async function status(cwd: string): Promise<Status | null> {
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

const same = (a: Status | null, b: Status | null) =>
  a === b || Boolean(a && b
    && a.added === b.added
    && a.modified === b.modified
    && a.deleted === b.deleted
    && a.files.length === b.files.length
    && a.files.every((file, i) => file.code === b.files[i]?.code && file.file === b.files[i]?.file))

export function useGitStatus(cwd: string | undefined, delay = 2000): Status | null {
  const [val, set] = useState<Status | null>(null)

  useEffect(() => {
    if (!cwd) { set(null); return }
    let dead = false
    let seq = 0
    const read = () => {
      const id = ++seq
      void status(cwd).then(s => {
        if (!dead && id === seq) set(old => same(old, s) ? old : s)
      })
    }
    void read()
    const timer = setInterval(read, Math.max(250, delay))
    return () => { dead = true; clearInterval(timer) }
  }, [cwd, delay])

  return val
}

export * as git from "./git"
