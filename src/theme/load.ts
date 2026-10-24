/**
 * Theme body loader — one dynamic import per theme, memoized in-process.
 *
 * Startup keeps the 42 JSON bodies off the import graph; they load on first
 * `set(name)` (or `prime(name)` during bootstrap for the active theme).
 */

import type { ThemeJson } from "./types"
import { PREVIEW } from "./manifest"

const cache = new Map<string, ThemeJson>()
const pending = new Map<string, Promise<ThemeJson>>()

export async function load(name: string): Promise<ThemeJson> {
  const hit = cache.get(name)
  if (hit) return hit
  const inflight = pending.get(name)
  if (inflight) return inflight
  if (!PREVIEW[name]) throw new Error(`Unknown theme: ${name}`)
  const p = import(`./themes/${name}.json`).then(m => {
    const json = (m.default ?? m) as ThemeJson
    cache.set(name, json)
    pending.delete(name)
    return json
  })
  pending.set(name, p)
  return p
}

/** Sync read — returns undefined if not yet loaded. */
export function get(name: string): ThemeJson | undefined {
  return cache.get(name)
}

export async function prime(name: string): Promise<void> {
  await load(name)
}
