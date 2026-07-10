// Action catalog — the curated set of named, rebindable key actions.
//
// Each ActionId maps to a default chord string (see chord.ts for grammar),
// a human description, and a scope. Scope drives Help grouping and tells
// the migration which handler owns the match:
//
//   global    shell-level (useAppKeys) — fires regardless of focused tab
//   list      shared nav vocabulary consumed by useListKeys across tabs/dialogs
//   dialog    modal overlays
//   composer  textarea keyBindings (fed via toBindings)
//   <tab>     tab-local, matched only when that tab is focused
//
// `<leader>` is a two-stroke prefix (default Ctrl+X, rebindable via the
// `leader` entry). Existing Ctrl-chords are kept as secondary alternates
// so nothing breaks while the leader pattern settles; print() shows the
// first alternate, so Help advertises the leader form.

export type Scope =
  | "global" | "list" | "dialog" | "composer"
  | "sessions" | "cron" | "env" | "agents" | "skills" | "config" | "eikon"

export type Def = { chord: string; desc: string; scope: Scope }

const def = (chord: string, desc: string, scope: Scope): Def => ({ chord, desc, scope })

export const DEFAULTS = {
  "leader":            def("ctrl+x",               "Leader prefix",                      "global"),
  "app.exit":          def("ctrl+c",               "Quit",                               "global"),
  // Same chord as app.exit, disjoint on buffer-empty — see useAppKeys.
  "input.clear":       def("ctrl+c",               "Clear input",                        "global"),
  "app.suspend":       def("ctrl+z",               "Suspend to shell",                   "global"),
  "app.redraw":        def("ctrl+l",               "Clear & force-repaint terminal",     "global"),
  "app.sidebar":       def("<leader>b",            "Toggle sidebar",                     "global"),
  "palette.open":      def("ctrl+k",               "Command palette",                    "global"),
  "help.open":         def("f1",                   "Keyboard shortcuts",                 "global"),
  "tab.next":          def("alt+right",            "Next tab",                           "global"),
  "tab.prev":          def("alt+left",             "Previous tab",                       "global"),
  "focus.cycle":       def("tab",                  "Cycle focus (double-tap → composer)","global"),
  "editor.open":       def("<leader>e,ctrl+g",     "Open $EDITOR on prompt",             "global"),
  "reply.copy":        def("<leader>y,ctrl+y",     "Copy last assistant reply",          "global"),
  "clipboard.attach":  def("ctrl+v",               "Attach clipboard image",             "global"),
  "queue.flush":       def("<leader>u",            "Interrupt and send queued now",      "global"),
  "session.interrupt": def("escape",               "Interrupt (double-tap while streaming)", "global"),
  "session.new":       def("<leader>n",            "New session",                        "global"),
  "session.redo":      def("<leader>r",            "Redo last undo",                     "global"),
  "session.compress":  def("<leader>c",            "Compress context",                   "global"),
  "session.steer":     def("<leader>s",            "Steer active turn",                   "global"),
  "input.stash":       def("<leader>p",            "Stash prompt draft",                 "global"),
  "session.timeline":  def("<leader>g",            "Session timeline",                   "global"),
  "theme.pick":        def("<leader>t",            "Switch theme",                       "global"),
  "model.pick":        def("<leader>m",            "Switch model",                       "global"),
  "sidebar.changes":   def("<leader>d",            "Show changed files",                 "global"),
  "status.open":       def("<leader>i",            "Show status",                        "global"),
  "list.up":           def("up",                   "Move selection up",                  "list"),
  "list.down":         def("down",                 "Move selection down",                "list"),
  "list.pageUp":       def("pageup",               "Page up",                            "list"),
  "list.pageDown":     def("pagedown",             "Page down",                          "list"),
  "list.home":         def("home",                 "First item",                         "list"),
  "list.end":          def("end",                  "Last item",                          "list"),
  "list.activate":     def("return",               "Activate / open",                    "list"),
  "list.delete":       def("d,delete",             "Delete item",                        "list"),
  "list.refresh":      def("r",                    "Reload",                             "list"),
  "list.new":          def("n",                    "Create",                             "list"),
  "list.search":       def("/",                    "Filter",                             "list"),
  "list.toggle":       def("space",                "Toggle item",                        "list"),
  "dialog.accept":     def("return",               "Accept",                             "dialog"),
  "dialog.cancel":     def("escape",               "Cancel / close",                     "dialog"),
  "dialog.confirm":    def("y",                    "Yes",                                "dialog"),
  "dialog.deny":       def("n",                    "No",                                 "dialog"),
  "dialog.copy":       def("c",                    "Copy body",                          "dialog"),
  "input.submit":      def("return",               "Send",                               "composer"),
  "input.newline":     def("shift+return,ctrl+return,alt+return,ctrl+j", "Insert newline", "composer"),
  "sessions.rename":   def("ctrl+r",               "Retitle session",                    "sessions"),
  "sessions.prev":     def("left",                 "Previous source filter",             "sessions"),
  "sessions.next":     def("right",                "Next source filter",                 "sessions"),
  "sessions.sort":     def("s",                    "Toggle sort",                        "sessions"),
  "agents.kill":       def("k",                    "Kill subagent",                      "agents"),
  "agents.history":    def("h",                    "Spawn history",                      "agents"),
  "agents.install":    def("i",                    "Install distribution",               "agents"),
  "config.save":       def("ctrl+s",               "Write config",                       "config"),
  "config.mode":       def("m",                    "Toggle form ↔ YAML",                 "config"),
  "eikon.save":        def("ctrl+s",               "Save eikon",                         "eikon"),
} satisfies Record<string, Def>

export type ActionId = keyof typeof DEFAULTS

/** Actions in a given scope, catalog order. */
export function inScope(s: Scope): ActionId[] {
  return (Object.keys(DEFAULTS) as ActionId[]).filter(id => DEFAULTS[id].scope === s)
}

// Two scopes overlap if both handlers can be live for the same keypress.
// global fires everywhere; list is active on every admin tab alongside that
// tab's own scope; dialog and composer are modal/focused surfaces that
// displace the rest; distinct tab scopes are mutually exclusive.
const TAB_SCOPES = new Set<Scope>(["sessions", "cron", "env", "agents", "skills", "config", "eikon"])
export function scopesOverlap(a: Scope, b: Scope): boolean {
  if (a === b) return true
  if (a === "global" || b === "global") return true
  if (a === "list") return TAB_SCOPES.has(b)
  if (b === "list") return TAB_SCOPES.has(a)
  return false
}
