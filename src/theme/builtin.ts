/**
 * Lazy theme registry. Names come from the manifest; bodies load on demand
 * via ./load (see also ./manifest for the picker's preview colors).
 */

import { NAMES } from "./manifest"

/** Default active theme at first boot (before prefs.theme is set). */
export const DEFAULT_THEME = "tokyonight"

/** All built-in theme names, sorted. Re-exported from ./manifest. */
export const THEME_NAMES = NAMES
