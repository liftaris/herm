// Model-slot view over config.yaml — the "Models" category in Config.
//
// Reads are pure projections over the `config.get {key:"full"}` object
// Config.tsx already holds, so there's no second RPC. Writes route
// through the existing lanes: main → `config.set key=model` (rpc lane,
// hot-swaps the live agent and persists with --global); aux →
// `writeConfig()` (cli lane, `hermes config set auxiliary.<t>.…`).
//
// Intentionally NOT a gateway client of /api/model/auxiliary or
// /api/model/set — those are web_server-only endpoints. Everything
// here is derivable from config + the stock tui_gateway surface.

import { writeConfig, type WriteResult } from "./lane"
import type { ConfigSetResponse } from "../context/wire"

type Gw = {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

// Mirrors _AUX_TASK_SLOTS in hermes_cli/web_server.py — ordering kept
// so herm and the webui read the same top-to-bottom.
export const AUX_TASKS = [
  { key: "vision",           label: "Vision",         hint: "Image analysis" },
  { key: "compression",      label: "Compression",    hint: "Context compaction" },
  { key: "skills_hub",       label: "Skills Hub",     hint: "Skill search" },
  { key: "approval",         label: "Approval",       hint: "Smart auto-approve" },
  { key: "mcp",              label: "MCP",            hint: "MCP tool routing" },
  { key: "title_generation",  label: "Title Gen",         hint: "Session titles" },
  { key: "triage_specifier",  label: "Triage Specifier",  hint: "Kanban spec fleshing" },
  { key: "kanban_decomposer", label: "Kanban Decomposer", hint: "Task decomposition" },
  { key: "profile_describer", label: "Profile Describer", hint: "Auto profile descriptions" },
  { key: "curator",           label: "Curator",           hint: "Skill-usage review" },
] as const

export type AuxKey = typeof AUX_TASKS[number]["key"]

export type Slot =
  | { kind: "main"; key: "main"; label: string; hint: string
      provider: string; model: string; auto: false }
  | { kind: "aux"; key: AuxKey; label: string; hint: string
      provider: string; model: string; auto: boolean }

const dig = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((c, p) =>
    c && typeof c === "object" ? (c as Record<string, unknown>)[p] : undefined, o)

const str = (v: unknown) => typeof v === "string" ? v : ""

/** Project config.yaml → the main slot plus one slot per AUX_TASKS entry. */
export const readSlots = (raw: Record<string, unknown>): Slot[] => {
  const main: Slot = {
    kind: "main", key: "main", label: "Main model", hint: "Primary agent model",
    provider: str(dig(raw, "model", "provider")),
    model: str(dig(raw, "model", "default")) || str(dig(raw, "model", "name")),
    auto: false,
  }
  const aux = AUX_TASKS.map<Slot>(t => {
    const p = str(dig(raw, "auxiliary", t.key, "provider"))
    return {
      kind: "aux", key: t.key, label: t.label, hint: t.hint,
      provider: p, model: str(dig(raw, "auxiliary", t.key, "model")),
      auto: p === "" || p === "auto",
    }
  })
  return [main, ...aux]
}

export type AssignResult = WriteResult & { warning?: string }

export type AuxSlot = Extract<Slot, { kind: "aux" }>

export const staleAuxForMain = (slots: Slot[], provider: string): AuxSlot[] =>
  slots.filter((s): s is AuxSlot =>
    s.kind === "aux" && !s.auto && s.provider !== "" && s.provider !== "auto" && s.provider !== provider)

/** Write a slot. Main goes via the rpc `config.set key=model` alias
 *  (same path as /model --global — live-applies and clears stale
 *  base_url/context_length upstream). Aux writes two cli-lane keys. */
export const assign = async (
  gw: Gw, slot: Slot["key"], provider: string, model: string,
): Promise<AssignResult> => {
  if (slot === "main") {
    const r = await gw.request<ConfigSetResponse>("config.set", {
      key: "model", value: `${model} --provider ${provider} --global`,
      session_id: undefined,
    })
    return { ok: ["model.default", "model.provider"], failed: [], warnings: [], warning: r.warning }
  }
  return writeConfig(gw, [
    { key: `auxiliary.${slot}.provider`, to: provider },
    { key: `auxiliary.${slot}.model`, to: model },
  ])
}

/** Reset one aux slot (or all) to provider="auto", model="". */
export const resetAux = (gw: Gw, slot: AuxKey | "all"): Promise<WriteResult> => {
  const keys = slot === "all" ? AUX_TASKS.map(t => t.key) : [slot]
  return writeConfig(gw, keys.flatMap(k => [
    { key: `auxiliary.${k}.provider`, to: "auto" },
    { key: `auxiliary.${k}.model`, to: "" },
  ]))
}
