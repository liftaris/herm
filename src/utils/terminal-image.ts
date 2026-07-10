import { existsSync } from "fs"

type PreviewKind = "chafa" | "chip"
type PreviewReason = "chafa-supported" | "no-renderer" | "missing" | "unsupported" | "remote"
export type PreviewStrategy = { kind: PreviewKind; reason: PreviewReason }

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"])
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i

export function image(path: string): boolean {
  return IMAGE_EXT.has((path.split(/[?#]/)[0].split(".").pop() ?? "").toLowerCase())
}

function remote(path: string): boolean {
  return URL_RE.test(path)
}

export function previewStrategy(opts: {
  path: string
  exists: boolean
  chafa: boolean
}): PreviewStrategy {
  if (remote(opts.path)) return { kind: "chip", reason: "remote" }
  if (!image(opts.path)) return { kind: "chip", reason: "unsupported" }
  if (!opts.exists) return { kind: "chip", reason: "missing" }
  if (opts.chafa) return { kind: "chafa", reason: "chafa-supported" }
  return { kind: "chip", reason: "no-renderer" }
}

export function strategy(path: string, chafa: boolean): PreviewStrategy {
  return previewStrategy({
    path,
    chafa,
    exists: remote(path) ? false : existsSync(path.startsWith("~") ? (process.env.HOME ?? "") + path.slice(1) : path),
  })
}
