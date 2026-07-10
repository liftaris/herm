// Suspend the renderer, open $VISUAL/$EDITOR on a tmpfile seeded with the
// current input, read it back. Returns undefined if no editor configured
// or the user emptied the file. `suffix` hints syntax mode to editors.

import { tmpdir } from "node:os"
import { join } from "node:path"
import { rm } from "node:fs/promises"
import type { CliRenderer } from "@opentui/core"

export async function editInEditor(renderer: CliRenderer, seed: string, suffix = ".md"): Promise<string | undefined> {
  const cmd = process.env.VISUAL || process.env.EDITOR
  if (!cmd) return undefined

  const path = join(tmpdir(), `herm-${Date.now()}${suffix}`)
  await Bun.write(path, seed)

  let suspended = false
  try {
    renderer.suspend()
    suspended = true
    renderer.currentRenderBuffer.clear()
    const argv = process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", `${cmd} "${path.replaceAll('"', '""')}"`]
      : ["/bin/sh", "-c", `exec ${cmd} "$1"`, "herm-editor", path]
    const proc = Bun.spawn(argv, {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`editor exited ${code}`)
    const text = await Bun.file(path).text().catch(() => "")
    return text.trim() || undefined
  } finally {
    await rm(path, { force: true }).catch(() => {})
    // destroy() frees the native buffer pointer; never resume a dead renderer.
    if (suspended && !renderer.isDestroyed) {
      try { renderer.currentRenderBuffer.clear() }
      finally {
        renderer.resume()
        renderer.requestRender()
      }
    }
  }
}
