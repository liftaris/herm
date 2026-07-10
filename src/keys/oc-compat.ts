// One-shot OpenCode keybind import.
//
// oc stores keybinds as `{keybinds: {<snake_id>: <chord-string>}}` in
// ~/.config/opencode/tui.json (project-local ./tui.json | ./.opencode/
// tui.json layer on top). Chord grammar is identical to ours (chord.ts
// parses it as-is, including `<leader>`), so the only work is
// snake_id → ActionId translation.
//
// oc ids with no herm analogue (messages_* scroll nav, the ~30
// `input_*` readline actions which OpenTUI's EditBufferRenderable owns,
// agent/variant cycling, model favorites) are dropped and reported.

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ActionId } from "./catalog"

// Ordered: later keys win if an oc user somehow maps two ids to the
// same herm action (they shouldn't, but defend).
export const OC_TO_HERM: ReadonlyArray<readonly [string, ActionId]> = [
  ["leader",            "leader"],
  ["app_exit",          "app.exit"],
  ["terminal_suspend",  "app.suspend"],
  ["sidebar_toggle",    "app.sidebar"],
  ["command_list",      "palette.open"],
  ["editor_open",       "editor.open"],
  ["theme_list",        "theme.pick"],
  ["model_list",        "model.pick"],
  ["status_view",       "status.open"],
  ["session_new",       "session.new"],
  ["session_compact",   "session.compress"],
  ["session_timeline",  "session.timeline"],
  ["session_interrupt", "session.interrupt"],
  ["session_rename",    "sessions.rename"],
  ["messages_copy",     "reply.copy"],
  ["messages_redo",     "session.redo"],
  ["input_clear",       "input.clear"],
  ["input_submit",      "input.submit"],
  ["input_newline",     "input.newline"],
  ["input_paste",       "clipboard.attach"],
] as const

const TABLE = new Map(OC_TO_HERM)

type OcFile = { keybinds?: Record<string, string> }

/** File candidates, lowest→highest precedence (global, project, dot-dir).
 *  Legacy `opencode.json` is last — oc already warns it's deprecated. */
const ocPaths = (cwd = process.cwd()): string[] => [
  join(homedir(), ".config", "opencode", "tui.json"),
  join(cwd, "tui.json"),
  join(cwd, ".opencode", "tui.json"),
  join(cwd, "opencode.json"),
]

const read = (p: string): Record<string, string> => {
  if (!existsSync(p)) return {}
  const j = JSON.parse(readFileSync(p, "utf8")) as OcFile
  return j.keybinds ?? {}
}

export type OcImport = {
  overrides: Partial<Record<ActionId, string>>
  skipped: string[]
  sources: string[]
}

/** Merge all discovered oc files, translate, return the override record
 *  to write into `preferences.keys`. `"none"` passes through (chord.ts
 *  parses it to []). */
export const loadOcKeybinds = (cwd?: string): OcImport => {
  const merged: Record<string, string> = {}
  const sources: string[] = []
  for (const p of ocPaths(cwd)) {
    const kb = read(p)
    if (Object.keys(kb).length === 0) continue
    Object.assign(merged, kb)
    sources.push(p)
  }
  const overrides: Partial<Record<ActionId, string>> = {}
  const skipped: string[] = []
  for (const [oc, chord] of Object.entries(merged)) {
    const herm = TABLE.get(oc)
    if (herm) overrides[herm] = chord
    else skipped.push(oc)
  }
  return { overrides, skipped, sources }
}
