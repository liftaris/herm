import { writeSync } from "node:fs"

let done = false

export async function quit(
  renderer: { destroy: () => void; closed: Promise<void>; setTerminalTitle: (t: string) => void },
  sid?: string,
  title?: string,
  gw?: { kill: () => void },
  exit: (code: number) => void = process.exit,
): Promise<void> {
  if (done) return
  done = true
  try { gw?.kill() } catch {}
  try { renderer.setTerminalTitle("") } catch {}
  renderer.destroy()
  await renderer.closed
  if (process.stdout.isTTY) {
    const banner = sid
      ? `\n  continue  herm --resume ${sid}${title ? `  —  ${title.slice(0, 60)}` : ""}\n\n`
      : `\n  bye\n\n`
    writeSync(1, banner)
  }
  exit(0)
}
