/**
 * Local TUI preferences — persisted to $HERM_CONFIG_DIR/tui.json
 * (defaults to ~/.hermes/herm/tui.json; see utils/paths.ts).
 *
 * Compatible with OpenCode's tui.json schema pattern:
 *   - JSON file in XDG config dir
 *   - Optional fields with sensible defaults
 *   - Deep-merged from multiple sources (global → project)
 *   - Read once at startup, written on change
 *
 * Herm-specific extensions (beyond OpenCode compat):
 *   - lastSessionId: resume previous session on startup
 */

import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { useSyncExternalStore } from "react"

export type DetailMode = "hidden" | "collapsed" | "expanded"

interface TuiPreferences {
  /** JSON schema reference (for editor autocomplete) */
  $schema?: string
  /** Theme name — must match a built-in or custom theme */
  theme?: string
  /** Theme palette mode */
  themeMode?: "dark" | "light"
  /** Mouse capture enabled */
  mouse?: boolean
  /** Target render FPS */
  targetFps?: number
  /** Last active session ID — stub-reuse check on fresh launch */
  lastSessionId?: string
  /** Active avatar by name; resolved against <profile>/eikons/ → bundled. */
  eikon?: string
  /** @deprecated absolute .eikon path — migrated to `eikon` on load. */
  eikonPath?: string
  /** Active rasterizer name for the Eikon Studio tab */
  eikonRasterizer?: string
  /** Spinner/avatar frame animations (off → static glyphs) */
  animations?: boolean
  /** Thought-cloud tool trail verbosity */
  toolDetails?: DetailMode
  /** User keybinding overrides (ActionId → chord string) */
  keys?: Record<string, string>
  /** Clock style for time-of-day formatters */
  timeFormat?: "12h" | "24h"
  /** List-column timestamps: "2h ago" vs "14:32" / "May 1" */
  timeStyle?: "relative" | "absolute"
  /** Action when a session's goal flips to status=done.
   *  "toast"   — toast only (default)
   *  "suspend" — 10s-countdown confirm, then `systemctl suspend`
   *  any other string — 10s-countdown confirm, then run it via sh */
  onGoalDone?: string
  /** Per-tab state that should survive restarts. Keep this shallow —
   *  only durable UX choices (filter masks, collapsed sections), never
   *  cursor position or transient toggles. */
  kanban?: KanbanPrefs
  sessions?: SessionsPrefs
  /** Client-side confirm_ask approvals suppressed by exact question+subject. */
  neverPrompts?: NeverPrompt[]
  /** Opaque plugin storage. Per-plugin keys are namespaced at the api
   *  layer (`${id}.${key}`); `enabled` holds the id→bool override map. */
  plugin?: Record<string, unknown>
}

export type NeverPrompt = {
  group: string
  question: string
  subject: string
}

/** Persisted Sessions-tab state. */
export type SessionsPrefs = {
  /** List ordering. "active" (default) = by last message timestamp;
   *  "started" = by session start time. */
  sort?: "active" | "started"
}

/** Persisted Kanban-tab state. Keyed by board slug so masks on one
 *  board don't follow you to another. */
export type KanbanPrefs = {
  /** Boards that should mount expanded. Absent = collapsed. Stored as
   *  an array for JSON-friendliness; consumer rehydrates to a Set. */
  open?: string[]
  /** Per-board filter-chip tri-state. Maps decomposed as entry arrays
   *  because JSON has no native Map support. */
  masks?: Record<string, {
    who?: Array<[string, "in" | "ex"]>
    pri?: Array<[number, "in" | "ex"]>
    status?: Array<[string, "in" | "ex"]>
  }>
}

const DEFAULTS: Required<Pick<TuiPreferences, "mouse" | "targetFps">> = {
  mouse: true,
  targetFps: 30,
}

import { configDir } from "../utils/paths"

function configFile() { return join(configDir(), "tui.json") }

let cached: TuiPreferences | null = null
let rev = 0

/** Test-only: drop the cached snapshot so the next load() re-reads disk. */
export function reset(): void {
  cached = null
}

/** Re-read tui.json from the current configDir() and notify usePref()
 *  subscribers. Profile switch calls this after HERMES_HOME rebinds so
 *  theme/eikon/keys follow the new profile. */
export function reload(): void {
  cached = null
  rev++
  for (const l of listeners) l()
}

/**
 * Load preferences from disk. Returns cached copy on subsequent calls.
 * Never throws — returns defaults on missing/corrupt file.
 */
export function load(): TuiPreferences {
  if (cached) return cached

  const CONFIG_FILE = configFile()
  try {
    if (!existsSync(CONFIG_FILE)) {
      const prefs = { ...DEFAULTS }
      cached = prefs
      return prefs
    }
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
    // eikonPath (abs) → eikon (name). One-shot; persisted on next set().
    if (raw.eikonPath && !raw.eikon) {
      raw.eikon = raw.eikonPath.split("/").pop()?.replace(/\.eikon$/, "")
      delete raw.eikonPath
    }
    const prefs = { ...DEFAULTS, ...raw }
    cached = prefs
    return prefs
  } catch {
    const prefs = { ...DEFAULTS }
    cached = prefs
    return prefs
  }
}

/**
 * Persist current preferences to disk.
 * Merges provided partial into existing prefs before writing.
 */
function save(partial?: Partial<TuiPreferences>): void {
  const current = load()
  if (partial) Object.assign(current, partial)
  cached = current

  try {
    const CONFIG_DIR = configDir()
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }
    // Write with sorted keys for stable diffs
    const json = JSON.stringify(current, null, 2) + "\n"
    writeFileSync(configFile(), json, "utf-8")
  } catch (err) {
    // Silently fail — preferences are non-critical
    if (process.env.PERF) {
      console.error("[preferences] failed to save:", err)
    }
  }
}

/** Get a single preference value */
export function get<K extends keyof TuiPreferences>(key: K): TuiPreferences[K] {
  return load()[key]
}

/** Set a single preference value and persist. No-op when unchanged so
 *  redundant writes (e.g. a picker's live-preview re-firing on the same
 *  row) don't notify subscribers and trigger render loops. */
export function set<K extends keyof TuiPreferences>(key: K, value: TuiPreferences[K]): void {
  if (load()[key] === value) return
  save({ [key]: value } as Partial<TuiPreferences>)
  rev++
  for (const l of listeners) l()
}

const listeners = new Set<() => void>()

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * Subscribe a component to a preference key. Re-renders on set().
 * Writes go through the imperative `set(key, value)` — this hook is
 * read-only by design so writes always persist through one path.
 */
export function usePref<K extends keyof TuiPreferences>(key: K): TuiPreferences[K] {
  return useSyncExternalStore(subscribe, () => load()[key])
}

export function useRev(): number {
  return useSyncExternalStore(subscribe, () => rev)
}

export * as prefs from "./preferences"
