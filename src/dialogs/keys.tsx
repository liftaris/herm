// /keys rebind dialog — list every catalog action grouped by scope, show
// current chord + override marker + inline conflict warning. Enter opens
// a TextPrompt for the chord spec (e.g. "ctrl+l", "<leader>m") — typing
// the spec rather than capturing the raw keystroke sidesteps the global
// useKeyboard ordering problem (useAppKeys would see the captured key
// first and act on it). 'r' resets the selected row to its default.

import { useState, useMemo } from "react"
import { VBAR } from "../ui/table"
import { useKeyboard } from "@opentui/react"
import { useTheme } from "../theme"
import { prefs } from "../context/preferences"
import {
  useKeys, DEFAULTS, conflictsWith, parse,
  type ActionId, type Scope, type Chord,
} from "../keys"
import { print as chordPrint } from "../keys/chord"
import type { DialogContext } from "../ui/dialog"
import { openTextPrompt } from "./text-prompt"

type Group = { title: string; scope: Scope }

const GROUPS: ReadonlyArray<Group> = [
  { title: "Global",   scope: "global" },
  { title: "Composer", scope: "composer" },
  { title: "Lists",    scope: "list" },
  { title: "Dialogs",  scope: "dialog" },
  { title: "Sessions", scope: "sessions" },
  { title: "Agents",   scope: "agents" },
  { title: "Config",   scope: "config" },
]

type Row =
  | { type: "header"; title: string }
  | { type: "action"; id: ActionId; desc: string; chord: ReadonlyArray<Chord>; override: boolean }

const KeysDialog = (props: { dialog: DialogContext }) => {
  const theme = useTheme().theme
  const keys = useKeys()
  const overrides = prefs.get("keys") ?? {}

  const rows = useMemo<Row[]>(() => GROUPS.flatMap(g => {
    const entries = keys.all(g.scope).filter(e => e.id !== "leader")
    if (entries.length === 0) return []
    return [
      { type: "header" as const, title: g.title },
      ...entries.map(e => ({
        type: "action" as const,
        id: e.id, desc: e.desc, chord: e.chord,
        override: overrides[e.id] !== undefined,
      })),
    ]
  }), [keys, overrides])

  const actionRows = rows.map((r, i) => ({ r, i })).filter(x => x.r.type === "action")
  const [sel, setSel] = useState(0)

  const cur = actionRows[sel]?.r as Extract<Row, { type: "action" }> | undefined
  const curConflicts = cur ? conflictsWith(keys.table, cur.id) : []

  const write = (id: ActionId, value: string | undefined) => {
    const next = { ...(prefs.get("keys") ?? {}) }
    if (value === undefined) delete next[id]
    else next[id] = value
    prefs.set("keys", next)
  }

  const rebind = (id: ActionId) => {
    const now = overrides[id] ?? DEFAULTS[id].chord
    void openTextPrompt(props.dialog, {
      title: `Rebind ${id}`,
      label: "Chord (e.g. ctrl+k, <leader>m, shift+return; empty = unbind)",
      initial: now,
    }).then(v => {
      // TextPrompt's dialog.clear() replaced us; remount either way.
      openKeys(props.dialog)
      if (v === null) return
      const parsed = parse(v)
      write(id, parsed.length === 0 ? "none" : v)
    })
  }

  useKeyboard((key) => {
    if (key.name === "up")   return setSel(s => Math.max(0, s - 1))
    if (key.name === "down") return setSel(s => Math.min(actionRows.length - 1, s + 1))
    if (key.name === "return" && cur) return rebind(cur.id)
    if (key.name === "r" && !key.ctrl && cur?.override) { write(cur.id, undefined); return }
  })

  return (
    <box flexDirection="column" width={78}>
      <box height={1} flexDirection="row">
        <box flexGrow={1}><text fg={theme.text}><strong>Keybindings</strong></text></box>
        <text fg={theme.textMuted}>{`leader = ${keys.print("leader")}`}</text>
      </box>
      <box height={1} />
      <scrollbox scrollY maxHeight={22} verticalScrollbarOptions={VBAR}>
        <box flexDirection="column" width="100%">
          {rows.map((r, i) => {
            if (r.type === "header") return (
              <box key={`h-${r.title}`} height={1} marginTop={i > 0 ? 1 : 0}>
                <text fg={theme.primary}><strong>{r.title}</strong></text>
              </box>
            )
            const ai = actionRows.findIndex(x => x.i === i)
            const on = ai === sel
            const conf = conflictsWith(keys.table, r.id)
            return (
              <box key={r.id} height={1} flexDirection="row"
                   backgroundColor={on ? theme.backgroundElement : undefined}
                   onMouseOver={() => setSel(ai)}
                   onMouseDown={() => { setSel(ai); rebind(r.id) }}>
                <box width={2} flexShrink={0}>
                  <text fg={on ? theme.primary : theme.text}>{on ? "▸ " : "  "}</text>
                </box>
                <box width={16} flexShrink={0} height={1} overflow="hidden">
                  <text fg={on ? theme.accent : theme.text}>
                    {chordPrint(r.chord, keys.print("leader")) || "—"}
                  </text>
                </box>
                <box flexGrow={1} minWidth={0} height={1} overflow="hidden">
                  <text fg={theme.textMuted}>{r.desc}</text>
                </box>
                <box width={5} flexShrink={0} flexDirection="row" justifyContent="flex-end">
                  <text>
                    {r.override ? <span fg={theme.info}>{"· "}</span> : null}
                    {conf.length > 0 ? <span fg={theme.warning}>⚠</span> : null}
                  </text>
                </box>
              </box>
            )
          })}
        </box>
      </scrollbox>
      <box height={1} />
      <box height={1}>
        {curConflicts.length > 0
          ? <text fg={theme.warning}>{`⚠ shares ${keys.print(cur!.id)} with: ${curConflicts.join(", ")}`}</text>
          : <text fg={theme.textMuted}>{`↑↓ select  Enter rebind${cur?.override ? "  ·  r reset" : ""}  ·  esc close  ·  · = overridden`}</text>}
      </box>
    </box>
  )
}

export function openKeys(dialog: DialogContext) {
  dialog.replace(<KeysDialog dialog={dialog} />)
}
