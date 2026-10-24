import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editInEditor } from "../src/utils/editor"

const fake = () => {
  const calls: string[] = []
  return {
    calls,
    renderer: {
      isDestroyed: false,
      suspend: async () => { calls.push("suspend") },
      resume: async () => { calls.push("resume") },
    },
  }
}

describe("editInEditor", () => {
  let prev: { V?: string; E?: string }
  beforeEach(() => { prev = { V: process.env.VISUAL, E: process.env.EDITOR } })
  afterEach(() => {
    if (prev.V === undefined) delete process.env.VISUAL; else process.env.VISUAL = prev.V
    if (prev.E === undefined) delete process.env.EDITOR; else process.env.EDITOR = prev.E
  })

  test("returns undefined when no $VISUAL/$EDITOR; renderer untouched", async () => {
    delete process.env.VISUAL
    delete process.env.EDITOR
    const f = fake()
    const out = await editInEditor(f.renderer, "seed")
    expect(out).toBeUndefined()
    expect(f.calls).toEqual([])
  })

  test("spawns editor, reads back trimmed output, cleans tmpfile", async () => {
    // Fake editor: a shell script that overwrites the file it's given.
    const script = join(tmpdir(), `herm-fake-editor-${Date.now()}.sh`)
    await Bun.write(script, `#!/bin/sh\nprintf 'line1\\nline2\\n' > "$1"\n`)
    await Bun.$`chmod +x ${script}`.quiet()
    process.env.VISUAL = script
    delete process.env.EDITOR

    const f = fake()
    const restoring = Promise.withResolvers<void>()
    const restored = Promise.withResolvers<void>()
    f.renderer.resume = async () => {
      f.calls.push("resume")
      restoring.resolve()
      await restored.promise
    }
    let returned = false
    const pending = editInEditor(f.renderer, "initial seed").then(text => {
      returned = true
      return text
    })
    await restoring.promise
    await Promise.resolve()
    expect(returned).toBe(false)
    restored.resolve()
    const out = await pending

    expect(out).toBe("line1\nline2")
    expect(f.calls).toEqual(["suspend", "resume"])

    rmSync(script, { force: true })
  })

  test("uses requested temp suffix", async () => {
    const script = join(tmpdir(), `herm-fake-editor-suffix-${Date.now()}.sh`)
    await Bun.write(script, `#!/bin/sh\ncase "$1" in *.txt) printf 'txt file' > "$1" ;; *) printf 'wrong' > "$1" ;; esac\n`)
    await Bun.$`chmod +x ${script}`.quiet()
    process.env.VISUAL = script

    const f = fake()
    const out = await editInEditor(f.renderer, "seed", ".txt")
    expect(out).toBe("txt file")

    rmSync(script, { force: true })
  })

  test("honors quoted editor paths and arguments", async () => {
    const script = join(tmpdir(), `herm fake editor ${Date.now()}.sh`)
    await Bun.write(script, `#!/bin/sh\n[ "$1" = --flag ] || exit 2\nprintf 'quoted editor' > "$2"\n`)
    await Bun.$`chmod +x ${script}`.quiet()
    process.env.VISUAL = ""
    process.env.EDITOR = `'${script}' --flag`
    const f = fake()
    const out = await editInEditor(f.renderer, "kept")
    expect(out).toBe("quoted editor")
    rmSync(script, { force: true })
  })

  test("empty result returns undefined", async () => {
    const script = join(tmpdir(), `herm-fake-editor-empty-${Date.now()}.sh`)
    await Bun.write(script, "#!/bin/sh\n: > \"$1\"\n") // truncate
    await Bun.$`chmod +x ${script}`.quiet()
    process.env.VISUAL = script

    const f = fake()
    const out = await editInEditor(f.renderer, "seed")
    expect(out).toBeUndefined()
    expect(f.calls[0]).toBe("suspend")
    expect(f.calls[f.calls.length - 1]).toBe("resume")

    rmSync(script, { force: true })
  })

  test("missing editor restores the renderer before rejecting", async () => {
    process.env.VISUAL = "definitely-missing-herm-editor"
    delete process.env.EDITOR
    const f = fake()

    await expect(editInEditor(f.renderer, "seed")).rejects.toThrow("editor exited")
    expect(f.calls).toEqual(["suspend", "resume"])
  })
})
