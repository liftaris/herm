/**
 * Theme React context — provides resolved theme to all components.
 *
 * Usage:
 *   // In app root:
 *   <ThemeProvider><App /></ThemeProvider>
 *
 *   // In any component:
 *   const { theme, name, mode, set, setMode, names } = useTheme();
 *   <box backgroundColor={theme.backgroundPanel}>
 *   <text fg={theme.text}>
 */

import { createContext, useState, useCallback, useMemo, useEffect } from "react"
import { makeUse } from "../context/helper"
import type { ReactNode } from "react"
import type { SyntaxStyle } from "@opentui/core"
import type { Theme } from "./types"
import { resolveTheme } from "./resolve"
import { DEFAULT_THEME, THEME_NAMES } from "./builtin"
import { load, get } from "./load"
import { syntax } from "./syntax"
import { userThemes } from "./user"
import * as preferences from "../context/preferences"

interface ThemeContext {
  /** Resolved theme — all RGBA values ready for JSX props */
  theme: Theme
  /** SyntaxStyle for code/markdown rendering */
  syntaxStyle: SyntaxStyle
  /** Currently active theme name */
  name: string
  /** Dark or light mode */
  mode: "dark" | "light"
  /** Switch to a theme by name. Returns false if not found. */
  set: (name: string) => boolean
  /** Switch between dark and light variants. */
  setMode: (mode: "dark" | "light") => void
  /** All available theme names, sorted */
  names: readonly string[]
  /** Check if a theme exists */
  has: (name: string) => boolean
}

const Ctx = createContext<ThemeContext | null>(null)

interface ThemeProviderProps {
  children: ReactNode
  initial?: string
  mode?: "dark" | "light"
}

const THEMES_SET = new Set(THEME_NAMES)

export const ThemeProvider = ({
  children,
  initial,
  mode: initialMode = "dark",
}: ThemeProviderProps) => {
  // Active theme is a preference, not component state — usePref makes
  // it follow prefs.reload() so profile-switch retints without a
  // remount. `initial` wins only when no pref is set (tests / fresh
  // install); production passes initial=prefs.theme so they agree at
  // boot and the pref drives thereafter.
  const pref = preferences.usePref("theme")
  const modePref = preferences.usePref("themeMode")
  const rev = preferences.useRev()
  const users = useMemo(() => userThemes(), [pref, rev])
  const names = useMemo(() => [...new Set([...THEME_NAMES, ...Object.keys(users)])].sort(), [users])
  const hasName = useCallback((name: string) => THEMES_SET.has(name) || users[name] !== undefined, [users])
  const active = pref && hasName(pref) ? pref : initial && hasName(initial) ? initial : DEFAULT_THEME
  const mode = modePref === "light" || modePref === "dark" ? modePref : initialMode
  const [tick, force] = useState(0)

  // Theme bodies load lazily — each call to `set(name)` triggers an
  // import() on first hit, then resolves instantly on repeat. The
  // active theme is primed in src/index.tsx before render so the
  // first frame paints with its colors; the DEFAULT_THEME fallback
  // handles any theme whose body isn't cached yet (e.g. one frame of
  // lag during picker preview).
  useEffect(() => {
    if ((users[active] || get(active)) && get(DEFAULT_THEME)) return
    let cancelled = false
    const need = [active, DEFAULT_THEME].filter(n => !users[n] && !get(n) && THEMES_SET.has(n))
    Promise.all(need.map(n => load(n).catch(() => undefined))).then(() => {
      if (!cancelled) force(n => n + 1)
    })
    return () => { cancelled = true }
  }, [active, users])

  const resolved = useMemo(() => {
    const json = users[active] ?? get(active) ?? get(DEFAULT_THEME)
    if (!json) return null
    try {
      return resolveTheme(json, mode)
    } catch {
      const fallback = get(DEFAULT_THEME)
      return fallback ? resolveTheme(fallback, mode) : null
    }
    // tick included so the memo recomputes after a lazy load resolves.
  }, [active, mode, tick, users])

  const set = useCallback((name: string) => {
    if (!hasName(name)) return false
    preferences.set("theme", name)
    if (THEMES_SET.has(name) && !get(name)) load(name).catch(() => {})
    return true
  }, [hasName])

  const setMode = useCallback((mode: "dark" | "light") => {
    preferences.set("themeMode", mode)
  }, [])

  const has = hasName

  const syntaxStyle = useMemo(
    () => (resolved ? syntax(resolved) : null),
    [resolved],
  )

  const value = useMemo<ThemeContext | null>(() => {
    if (!resolved || !syntaxStyle) return null
    return {
      theme: resolved,
      syntaxStyle,
      name: active,
      mode,
      set,
      setMode,
      names,
      has,
    }
  }, [resolved, syntaxStyle, active, mode, set, setMode, names, has])

  if (!value) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Access the current theme. Must be inside <ThemeProvider>. */
export const useTheme = makeUse(Ctx, "useTheme")
