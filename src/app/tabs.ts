// Top-level tab registry. The four groups consolidate the earlier 12-tab
// sprawl; inner views are reached via each group's sub-tab bar (see
// tabs/SessionsGroup / Automation / ConfigGroup).
//
// SUB_TABS keys MUST match TABS indices; each entry is the ordered list of
// sub-tab names shown in the group's sub-tab strip. SLASH_SUB maps slash
// command names to the sub-tab label they jump to, so `/memory` opens the
// Memory sub-tab inside Config.

export const TABS = [
  { name: "Chat",                 description: "Main chat interface" },
  { name: "Sessions",             description: "Sessions, context, analytics" },
  { name: "Profiles & Automation",description: "Profiles, cron jobs, kanban boards" },
  { name: "Config",               description: "Config, env, skills, toolsets, memory" },
  { name: "Eikon",                description: "Avatar studio & library" },
] as const

export const TAB_MAX = TABS.length - 1
export const CHAT_TAB = 0
export const SESSIONS_TAB = 1
export const AUTOMATION_TAB = 2
export const CONFIG_TAB = 3
export const EIKON_TAB = 4

export const SUB_TABS: Record<number, readonly string[]> = {
  [SESSIONS_TAB]:   ["List", "Context", "Analytics", "Journey"],
  [AUTOMATION_TAB]: ["Kanban", "Profiles", "Cron"],
  [CONFIG_TAB]:     ["Config", "Skills", "Toolsets", "Env", "Memory"],
  [EIKON_TAB]:      ["Library", "Catalog", "Studio"],
}

/** Slash-command name → {tab, sub}. `sub` is the sub-tab index within that
 *  group (0 when the slash targets the group's landing view). */
export const TAB_SLASH: Record<string, { tab: number; sub: number }> = {
  chat:       { tab: CHAT_TAB,       sub: 0 },
  sessions:   { tab: SESSIONS_TAB,   sub: 0 },
  context:    { tab: SESSIONS_TAB,   sub: 1 },
  analytics:  { tab: SESSIONS_TAB,   sub: 2 },
  insights:   { tab: SESSIONS_TAB,   sub: 2 },
  journey:    { tab: SESSIONS_TAB,   sub: 3 },
  learning:   { tab: SESSIONS_TAB,   sub: 3 },
  "memory-graph": { tab: SESSIONS_TAB, sub: 3 },
  kanban:     { tab: AUTOMATION_TAB, sub: 0 },
  automation: { tab: AUTOMATION_TAB, sub: 0 },
  profiles:   { tab: AUTOMATION_TAB, sub: 1 },
  agents:     { tab: AUTOMATION_TAB, sub: 1 },
  cron:       { tab: AUTOMATION_TAB, sub: 2 },
  config:     { tab: CONFIG_TAB,     sub: 0 },
  skills:     { tab: CONFIG_TAB,     sub: 1 },
  toolsets:   { tab: CONFIG_TAB,     sub: 2 },
  env:        { tab: CONFIG_TAB,     sub: 3 },
  memory:     { tab: CONFIG_TAB,     sub: 4 },
  library:    { tab: EIKON_TAB,      sub: 0 },
  catalog:    { tab: EIKON_TAB,      sub: 1 },
  studio:     { tab: EIKON_TAB,      sub: 2 },
}
