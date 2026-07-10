import type { Gateway } from "../context/gateway"
import type { DialogContext } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { openAlert } from "./alert"
import type { SpawnTreeEntry, SpawnTreeSnapshot, SpawnSubagent } from "../context/wire"
import { useTheme } from "../theme"
import { dur, when, fmt, trunc } from "../ui/fmt"

// Browse persisted spawn trees (spawn_tree.list) and inspect one
// (spawn_tree.load). Read-only — the live tree lives in the Agents tab.

const Status = ({ s }: { s: SpawnSubagent["status"] }) => {
  const theme = useTheme().theme
  const fg = s === "completed" ? theme.success
    : s === "failed" ? theme.error
    : s === "error" ? theme.error
    : s === "timeout" ? theme.error
    : s === "interrupted" ? theme.warning
    : theme.textMuted
  return <span fg={fg}>{s}</span>
}

const SnapshotView = (props: { entry: SpawnTreeEntry; snap: SpawnTreeSnapshot }) => {
  const theme = useTheme().theme
  const subs = props.snap.subagents ?? []
  const tok = subs.reduce((n, s) => n + (s.input_tokens ?? 0) + (s.output_tokens ?? 0), 0)
  const span = props.snap.started_at && props.snap.finished_at
    ? dur(props.snap.finished_at - props.snap.started_at) : "—"
  return (
    <box flexDirection="column" width={80}>
      <text fg={theme.text}><strong>{props.entry.label || `${subs.length} subagents`}</strong></text>
      <text fg={theme.textMuted}>{when(props.entry.finished_at)} · {span} · {subs.length} agents · {fmt(tok)} tok</text>
      <box height={1} />
      <scrollbox scrollY maxHeight={20} contentOptions={{ flexDirection: "column" }}>
        {subs.map(s => (
          <box key={s.subagent_id} flexDirection="column" marginBottom={1}>
            <box height={1}>
              <text>
                <span fg={theme.textMuted}>{"┃ " + "· ".repeat(s.depth)}</span>
                <span fg={theme.text}>{trunc(s.goal.replace(/\s+/g, " "), 60)}</span>
              </text>
            </box>
            <box height={1}>
              <text fg={theme.textMuted}>
                {"┃ " + " ".repeat(2 * s.depth + 2)}
                <Status s={s.status} />
                {` · ${s.tool_count}t`}
                {s.finished_at ? ` · ${dur(s.finished_at - s.started_at)}` : ""}
                {s.model ? ` · ${s.model}` : ""}
              </text>
            </box>
          </box>
        ))}
      </scrollbox>
    </box>
  )
}

export function openSpawnHistory(dialog: DialogContext, gw: Gateway, sessionId: string): void {
  dialog.replace(<box width={40} height={3}><text>Loading spawn history…</text></box>)
  const listToken = dialog.version()
  gw.request<{ entries: SpawnTreeEntry[] }>("spawn_tree.list", { session_id: sessionId, limit: 50 })
    .then(r => {
      if (dialog.version() !== listToken) return
      const entries = r.entries ?? []
      dialog.replace(
        <DialogSelect
          title="Spawn history"
          placeholder={entries.length ? "filter…" : "no saved spawn trees"}
          options={entries.map(e => ({
            value: e.path,
            title: `${e.count.toString().padStart(2)}× ${trunc(e.label || "(unlabeled)", 40)}`,
            description: when(e.finished_at),
            category: e.session_id === sessionId ? "This session" : e.session_id,
          }))}
          onSelect={opt => {
            const entry = entries.find(e => e.path === opt.value)!
            dialog.replace(<box width={40} height={3}><text>Loading spawn tree…</text></box>)
            const token = dialog.version()
            gw.request<SpawnTreeSnapshot>("spawn_tree.load", { path: entry.path })
              .then(snap => {
                if (dialog.version() === token) dialog.replace(<SnapshotView entry={entry} snap={snap} />)
              })
              .catch(e => {
                if (dialog.version() === token) openAlert(dialog, "Spawn history", e instanceof Error ? e.message : String(e))
              })
          }}
        />,
      )
    })
    .catch(e => {
      if (dialog.version() === listToken) openAlert(dialog, "Spawn history", e instanceof Error ? e.message : String(e))
    })
}
