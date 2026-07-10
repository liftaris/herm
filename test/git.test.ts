import { describe, test, expect } from "bun:test"
import { mkdtempSync, rmSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { git } from "../src/utils/git"
import { mountNode, until } from "./harness"

const sh = async (cwd: string, cmd: string) => {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "ignore", stderr: "ignore" })
  await p.exited
}

const setup = async (cwd: string) => {
  await sh(cwd, "git -c user.name=t -c user.email=t@t init -q -b main")
  writeFileSync(join(cwd, ".root"), "root")
  await sh(cwd, "git -c user.name=t -c user.email=t@t add .root && git -c user.name=t -c user.email=t@t commit -qm root")
}

const StatusProbe = (props: { cwd: string }) => {
  const status = git.useGitStatus(props.cwd, 250)
  return createElement("text", null, status ? `+${status.added} ~${status.modified} -${status.deleted}` : "clean")
}

describe("utils/git", () => {
  test("branch() + gitdir() in a fresh repo; null outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-git-"))
    try {
      expect(await git.branch(root)).toBeNull()
      await sh(root, "git -c user.name=t -c user.email=t@t init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x")
      expect(await git.branch(root)).toBe("main")
      // git rev-parse --absolute-git-dir resolves symlinks (macOS /var
      // → /private/var), so compare realpaths.
      expect(realpathSync((await git.gitdir(root))!)).toBe(realpathSync(join(root, ".git")))
      await sh(root, "git checkout -q -b feature/long-name")
      expect(await git.branch(root)).toBe("feature/long-name")
      // detached → null
      await sh(root, "git checkout -q --detach")
      expect(await git.branch(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rtrunc keeps the tail", () => {
    expect(git.rtrunc("main", 10)).toBe("main")
    expect(git.rtrunc("feature/very-long-branch", 10)).toBe("…ng-branch")
    expect(git.rtrunc("feature/very-long-branch", 10).length).toBe(10)
  })

  test("status parses added, modified, and deleted files", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-git-status-"))
    try {
      await setup(root)
      writeFileSync(join(root, "main.ts"), "v1")
      writeFileSync(join(root, "old.ts"), "old")
      await sh(root, "git add main.ts old.ts && git -c user.name=t -c user.email=t@t commit -qm files")
      writeFileSync(join(root, "main.ts"), "v2")
      writeFileSync(join(root, "new.ts"), "new")
      unlinkSync(join(root, "old.ts"))

      const status = await git.status(root)
      expect(status).toMatchObject({ added: 1, modified: 1, deleted: 1 })
      expect(status?.files.map(file => file.file).sort()).toEqual(["main.ts", "new.ts", "old.ts"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("useGitStatus refreshes ordinary worktree edits", async () => {
    const root = mkdtempSync(join(tmpdir(), "herm-git-watch-"))
    try {
      await setup(root)
      writeFileSync(join(root, "main.ts"), "v1")
      await sh(root, "git add main.ts && git -c user.name=t -c user.email=t@t commit -qm main")
      const t = await mountNode(createElement(StatusProbe, { cwd: root }))
      await until(t, () => t.frame().includes("clean"))

      writeFileSync(join(root, "main.ts"), "v2")
      await until(t, () => t.frame().includes("+0 ~1 -0"))
      writeFileSync(join(root, "new.ts"), "new")
      await until(t, () => t.frame().includes("+1 ~1 -0"))
      t.destroy()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
