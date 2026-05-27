import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { git } from "./git"

/** Create a fresh repo with one committed file so all tests start from
 *  a known HEAD. Without an initial commit porcelain codes shift
 *  (e.g. staged adds show differently when HEAD doesn't exist). */
async function setup(dir: string): Promise<void> {
  await $`git -C ${dir} init -q`.quiet()
  await $`git -C ${dir} config user.email "test@test"`.quiet()
  await $`git -C ${dir} config user.name "test"`.quiet()
  writeFileSync(join(dir, ".root"), "")
  await $`git -C ${dir} add .root`.quiet()
  await $`git -C ${dir} commit -m root -q`.quiet()
}

describe("git.status", () => {
  it("returns null for a non-repo directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herm-git-test-"))
    try {
      const s = await git.status(tmp)
      expect(s).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("returns null for a clean repo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herm-git-test-"))
    try {
      await setup(tmp)
      const s = await git.status(tmp)
      expect(s).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("counts untracked files as added", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herm-git-test-"))
    try {
      await setup(tmp)
      writeFileSync(join(tmp, "new.ts"), "console.log(1)")
      const s = await git.status(tmp)
      expect(s).not.toBeNull()
      expect(s!.added).toBe(1)
      expect(s!.modified).toBe(0)
      expect(s!.deleted).toBe(0)
      expect(s!.files[0].code).toBe("??")
      expect(s!.files[0].file).toBe("new.ts")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("counts a modified tracked file as modified", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herm-git-test-"))
    try {
      await setup(tmp)
      // main.ts must already be tracked for a change to count as modified
      // instead of untracked (??). Create, commit, then modify.
      writeFileSync(join(tmp, "main.ts"), "v1")
      await $`git -C ${tmp} add main.ts`.quiet()
      await $`git -C ${tmp} commit -m add-main -q`.quiet()
      writeFileSync(join(tmp, "main.ts"), "v2")
      const s = await git.status(tmp)
      expect(s).not.toBeNull()
      expect(s!.modified).toBe(1)
      expect(s!.added).toBe(0)
      expect(s!.deleted).toBe(0)
      expect(s!.files[0].file).toBe("main.ts")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("counts staged new files as added", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herm-git-test-"))
    try {
      await setup(tmp)
      writeFileSync(join(tmp, "a.ts"), "a")
      await $`git -C ${tmp} add a.ts`.quiet()
      const s = await git.status(tmp)
      expect(s).not.toBeNull()
      expect(s!.added).toBe(1)
      expect(s!.files[0].code).toBe("A ")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("counts a deleted tracked file as deleted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herm-git-test-"))
    try {
      await setup(tmp)
      writeFileSync(join(tmp, "old.ts"), "old")
      await $`git -C ${tmp} add old.ts`.quiet()
      await $`git -C ${tmp} commit -m add-old -q`.quiet()
      unlinkSync(join(tmp, "old.ts"))
      const s = await git.status(tmp)
      expect(s).not.toBeNull()
      expect(s!.deleted).toBe(1)
      expect(s!.added).toBe(0)
      expect(s!.modified).toBe(0)
      expect(s!.files[0].file).toBe("old.ts")
      // Porcelain for unstaged deletion is " D" (space + D)
      expect(s!.files[0].code).toBe(" D")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("git.rtrunc", () => {
  it("returns short strings unchanged", () => {
    expect(git.rtrunc("main", 10)).toBe("main")
  })

  it("ellipsises from the left, preserving the tail", () => {
    // "feature/my-long-branch-name" = 27 chars
    // max=12 → "…" + last 11 = "…branch-name" (12 chars)
    expect(git.rtrunc("feature/my-long-branch-name", 12)).toBe("…branch-name")
  })

  it("returns full string when exactly at max", () => {
    expect(git.rtrunc("abcd", 4)).toBe("abcd")
  })
})
