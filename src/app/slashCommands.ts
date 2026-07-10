/**
 * Slash command definitions for the chat input.
 *
 * Commands are fetched dynamically from Hermes `GET /api/commands` — the
 * unified registry of built-ins + skills + plugins + MCP prompts. Local
 * commands are kept as a fallback while the gateway is unreachable and are
 * merged with the gateway catalog once it is ready.
 *
 * `target` is derived: "local" if the name is a client-handled command,
 * otherwise "gateway" (forwarded as /{name} to the Hermes API).
 */

import { SKINS } from "../context/skin"

export type SlashSource = "command" | "skill" | "plugin" | "mcp" | "local"

export type SlashCommand = {
  readonly name: string
  readonly description: string
  readonly category: string
  readonly aliases: ReadonlyArray<string>
  readonly argsHint: string
  readonly subcommands: ReadonlyArray<string>
  readonly source: SlashSource
  readonly target: "local" | "gateway"
  readonly keybind?: string
}

/**
 * Descriptions for locally-handled commands. Used to render them in the
 * popover when the gateway registry doesn't include them (or to override
 * the gateway's description for things like /new, which we intercept).
 */
export const LOCAL_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "clear", description: "Clear chat messages",       category: "Client", aliases: [],       argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "new",   description: "Start a new session",        category: "Client", aliases: ["reset"], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "theme", description: "Switch color theme or mode", category: "Client", aliases: [],       argsHint: "[light|dark]", subcommands: [], source: "local", target: "local" },
  { name: "help",  description: "Show keyboard shortcuts",    category: "Client", aliases: [],       argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "keys",  description: "Rebind keyboard shortcuts",  category: "Client", aliases: [],       argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "logs",  description: "Show gateway stderr log",    category: "Client", aliases: [],       argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "title", description: "Set session title",          category: "Client", aliases: [],       argsHint: "[text]", subcommands: [], source: "local", target: "local" },
  { name: "rollback", description: "Browse & restore checkpoints", category: "Client", aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "history",  description: "Server-side transcript viewer", category: "Info",   aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "status",  description: "Version, model, paths",       category: "Info",   aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "usage",   description: "Credits, account status, tokens, context fill, cost", category: "Info", aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "profile", description: "Active profile details",       category: "Info",   aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "journey", description: "Open the learning journey graph", category: "Info", aliases: ["learning", "memory-graph"], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "steer",   description: "Inject a note mid-turn (no interrupt)", category: "Session", aliases: [], argsHint: "[text]", subcommands: [], source: "local", target: "local" },
  { name: "reload-mcp", description: "Restart MCP servers & rediscover tools", category: "Session", aliases: [], argsHint: "[now|always]", subcommands: ["now", "always"], source: "local", target: "local" },
  { name: "reload", description: "Hot-reload ~/.hermes/.env (API keys)", category: "Session", aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "reload-skills", description: "Re-scan ~/.hermes/skills/ for added/removed skills", category: "Session", aliases: ["reload_skills"], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "chafa",  description: "Render image via chafa (demo)",       category: "Client",  aliases: [], argsHint: "<path>", subcommands: [], source: "local", target: "local" },
  { name: "splash", description: "Show the launch splash",              category: "Client",  aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "goal",   description: "Set/control the session goal",        category: "Session", aliases: [], argsHint: "[text|done|pause|resume|clear|status]", subcommands: ["done", "pause", "resume", "clear", "status"], source: "command", target: "gateway" },
  { name: "skin",   description: "Switch Hermes skin (+ theme + eikon)", category: "Client",  aliases: [], argsHint: "[name]", subcommands: [...SKINS], source: "local", target: "local" },
  { name: "voice",  description: "Toggle voice recording",               category: "Client",  aliases: [], argsHint: "[on|off|status|tts]", subcommands: ["on", "off", "status", "tts"], source: "local", target: "local" },
  { name: "queue",  description: "Queue a prompt for the next idle turn", category: "Session", aliases: ["q"], argsHint: "[text]", subcommands: [], source: "local", target: "local" },
  { name: "yolo",   description: "Toggle approval bypass",                 category: "Session", aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "quit",   description: "Exit herm",                             category: "Exit",    aliases: ["exit"], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "stash",  description: "Park the prompt (pop/list to restore)", category: "Client",  aliases: [], argsHint: "[pop|list]", subcommands: ["pop", "list"], source: "local", target: "local" },
  { name: "undo",   description: "Remove the last conversation turn",     category: "Session", aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "redo",   description: "Re-send the last undone message",       category: "Session", aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "retry",  description: "Rewind and re-send the last user turn",  category: "Session", aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "setup", description: "Show setup guidance", category: "Client", aliases: [], argsHint: "", subcommands: [], source: "local", target: "local" },
  { name: "branch", description: "Fork current conversation",              category: "Session", aliases: ["fork"], argsHint: "[name]", subcommands: [], source: "local", target: "local" },
  { name: "compress", description: "Compress conversation context",         category: "Session", aliases: ["compact"], argsHint: "[here [N] | focus topic | --preview|--dry-run]", subcommands: [], source: "local", target: "local" },
  { name: "browser", description: "Connect/disconnect a CDP browser",      category: "Session", aliases: [], argsHint: "[connect|disconnect|status] [url]", subcommands: ["connect", "disconnect", "status"], source: "local", target: "local" },
]

