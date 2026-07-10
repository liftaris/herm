// Parse a single line of chafa `--format=symbols --colors=full` output
// into renderable cells. chafa emits SGR escapes interleaved with cell
// characters. Each cell is a single Unicode codepoint preceded by zero or
// more SGR sequences that set fg/bg/reverse. We flatten that stream into
// { ch, fg, bg } records and let the caller build spans.
//
// Grammar (informal):
//   LINE        := (SGR* CELL)*
//   SGR         := ESC '[' PARAMS 'm'
//   PARAMS      := N (';' N)*           // e.g. "38;2;255;0;0" or "0" or "7"
//   CELL        := any single codepoint, not ESC
//
// State mutations from SGR params, reading left to right:
//   0            → fg = bg = null; reverse = false
//   7            → reverse = true (swap fg/bg for following cells)
//   38;2;R;G;B   → fg = rgb(R,G,B)
//   48;2;R;G;B   → bg = rgb(R,G,B)
//   everything else is ignored (chafa doesn't emit 256-color in full mode,
//   and basic 16-color shouldn't appear — but silent-skip is safer than
//   throw on an unexpected byte).

export type RGB = { r: number; g: number; b: number }
export type Cell = { ch: string; fg: RGB | null; bg: RGB | null }

const ESC = 0x1b
const LSQ = 0x5b // '['

export function parseChafaLine(line: string): Cell[] {
  const out: Cell[] = []
  let fg: RGB | null = null
  let bg: RGB | null = null
  let reverse = false
  let i = 0
  const N = line.length

  while (i < N) {
    const code = line.charCodeAt(i)
    // SGR run
    if (code === ESC && line.charCodeAt(i + 1) === LSQ) {
      const end = line.indexOf("m", i + 2)
      if (end < 0) { i = N; break }
      const params = line.slice(i + 2, end).split(";").map(x => parseInt(x, 10) || 0)
      let p = 0
      while (p < params.length) {
        const n = params[p]
        if (n === 0) { fg = null; bg = null; reverse = false; p++; continue }
        if (n === 7) { reverse = true; p++; continue }
        if (n === 27) { reverse = false; p++; continue }
        if (n === 38 && params[p + 1] === 2) {
          fg = { r: params[p + 2] | 0, g: params[p + 3] | 0, b: params[p + 4] | 0 }
          p += 5; continue
        }
        if (n === 48 && params[p + 1] === 2) {
          bg = { r: params[p + 2] | 0, g: params[p + 3] | 0, b: params[p + 4] | 0 }
          p += 5; continue
        }
        if (n === 39) { fg = null; p++; continue }
        if (n === 49) { bg = null; p++; continue }
        p++
      }
      i = end + 1
      continue
    }
    // A cell — consume one codepoint (handles surrogate pairs)
    const cp = line.codePointAt(i)!
    const ch = String.fromCodePoint(cp)
    i += ch.length
    const efg = reverse ? bg : fg
    const ebg = reverse ? fg : bg
    out.push({ ch, fg: efg, bg: ebg })
  }
  return out
}

/** Parse a multi-line chafa output into rows. */
export function parseChafa(text: string): Cell[][] {
  return text.split("\n").filter(s => s.length > 0).map(parseChafaLine)
}

/** Hex color helper for OpenTUI fg/bg props. */
export function hex(c: RGB | null): string | undefined {
  if (!c) return undefined
  return `#${c.r.toString(16).padStart(2, "0")}${c.g.toString(16).padStart(2, "0")}${c.b.toString(16).padStart(2, "0")}`
}
//
// renderChafa() shells the chafa binary and returns parsed rows. Cached by
// (resolved path, mtime, width) — re-renders on the same file at the same
// width are free. Cache is an LRU capped at ~50 entries to bound memory
// for a scrollback with lots of images. Height is omitted from the key
// because we always pass chafa a 4:1 w/h cap and let it pick the actual
// row count to preserve aspect.

import { existsSync, statSync } from "fs"

const CHAFA_PATHS = [
  "/usr/sbin/chafa",
  "/usr/bin/chafa",
  "/usr/local/bin/chafa",
  "/opt/homebrew/bin/chafa",
  "/home/linuxbrew/.linuxbrew/bin/chafa",
]

let cachedBin: string | null | undefined = undefined

/** Locate the chafa binary once per process. null → not installed. */
export function chafaBin(): string | null {
  if (cachedBin !== undefined) return cachedBin
  const bin = Bun.which?.("chafa") ?? null
  if (bin) { cachedBin = bin; return bin }
  for (const p of CHAFA_PATHS) if (existsSync(p)) { cachedBin = p; return p }
  cachedBin = null
  return null
}

/** Expand ~ in a user-supplied path. Returns the absolute path or null
 *  if the file doesn't exist. */
export function resolveImage(path: string): string | null {
  const full = path.startsWith("~")
    ? (process.env.HOME ?? "") + path.slice(1)
    : path
  return existsSync(full) ? full : null
}

export type Rendered = { rows: Cell[][] } | { err: string }

const CACHE = new Map<string, Cell[][]>()
const INFLIGHT = new Map<string, Promise<Rendered>>()
const CACHE_CAP = 50

function cacheGet(k: string): Cell[][] | undefined {
  const v = CACHE.get(k)
  if (!v) return undefined
  // LRU touch: re-insert at tail
  CACHE.delete(k)
  CACHE.set(k, v)
  return v
}

function cachePut(k: string, v: Cell[][]): void {
  if (CACHE.size >= CACHE_CAP) CACHE.delete(CACHE.keys().next().value!)
  CACHE.set(k, v)
}

/** Render an image to parsed cells at the given cell-width. Height is
 *  capped at roughly width/3 so a 2:1-ish image fits most message widths.
 *  Returns { err } on any failure (caller should fall back to MediaChip). */
export async function renderChafa(path: string, width: number, height?: number): Promise<Rendered> {
  const bin = chafaBin()
  if (!bin) return { err: "chafa not installed" }
  const full = resolveImage(path)
  if (!full) return { err: `not found: ${path}` }

  let mtime = 0
  try { mtime = statSync(full).mtimeMs | 0 } catch { /* ignore — cache key is still unique */ }
  const h = height ?? Math.max(6, Math.round(width / 3))
  const key = `${full}:${mtime}:${width}x${h}`
  const cached = cacheGet(key)
  if (cached) return { rows: cached }
  const hit = INFLIGHT.get(key)
  if (hit) return hit

  const task = (async (): Promise<Rendered> => {
    try {
      const proc = Bun.spawn([
        bin,
        `--size=${width}x${h}`,
        "--format=symbols",
        "--symbols=block",
        "--colors=full",
        full,
      ], { stdout: "pipe", stderr: "pipe" })
      let timeout = false
      const timer = setTimeout(() => { timeout = true; proc.kill() }, 5_000)
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]).finally(() => clearTimeout(timer))
      if (timeout) return { err: "chafa timed out" }
      if (code !== 0) return { err: (stderr || `chafa exit ${code}`).trim() }
      const rows = parseChafa(stdout)
      cachePut(key, rows)
      return { rows }
    } catch (err) {
      return { err: err instanceof Error ? err.message : String(err) }
    }
  })()
  INFLIGHT.set(key, task)
  const clear = () => { if (INFLIGHT.get(key) === task) INFLIGHT.delete(key) }
  void task.then(clear, clear)
  return task
}
