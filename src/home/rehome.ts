// Point every ~/.hermes reader at a new HERMES_HOME, in one call.
//
// Profile-switch (herm-q73) orchestration: the gateway subprocess is
// respawned under a new home elsewhere; this handles herm's own
// process — rebinding direct filesystem/sqlite readers so every tab,
// watcher, and cache follows.
//
// Order matters: rebind cells → drop caches → re-ensure reactive
// stores (which re-arms fs watchers against the new paths).
//
// Covered:
//   hermes-home.setHome   — hermesPath() and everything built on it
//   sessions-db.setHome   — main-thread / INLINE readers
//   process.env           — io worker (sends HOME() per request),
//                           paths.configDir, hermes-profiles, eikon-picker
//   analytics cache       — keyed by days, would show stale numbers
//   kanban handle         — path via hermesPath(); handle is cached
//   preferences.reload    — theme/eikon/keys from new profile's tui.json
//   home store.reset      — drops data + rearms watchers, subs survive

import { setHome as setHermesHome } from "../service/hermes-home"
import { setHome as setDbHome } from "../service/sessions-db"
import { cache as analyticsCache } from "../service/hermes-analytics"
import { resetKanban } from "../service/hermes-kanban"
import { close as closeIo } from "../io"
import { close as closeKanbanWorker } from "../io/kanban"
import { prefs } from "../context/preferences"
import { clear as clearSpawnHistory } from "../app/spawnHistory"
import { home } from "./store"

/** Rebind all HERMES_HOME readers to `newHome` and refresh reactive
 *  state. Does NOT touch the gateway subprocess — caller owns that. */
export function rehome(newHome: string): void {
  process.env.HERMES_HOME = newHome
  setHermesHome(newHome)
  setDbHome(newHome)
  analyticsCache.clear()
  closeIo()
  clearSpawnHistory()
  resetKanban()
  closeKanbanWorker()
  prefs.reload()
  home.reset()
}
