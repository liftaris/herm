// Slash command catalog + live completion over RPC. Falls back to
// LOCAL_COMMANDS when the gateway catalog is unavailable.
//
// Wire shape (tui_gateway/server.py @method("commands.catalog")):
//   pairs:      [["/new", "desc"], ...]            — flat, includes skills + quick_commands
//   categories: [{name, pairs: [["/new","…"],…]}]  — registry cmds only, grouped
//   sub:        {"/reasoning": ["low","medium",…]} — subcommand completions
//   canon:      {"/reset": "/new", …}              — alias → canonical (both slashed)
// All names carry a leading "/"; herm stores them bare.

import { useCallback, useEffect, useState } from "react"
import { useGateway, useGatewayReady } from "../context/gateway"
import {
  LOCAL_NAMES,
  fallbacks,
  sort,
  type SlashCommand,
} from "./slashCommands"
import type { CommandsCatalogResponse } from "../context/wire"

const bare = (s: string) => (s[0] === "/" ? s.slice(1) : s)

export function useSlashCommands() {
  const gw = useGateway()
  const ready = useGatewayReady()
  const [cmds, setCmds] = useState<ReadonlyArray<SlashCommand>>(fallbacks)

  const fetch = useCallback(async () => {
    const res = await gw.request<CommandsCatalogResponse>("commands.catalog")
      .catch(() => null)
    const fallback = fallbacks()
    if (!res) { setCmds(fallback); return }

    // name → category (from categories[].pairs, slashed)
    const cat = new Map<string, string>()
    for (const g of res.categories ?? [])
      for (const [n] of g.pairs ?? []) cat.set(bare(n), g.name)

    // canonical → aliases[] (invert canon)
    const alias = new Map<string, string[]>()
    const addAlias = (name: string, value: string) => {
      const k = bare(name), v = bare(value)
      if (k === v) return
      const list = alias.get(k) ?? []
      if (!list.includes(v)) alias.set(k, [...list, v])
    }
    for (const l of fallback)
      for (const a of l.aliases) addAlias(l.name, a)
    for (const [a, c] of Object.entries(res.canon ?? {}))
      addAlias(c, a)

    const sub = new Map(Object.entries(res.sub ?? {}).map(([k, v]) => [bare(k), v]))
    const local = new Map(fallback.map(c => [c.name, c]))

    const remote: SlashCommand[] = (res.pairs ?? []).map(([raw, desc]) => {
      const name = bare(raw)
      const l = local.get(name)
      // /quit's gateway description carries a "(usage: /quit [--delete])" suffix
      // baked in by hermes_cli/commands._build_description. Session deletion is
      // exposed via the Sessions tab (`d` → session.delete RPC); the CLI flag is
      // dead from herm's perspective. Strip it so the popover doesn't advertise it.
      const description = name === "quit" ? desc.replace(/\s*\(usage:[^)]*\)\s*$/, "") : desc
      return {
        name,
        description,
        category: cat.get(name) ?? (name.includes(":") ? "Skills" : "Command"),
        aliases: alias.get(name) ?? [],
        argsHint: l?.argsHint ?? "",
        subcommands: sub.get(name) ?? l?.subcommands ?? [],
        source: "command" as const,
        target: LOCAL_NAMES.has(name) ? ("local" as const) : ("gateway" as const),
      }
    })

    const seen = new Set(remote.map(c => c.name))
    const locals = fallback.filter(c => !seen.has(c.name))
    setCmds(sort([...locals, ...remote]))
  }, [gw])

  useEffect(() => { if (ready) void fetch() }, [ready, fetch])

  return { cmds, refresh: fetch }
}
