import { existsSync, readFileSync, readdirSync } from "fs"
import { basename, extname, join } from "path"
import { configDir } from "../utils/paths"
import type { ThemeJson } from "./types"

const read = (path: string): [string, ThemeJson] | null => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"))
    if (!raw || typeof raw !== "object") return null
    if (!raw.theme || typeof raw.theme !== "object") return null
    return [basename(path, extname(path)), raw as ThemeJson]
  } catch {
    return null
  }
}

export function userThemes(): Record<string, ThemeJson> {
  const dir = join(configDir(), "themes")
  if (!existsSync(dir)) return {}
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".json"))
      .map(e => read(join(dir, e.name)))
      .filter((e): e is [string, ThemeJson] => e !== null),
  )
}
