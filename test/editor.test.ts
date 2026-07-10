import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editInEditor } from "../src/utils/editor"

// A real CliRenderer isn't needed — editInEditor only calls suspend/
// currentRenderBuffer.clear/resume/requestRender on it.
const fake = () => {
  const calls: string[] = []
  return {
    calls,
    renderer: {
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
      requestRender: () => calls.push("request"),
      currentRenderBuffer: { clear: () => calls.push("clear") },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await editInEditor(f.renderer as any, "seed")
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await editInEditor(f.renderer as any, "initial seed")

    expect(out).toBe("line1\nline2")
    // Lifecycle: suspend → clear → (spawn) → clear → resume → request
    expect(f.calls).toEqual(["suspend", "clear", "clear", "resume", "request"])

    rmSync(script, { force: true })
  })

  test("uses requested temp suffix", async () => {
    const script = join(tmpdir(), `herm-fake-editor-suffix-${Date.now()}.sh`)
    await Bun.write(script, `#!/bin/sh\ncase "$1" in *.txt) printf 'txt file' > "$1" ;; *) printf 'wrong' > "$1" ;; esac\n`)
    await Bun.$`chmod +x ${script}`.quiet()
    process.env.VISUAL = script

    const f = fake()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await editInEditor(f.renderer as any, "seed", ".txt")
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
    const out = await editInEditor(f.renderer as never, "kept")
    expect(out).toBe("quoted editor")
    rmSync(script, { force: true })
  })

  test("empty result returns undefined", async () => {
    const script = join(tmpdir(), `herm-fake-editor-empty-${Date.now()}.sh`)
    await Bun.write(script, "#!/bin/sh\n: > \"$1\"\n") // truncate
    await Bun.$`chmod +x ${script}`.quiet()
    process.env.VISUAL = script

    const f = fake()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await editInEditor(f.renderer as any, "seed")
    expect(out).toBeUndefined()
    expect(f.calls[0]).toBe("suspend")
    expect(f.calls[f.calls.length - 1]).toBe("request")

    rmSync(script, { force: true })
  })

  test("missing editor restores the renderer before rejecting", async () => {
    process.env.VISUAL = "definitely-missing-herm-editor"
    delete process.env.EDITOR
    const f = fake()

    await expect(editInEditor(f.renderer as never, "seed")).rejects.toThrow("editor exited")
    expect(f.calls).toEqual(["suspend", "clear", "clear", "resume", "request"])
  })

  test("initial buffer clear failure still resumes the renderer", async () => {
    process.env.VISUAL = "/bin/true"
    const f = fake()
    let clears = 0
    f.renderer.currentRenderBuffer.clear = () => {
      f.calls.push("clear")
      if (clears++ === 0) throw new Error("clear exploded")
      return f.calls.length
    }

    await expect(editInEditor(f.renderer as never, "seed")).rejects.toThrow("clear exploded")
    expect(f.calls).toEqual(["suspend", "clear", "clear", "resume", "request"])
  })
})
