import { resetTerminalModes } from "../utils/terminal-reset"

export function fatal(err: unknown): never {
  resetTerminalModes()
  console.error(err)
  process.exit(1)
}
