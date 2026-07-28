// Accumulates subagent.* events across a turn so the completed spawn
// tree can be persisted via `spawn_tree.save` and later browsed with
// `spawn_tree.list`/`load`. The accumulator is module-level (one turn
// runs at a time per session); `flush()` is called from the app-level
// onTurnComplete side-effect.

import type { Gateway } from "../context/gateway"
import type { SubagentPayload, SpawnSubagent } from "../context/wire"

type Event = "start" | "thinking" | "tool" | "progress" | "complete"

const TRAIL_MAX = 20
const acc = new Map<string, SpawnSubagent>()

export function record(ev: Event, p: SubagentPayload): void {
  const id = p.subagent_id
  if (!id) return
  const now = Date.now() / 1000

  if (ev === "start") {
    acc.set(id, {
      subagent_id: id,
      parent_id: p.parent_id ?? null,
      depth: p.depth ?? 0,
      goal: p.goal,
      model: p.model,
      started_at: now,
      tool_count: 0,
      status: "running",
      trail: [],
    })
    return
  }

  const r = acc.get(id)
  if (!r) return

  if (ev === "tool" && p.tool_name) {
    r.tool_count++
    r.trail = [...(r.trail ?? []), { name: p.tool_name, preview: p.tool_preview }].slice(-TRAIL_MAX)
    return
  }

  if (ev === "complete") {
    r.status = p.status ?? "completed"
    r.finished_at = now
    r.input_tokens = p.input_tokens
    r.output_tokens = p.output_tokens
    r.cost_usd = p.cost_usd
  }
}

/** Live read for the Agents-tab detail panel (running children only). */
export function trail(id: string): ReadonlyArray<{ name: string; preview?: string }> {
  return acc.get(id)?.trail ?? []
}

export function clear(): void {
  acc.clear()
}

/** Persist the turn's tree (best-effort) and clear the accumulator. */
export function flush(gw: Gateway, sessionId: string): void {
  if (acc.size === 0) return
  const subagents = [...acc.values()]
  acc.clear()

  const roots = subagents.filter(s => s.parent_id == null)
  const label = (roots.slice(0, 2).map(s => s.goal).join(" · ") || `${subagents.length} subagents`).slice(0, 120)
  const started = Math.min(...subagents.map(s => s.started_at))

  gw.request("spawn_tree.save", {
    session_id: sessionId,
    label,
    started_at: started,
    finished_at: Date.now() / 1000,
    subagents,
  }).catch(() => {})
}
