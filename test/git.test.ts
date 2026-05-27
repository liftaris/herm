import { describe, test, expect } from "bun:test"
import { mkdtempSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git } from "../src/utils/git"

const sh = async (cwd: string, cmd: string) => {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "ignore", stderr: "ignore" })
  await p.exited
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
})