// These arrive from the gateway catalog but still execute in-process because
// they mutate live TUI/session state that slash.exec cannot own.
const INTERCEPT = ["save", "resume", "model", "copy", "paste", "image", "background", "mouse", "redraw"]

/** Commands handled locally by app/slash.tsx and never forwarded to slash.exec. */
export const LOCAL_NAMES = new Set([
  ...LOCAL_COMMANDS.filter(command => command.target === "local").map(command => command.name),
  ...INTERCEPT,
])

/** Filter commands by prefix (text after `/`). Searches names + aliases. */
export function filter(list: ReadonlyArray<SlashCommand>, prefix: string): SlashCommand[] {
  if (!prefix) return [...list]
  const q = prefix.toLowerCase()
  return list.filter(c =>
    c.name.toLowerCase().startsWith(q) ||
    c.aliases.some(a => a.toLowerCase().startsWith(q))
  )
}

type Resolved =
  | { hit: SlashCommand }
  | { miss: true }
  | { ambiguous: string[] }

/**
 * Resolve a typed command name to a single SlashCommand. Exact name or
 * alias wins even when it's also a prefix of something longer (`/status`
 * vs `/statusbar`). Otherwise a unique prefix match across the names +
 * aliases space resolves; multiple distinct targets is ambiguous.
 */
export function resolve(list: ReadonlyArray<SlashCommand>, name: string): Resolved {
  const q = name.toLowerCase()
  for (const c of list)
    if (c.name.toLowerCase() === q || c.aliases.some(a => a.toLowerCase() === q))
      return { hit: c }
  const hits = new Set<SlashCommand>()
  for (const c of list)
    for (const n of [c.name, ...c.aliases])
      if (n.toLowerCase().startsWith(q)) { hits.add(c); break }
  if (hits.size === 1) return { hit: [...hits][0] }
  if (hits.size === 0) return { miss: true }
  return { ambiguous: [...hits].map(c => `/${c.name}`).sort() }
}

/**
 * If input matches `/cmd <sub>` (with space) and the command has declared
 * subcommands, return synthetic entries for subcommand completion.
 */
export function matchSub(list: ReadonlyArray<SlashCommand>, input: string): SlashCommand[] | null {
  const m = input.match(/^\/(\w+)\s+(\S*)$/)
  if (!m) return null
  const name = m[1]
  const sub = m[2]
  const cmd = list.find(c => c.name === name || c.aliases.includes(name))
  if (!cmd || cmd.subcommands.length === 0) return null
  const q = sub.toLowerCase()
  const matches = cmd.subcommands.filter(s => s.toLowerCase().startsWith(q))
  if (matches.length === 0) return null
  return matches.map(s => ({
    ...cmd,
    name: `${cmd.name} ${s}`,
    description: `${cmd.name} → ${s}`,
    argsHint: "",
    subcommands: [],
  }))
}

/** Category ordering for display. Unknown categories fall to the end. */
const CATEGORY_ORDER = [
  "Client",
  "Session",
  "Configuration",
  "Config",
  "Tools & Skills",
  "Skills",
  "Plugins",
  "MCP",
  "Info",
  "Exit",
] as const

export function sort(list: ReadonlyArray<SlashCommand>): SlashCommand[] {
  const idx = (c: string) => {
    const i = (CATEGORY_ORDER as readonly string[]).indexOf(c)
    return i < 0 ? 999 : i
  }
  return [...list].sort((a, b) => {
    const ca = idx(a.category) - idx(b.category)
    return ca !== 0 ? ca : a.name.localeCompare(b.name)
  })
}
