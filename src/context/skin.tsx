// Active Hermes skin — branding strings surfaced to UI.
// The gateway emits skin.changed with the full skin payload;
// app.tsx reduces it into this context. Consumers read agentName
// (message headers, announcements) and the raw branding map for
// future needs (prompt_symbol, welcome, etc.).

import { existsSync, readFileSync, readdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { createContext, useContext, memo, type ReactNode } from "react"
import { parse } from "yaml"
import type { GatewaySkin } from "../context/wire"

/** Hermes built-in skin ids (hermes_cli/skin_engine.py::_BUILTIN_SKINS). */
export const SKINS = [
  "default", "ares", "mono", "slate", "daylight",
  "warm-lightmode", "poseidon", "sisyphus", "charizard",
] as const

const home = () => process.env.HERMES_HOME || join(process.env.HOME || homedir(), ".hermes")

const skin = (path: string): string | null => {
  try {
    const raw = parse(readFileSync(path, "utf8"))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const name = (raw as { name?: unknown }).name
      if (typeof name === "string" && name.trim()) return name.trim()
    }
  } catch {}
  return null
}

export function skins(): string[] {
  const dir = join(home(), "skins")
  if (!existsSync(dir)) return [...SKINS]
  const extra = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".yaml"))
    .map(e => skin(join(dir, e.name)))
    .filter((name): name is string => name !== null && !(SKINS as readonly string[]).includes(name))
    .sort()
  return [...SKINS, ...new Set(extra)]
}

export function mode(name: string): "dark" | "light" | undefined {
  const n = name.toLowerCase()
  if (n.includes("light") || n === "tango-adapted") return "light"
  if (n === "tokyo-storm") return "dark"
  return undefined
}

export type SkinState = {
  skin?: GatewaySkin
  /** Preferred display label for the assistant in chat. */
  agentName: string
}

const DEFAULT: SkinState = { agentName: "Hermes" }

const Ctx = createContext<SkinState>(DEFAULT)

export function deriveSkin(skin?: GatewaySkin | null): SkinState {
  const name = skin?.branding?.agent_name?.trim()
  return { skin: skin ?? undefined, agentName: name || "Hermes" }
}

export const SkinProvider = memo(({ value, children }: { value: SkinState; children: ReactNode }) => (
  <Ctx.Provider value={value}>{children}</Ctx.Provider>
))

export function useSkin(): SkinState {
  return useContext(Ctx)
}
