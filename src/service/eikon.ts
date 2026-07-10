// ~/.hermes/eikons/ folder layout + Studio persistence + rasterizer
// registry. Each eikon lives in its own folder:
//
//   eikons/<name>/
//     <name>.eikon    packed NDJSON — shippable, no local paths
//     studio.json     workspace state (rasterizer, spatial, knobs, sources)
//     source/         base.<ext>, <state>.<ext>
//
// `save()` is the single write action (Ctrl+S): render all six states
// through the active rasterizer, write `.eikon` + `studio.json`, adopt
// any external source paths into `source/`, and bump the revision
// counter so the sidebar reloads even when the active name is unchanged.
//
// The rasterizer registry is a module-level Map. Built-ins self-insert
// at import; herm plugins register via `api.eikon.rasterizer.register`
// (scope-tracked — deactivate unregisters). Studio reads the registry
// live on every open of the rasterizer picker.

import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, statSync, renameSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, extname, basename, dirname } from "node:path"
import { defaultSignalMappings, header as peekHeader, type LaunchStreamRecord, type SourceKind } from "eikon"
import { install, resolve, peek, entries as packageEntries, downloadBytes, dirty,
         type Installed as Got, type Resolved as ResolvedEikon, type Origin as EikonOrigin, type TrustState, type DownloadOptions } from "eikon/install"
import { decodeRuntimeBytes, serializeLaunchStream, type RuntimeDescriptor } from "eikon/stream"
import { DEFAULT_PUBLIC_CATALOG } from "eikon/catalog"
import { hermesPath } from "./hermes-home"
import * as prefs from "../context/preferences"
import { parseEikon, parseEikonFile, listEikons } from "../components/avatar/eikon"
import { BUNDLED_EIKON_DIR } from "../components/avatar/bundled"
import type { AvatarState } from "../components/avatar/states"
import { BUILTIN, cached, probe, W, H, type Rasterizer, type Frame } from "../utils/eikon-render"
import { STATES, eff, toStudio, fresh, type Session, type Studio } from "../utils/eikon-knobs"

const ROOT = () => hermesPath("eikons")

export const dir = (name: string) => join(ROOT(), name)
export const file = (name: string) => join(dir(name), `${name}.eikon`)
const flat = (name: string) => join(ROOT(), `${name}.eikon`)
export const sourceDir = (name: string) => join(dir(name), "source")
export const studioFile = (name: string) => join(dir(name), "studio.json")

export function ensure(name: string) {
  mkdirSync(sourceDir(name), { recursive: true })
  return { dir: dir(name), file: file(name), source: sourceDir(name) }
}

export type SourceInfo = {
  kind: SourceKind | "unknown"
  identity?: string
  origin?: string
  repo?: string
  selector?: string
  catalogRoot?: string
  sha?: string
  packageUrl?: string
}

export type LifecycleInfo = {
  name: string
  title?: string
  author?: string
  version?: string
  source: SourceInfo
  trust: TrustState | "unknown"
  active: boolean
  removable: boolean
  updateable: boolean
  updateAvailable: boolean
  dirty: boolean
  poster?: string
  compatibility?: Record<string, unknown>
  installedAt?: string
}

export type Installed = {
  name: string; file: string; source: string
  hasSource: boolean; sourceUrl?: string
  manifest?: Record<string, unknown>
  lifecycle: LifecycleInfo
}

export type InspectInfo = LifecycleInfo & {
  installed: boolean
  sourceLabel: string
  previewAvailable: boolean
  posterAvailable: boolean
  n?: number
  bytes?: number
  reason?: string
}

export type ActiveConsequence = {
  type: "active-consequence"
  action: "remove" | "update"
  name: string
  message: string
}

function manifest(name: string): Record<string, unknown> | undefined {
  const p = join(dir(name), "manifest.json")
  if (!existsSync(p)) return undefined
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"))
    if (raw && typeof raw === "object") return raw as Record<string, unknown>
  } catch {}
  return undefined
}

const LEGACY_SOURCE_URL = "source_url"
const OBJ = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)

function originObject(man: Record<string, unknown> | undefined): (EikonOrigin & { trust?: TrustState }) | undefined {
  const o = man?.origin
  return OBJ(o) ? o as EikonOrigin & { trust?: TrustState } : undefined
}

function origin(man: Record<string, unknown> | undefined): string | undefined {
  const src = originObject(man)?.source
  return typeof src === "string" ? src : undefined
}

function legacySource(head: Record<string, unknown> | undefined): string | undefined {
  const src = head?.[LEGACY_SOURCE_URL]
  return typeof src === "string" ? src : undefined
}

function display(man: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return OBJ(man?.display) ? man.display : undefined
}

function sourceInfo(man: Record<string, unknown> | undefined, head: Record<string, unknown> | undefined): SourceInfo {
  const o = originObject(man)
  const src = typeof o?.source === "string" ? o.source : legacySource(head)
  const identity = o?.identityKey ?? o?.sourceKey ?? o?.packageUrl ?? o?.repo ?? src
  return {
    kind: o?.kind ?? "unknown",
    ...(identity ? { identity } : {}),
    ...(src ? { origin: src } : {}),
    ...(o?.repo ? { repo: o.repo } : {}),
    ...(o?.selector ? { selector: o.selector } : {}),
    ...(o?.catalogRoot ? { catalogRoot: o.catalogRoot } : {}),
    ...(o?.sha ? { sha: o.sha } : {}),
    ...(o?.packageUrl ? { packageUrl: o.packageUrl } : {}),
  }
}

function displayTitle(man: Record<string, unknown> | undefined): string | undefined {
  const disp = display(man)
  return typeof disp?.title === "string" ? disp.title : typeof man?.title === "string" ? man.title : undefined
}

function displayAuthor(man: Record<string, unknown> | undefined): string | undefined {
  const disp = display(man)
  return typeof disp?.author === "string" ? disp.author : typeof man?.author === "string" ? man.author : undefined
}

function sourceLabel(src: SourceInfo): string {
  const id = src.repo ?? src.identity ?? src.origin ?? src.packageUrl
  if (!id) return src.kind
  if (src.sha) return `${src.kind} ${id}@${src.sha.slice(0, 12)}`
  return `${src.kind} ${id}`
}

function inspectResolved(src: string, r: ResolvedEikon, stat?: { n: number; bytes: number } | undefined): InspectInfo {
  const man = r.manifest as Record<string, unknown>
  const o = r.origin as EikonOrigin & { trust?: TrustState }
  const info: SourceInfo = {
    kind: o.kind ?? "unknown",
    ...(o.identityKey || o.sourceKey || o.packageUrl || o.repo || o.source ? { identity: o.identityKey ?? o.sourceKey ?? o.packageUrl ?? o.repo ?? o.source } : {}),
    ...(o.source ? { origin: o.source } : {}),
    ...(o.repo ? { repo: o.repo } : {}),
    ...(o.selector ? { selector: o.selector } : {}),
    ...(o.catalogRoot ? { catalogRoot: o.catalogRoot } : {}),
    ...(o.sha ? { sha: o.sha } : {}),
    ...(o.packageUrl ? { packageUrl: o.packageUrl } : {}),
  }
  const compatibility = OBJ(man.compatibility) ? man.compatibility : undefined
  const poster = typeof man.poster === "string" ? man.poster : undefined
  const preview = typeof man.preview === "string" ? man.preview : undefined
  const out: InspectInfo = {
    name: r.name,
    ...(displayTitle(man) ? { title: displayTitle(man) } : {}),
    ...(displayAuthor(man) ? { author: displayAuthor(man) } : {}),
    ...(typeof man.version === "string" ? { version: man.version } : {}),
    source: info,
    trust: r.trust.state,
    active: prefs.get("eikon") === r.name,
    removable: false,
    updateable: true,
    updateAvailable: false,
    dirty: false,
    ...(poster ? { poster } : {}),
    ...(preview ? { preview } : {}),
    ...(compatibility ? { compatibility } : {}),
    installed: existsSync(file(r.name)),
    sourceLabel: sourceLabel(info),
    previewAvailable: Boolean(preview || (man as { entrypoints?: { default?: unknown } }).entrypoints?.default),
    posterAvailable: Boolean(poster),
    ...(stat ? { n: stat.n, bytes: stat.bytes } : {}),
    ...(r.trust.reason ? { reason: r.trust.reason } : {}),
  }
  if (!out.source.origin) out.source.origin = src
  return out
}

function changed(name: string) {
  try { return dirty(dir(name)) } catch { return false }
}

export function lifecycle(name: string, opts: { dirty?: boolean } = {}): LifecycleInfo {
  const man = manifest(name)
  const head = header(file(name))
  const src = sourceInfo(man, head)
  const title = displayTitle(man)
  const author = displayAuthor(man)
  const version = typeof man?.version === "string" ? man.version : undefined
  const compatibility = OBJ(man?.compatibility) ? man.compatibility : undefined
  const installedAt = originObject(man)?.at
  const hasOrigin = Boolean(src.origin ?? src.packageUrl)
  const isDirty = opts.dirty !== false && existsSync(dir(name)) ? changed(name) : false
  return {
    name,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(version ? { version } : {}),
    source: src,
    trust: originObject(man)?.trust ?? (src.origin ? "unverified" : "unknown"),
    active: prefs.get("eikon") === name,
    removable: existsSync(file(name)),
    updateable: hasOrigin,
    updateAvailable: false,
    dirty: isDirty,
    ...(typeof man?.poster === "string" ? { poster: man.poster } : {}),
    ...(typeof man?.preview === "string" ? { preview: man.preview } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(installedAt ? { installedAt } : {}),
  }
}

/** List folder-form eikons under ~/.hermes/eikons/. Flat legacy
 *  <name>.eikon at the root is still readable by listEikons() in
 *  components/avatar/eikon.ts but doesn't appear here (no studio). */
export function list(): Installed[] {
  const root = ROOT()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(root, e.name, `${e.name}.eikon`)))
    .map(e => {
      const name = e.name
      normalizeStoredSources(name)
      const man = manifest(name)
      const path = join(root, name, `${name}.eikon`)
      return {
        name, file: path,
        source: join(root, name, "source"), hasSource: hasLocalSource(name),
        sourceUrl: sourceUrl(man, header(path)),
        manifest: man,
        lifecycle: lifecycle(name, { dirty: false }),
      }
    })
}

/** Folder names under eikons/ regardless of whether they've been
 *  saved yet — used by the Open picker so a fresh `ensure()`d draft
 *  (which `list()` skips until it has a .eikon) is still reachable. */
export function raw(): string[] {
  const root = ROOT()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name)
}

const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i
const VID = /\.(mp4|webm|mov|mkv)$/i
const MEDIA_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
}

type SourceFile = { path?: string; mediaType?: string }
type SourceManifest = { files?: SourceFile[] }

function slot(role: string): role is keyof Sources & string {
  return role === "base" || STATES.includes(role as AvatarState)
}

export function sourceExt(man: SourceManifest | undefined, rel: string): string {
  const ext = extname(rel).toLowerCase()
  if (ext) return ext
  const type = man?.files?.find(f => f.path === rel)?.mediaType?.split(";")[0]?.trim().toLowerCase()
  return type ? MEDIA_EXT[type] ?? "" : ""
}

export function sourceName(man: SourceManifest | undefined, role: string, rel: string): string {
  return `${role}${sourceExt(man, rel)}`
}

function sourceRefs(man: SourceManifest | undefined): Map<string, string> {
  if (!man) return new Map()
  try {
    return new Map(packageEntries(man as never)
      .filter(([role]) => slot(String(role)))
      .map(([role, rel]) => [String(role), rel]))
  } catch {
    return new Map()
  }
}

function normalizeSources(name: string, sources: Sources): Sources {
  const man = manifest(name) as SourceManifest | undefined
  const refs = sourceRefs(man)
  const root = sourceDir(name)
  return Object.fromEntries(Object.entries(sources).map(([role, fname]) => {
    if (!fname) return [role, fname]
    const rel = refs.get(role)
    const next = rel ? sourceName(man, role, rel) : fname
    if (next === fname) return [role, fname]
    const from = join(root, fname)
    const to = join(root, next)
    if (existsSync(from) && !existsSync(to)) renameSync(from, to)
    return [role, existsSync(to) ? next : fname]
  })) as Sources
}

function sameSources(a: Sources, b: Sources): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function normalizeStudioSources(name: string, s: Studio): Studio {
  const prev = s.sources ?? {}
  const sources = normalizeSources(name, prev)
  if (sameSources(prev, sources)) return s
  const next = { ...s, sources }
  writeFileSync(studioFile(name), JSON.stringify(next, null, 2) + "\n", "utf8")
  return next
}

function normalizeStoredSources(name: string): void {
  try { readStudio(name) } catch {}
}

export type Sources = Partial<Record<AvatarState | "base", string | null>>
export type SourceRole = AvatarState | "base"
export type SourceStatus = {
  name: string
  state: AvatarState
  kind: "local" | "downloadable" | "baked" | "missing"
  path?: string
  file?: string
  size?: number
  role?: SourceRole
  origin?: "draft" | "studio" | "discovered" | "fallback"
  own: boolean
  inherited: boolean
  removed: boolean
  downloadable: boolean
  sourceUrl?: string
}

function fileOk(name: string): boolean {
  return IMG.test(name) || VID.test(name)
}

function roleOf(name: string): SourceRole | undefined {
  const stem = basename(name, extname(name)).toLowerCase()
  if (stem === "base") return "base"
  return (STATES as readonly string[]).includes(stem) ? stem as AvatarState : undefined
}

function sourcePath(name: string, value: string): string {
  return value.includes("/") ? value : join(sourceDir(name), value)
}

function storedName(value: string): string {
  return value.includes("/") ? basename(value) : value
}

function sourceFiles(name: string) {
  const src = sourceDir(name)
  if (!existsSync(src)) return []
  return readdirSync(src).filter(fileOk)
}

function byRole(files: string[], role: SourceRole): string | undefined {
  return files.find(f => roleOf(f) === role)
}

function roles(state?: AvatarState): SourceRole[] {
  if (!state) return ["base", "idle"]
  return state === "idle" ? ["idle", "base"] : [state, "base", "idle"]
}

function entryRole(value: string | undefined, path: string): SourceRole | undefined {
  if (value === "source.base") return "base"
  if (value?.startsWith("source.")) {
    const role = value.slice("source.".length)
    if (role === "base") return "base"
    if ((STATES as readonly string[]).includes(role)) return role as AvatarState
  }
  return roleOf(path) ?? "base"
}

function sourceEntries(man: Record<string, unknown> | undefined, strict = false): Array<[SourceRole, string]> {
  if (!man) return []
  try {
    const xs = packageEntries(man as never).map(([role, path]) => [role as SourceRole, path] as [SourceRole, string])
    if (xs.length) return xs
  } catch (err) {
    if (strict) throw err
  }
  const files = Array.isArray(man.files) ? man.files : []
  return files.flatMap(file => {
    if (typeof file === "string") return [[entryRole(undefined, file) ?? "base", file] as [SourceRole, string]]
    if (!OBJ(file) || typeof file.path !== "string" || !String(file.role ?? "").startsWith("source")) return []
    const role = entryRole(typeof file.role === "string" ? file.role : undefined, file.path)
    return role ? [[role, file.path] as [SourceRole, string]] : []
  })
}

function sourceUrl(man: Record<string, unknown> | undefined, head: Record<string, unknown> | undefined): string | undefined {
  const src = sourceInfo(man, head)
  return src.packageUrl ?? src.origin
}

export function sourceFetchUrl(name: string): string | undefined {
  return sourceUrl(manifest(name), header(file(name)))
}

export function sourceStatus(name: string, state?: AvatarState, opts: { sources?: Sources } = {}): SourceStatus {
  const seed = opts.sources ?? readStudio(name)?.sources
  const files = sourceFiles(name)
  const removed = new Set(Object.entries(seed ?? {}).flatMap(([role, value]) => value === null ? [role] : []))
  const visible = files.filter(f => {
    const role = roleOf(f)
    return !role || !removed.has(role)
  })
  const hit = (role: SourceRole): Pick<SourceStatus, "path" | "file" | "role" | "origin"> | undefined => {
    if (removed.has(role)) return undefined
    const value = seed?.[role]
    if (typeof value === "string" && value) {
      const path = sourcePath(name, value)
      if (existsSync(path) && fileOk(path)) return { path, file: storedName(value), role, origin: opts.sources ? "draft" : "studio" }
    }
    const file = byRole(visible, role)
    return file ? { path: join(sourceDir(name), file), file, role, origin: "discovered" } : undefined
  }
  const found = roles(state).map(hit).find(Boolean)
  const first = removed.size ? undefined : visible.find(f => IMG.test(f)) ?? visible.find(f => VID.test(f))
  const src = found ?? (first ? { path: join(sourceDir(name), first), file: first, role: roleOf(first), origin: "fallback" as const } : undefined)
  const st = state ?? "idle"
  const own = Boolean(src?.role && (src.role === st || (st === "idle" && src.role === "base")))
  const man = manifest(name)
  const pack = baked(name)
  const head = header(file(name)) ?? (pack ? header(pack) : undefined)
  const url = sourceUrl(man, head)
  const downloadable = !src && Boolean(url)
  const size = src?.path ? (() => { try { return statSync(src.path).size } catch { return undefined } })() : undefined
  return {
    name,
    state: st,
    kind: src ? "local" : downloadable ? "downloadable" : pack ? "baked" : "missing",
    ...(src?.path ? { path: src.path } : {}),
    ...(src?.file ? { file: src.file } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(src?.role ? { role: src.role } : {}),
    ...(src?.origin ? { origin: src.origin } : {}),
    own,
    inherited: Boolean(src && !own),
    removed: roles(state).some(role => removed.has(role)),
    downloadable,
    ...(url ? { sourceUrl: url } : {}),
  }
}

export function localSources(name: string): Array<{ role?: SourceRole; file: string; path: string }> {
  return sourceFiles(name).map(file => ({ file, path: join(sourceDir(name), file), ...(roleOf(file) ? { role: roleOf(file) } : {}) }))
}

export function hasLocalSource(name: string): boolean {
  if (sourceFiles(name).length > 0) return true
  return Object.values(readStudio(name)?.sources ?? {}).some(value =>
    typeof value === "string" && fileOk(value) && existsSync(sourcePath(name, value)))
}

export function sourceStamp(name: string): string {
  const src = sourceDir(name)
  const stats = [studioFile(name), existsSync(file(name)) ? file(name) : ""].filter(Boolean).map(path => {
    try { const st = statSync(path); return `${basename(path)}:${st.mtimeMs}:${st.size}` } catch { return `${basename(path)}:missing` }
  })
  const media = sourceFiles(name).sort().map(f => {
    try { const st = statSync(join(src, f)); return `${f}:${st.mtimeMs}:${st.size}` } catch { return `${f}:missing` }
  })
  return [...stats, ...media].join("|")
}

/** Resolve the effective source path for a state. Returns absolute path. */
export function findSource(name: string, state?: AvatarState): string | undefined {
  return sourceStatus(name, state).path
}

/** Copy an external file into <name>/source/ as <role>.<ext>. No-op if
 *  already there. Returns the filename (not the full path) for storing
 *  in `studio.sources`. */
export function adopt(name: string, from: string, role: AvatarState | "base" = "base"): string {
  const fname = `${role}${extname(from).toLowerCase()}`
  const dst = join(ensure(name).source, fname)
  if (from !== dst) copyFileSync(from, dst)
  return fname
}

export function readStudio(name: string): Studio | undefined {
  const p = studioFile(name)
  if (!existsSync(p)) return undefined
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Studio>
  // Minimal shape-check; absent fields fall back at fresh() time.
  if (!raw || typeof raw !== "object") return undefined
  return normalizeStudioSources(name, raw as Studio)
}

export function writeStudio(name: string, s: Studio) {
  ensure(name)
  writeFileSync(studioFile(name), JSON.stringify(s, null, 2) + "\n", "utf8")
}

/** Read just the NDJSON header (line 1). */
export function header(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  return peekHeader(path) ?? undefined
}

/** Locate the packed eikon for a name — installed folder-form first,
 *  then bundled launch packages. Studio falls back to this for
 *  baked-frame preview when `source/` is empty. */
export function baked(name: string): string | undefined {
  const local = file(name)
  if (existsSync(local)) return local
  const old = flat(name)
  if (existsSync(old)) return old

  const target = (name === "default" ? "nous" : name).toLowerCase()
  for (const e of listEikons([BUNDLED_EIKON_DIR])) {
    const slug = basename(dirname(e.path)).toLowerCase()
    if (slug === target || e.meta.name.toLowerCase() === target) return e.path
  }
  return undefined
}

// ── Rasterizer registry ──────────────────────────────────────────────

const registry = new Map<string, Rasterizer>(BUILTIN.map(r => [r.name, r]))
const subs = new Set<() => void>()

export function register(r: Rasterizer): () => void {
  registry.set(r.name, r)
  for (const f of subs) f()
  return () => {
    if (registry.get(r.name) === r) registry.delete(r.name)
    for (const f of subs) f()
  }
}

export const rasterizers = (): Rasterizer[] => [...registry.values()]
export const rasterizer = (name: string): Rasterizer | undefined => registry.get(name)
export const onRegistry = (fn: () => void) => { subs.add(fn); return () => subs.delete(fn) }

/** First registered rasterizer whose `available()` is true. */
export function pick(prefer?: string): Rasterizer {
  const want = prefer && registry.get(prefer)
  if (want && want.available() === true) return want
  for (const r of registry.values()) if (r.available() === true) return r
  // Fall back to native even if unavailable — render() will surface the
  // error string, but the tab has *something* to show in the picker.
  return registry.get("native")!
}

// ── Revision counter (sidebar reload signal) ─────────────────────────

let rev = 0
const revSubs = new Set<() => void>()
export const revision = () => rev
export const onRevision = (fn: () => void) => { revSubs.add(fn); return () => revSubs.delete(fn) }
const bump = () => { rev++; for (const f of revSubs) f() }
export const notifyRevision = bump

// ── Save / pack ──────────────────────────────────────────────────────

function serialize(name: string, fps: number, clips: Map<AvatarState, Frame[]>): string {
  const records: LaunchStreamRecord[] = [{
    type: "header",
    eikon: 1,
    id: name,
    title: name,
    author: { name: process.env.USER ?? "unknown" },
    size: { cols: W, rows: H },
    defaultSignal: "state.idle",
    signals: defaultSignalMappings(),
  }]
  for (const st of STATES) {
    const fs = clips.get(st)!
    records.push({ type: "clip", name: st, fps, frameCount: fs.length, loopFrom: 0 })
    fs.forEach((f, i) => records.push({ type: "frame", clip: st, index: i, rows: f }))
  }
  return serializeLaunchStream(records)
}

function preserve(name: string, src: string | undefined) {
  if (!src) return
  const man = manifest(name) ?? { name }
  if (origin(man)) return
  writeFileSync(join(dir(name), "manifest.json"), JSON.stringify({ ...man, origin: { source: src, at: new Date().toISOString() } }, null, 2) + "\n", "utf8")
}

/** Render all six states (all frames) and write `.eikon` + `studio.json`.
 *  External sources referenced in `s.sources` as absolute paths are
 *  adopted into `source/` and rewritten to bare filenames. Returns the
 *  written `.eikon` path. Sets the `eikon` pref and bumps revision. */
export async function save(s: Session): Promise<string> {
  const r = rasterizer(s.rasterizer) ?? pick(s.rasterizer)
  const paths = ensure(s.name)
  // Adopt any external-path sources into source/.
  const sources: Session["sources"] = {}
  for (const [role, p] of Object.entries(s.sources) as Array<[AvatarState | "base", string | null]>) {
    if (p === null) { sources[role] = null; continue }
    if (!p) continue
    const abs = p.includes("/") ? p : join(paths.source, p)
    sources[role] = existsSync(abs) ? adopt(s.name, abs, role) : p
  }
  // Render each distinct (src, knobs) pair once; fan to states.
  const seen = new Map<string, Frame[]>()
  const clips = new Map<AvatarState, Frame[]>()
  const blank = [Array.from({ length: H }, (_, i) => (i === H >> 1 ? s.glyph.padStart(W >> 1) : "").padEnd(W))]
  for (const st of STATES) {
    const src = sourceStatus(s.name, st, { sources }).path
    const k = eff(s, st)
    const key = `${src ?? ""}|${JSON.stringify(k)}`
    let fs = seen.get(key)
    if (!fs) {
      if (!src) fs = blank
      else {
        const out = await cached(r, src, s.spatial, s.tone, s.fps, k)
        if ("err" in out) throw new Error(out.err)
        fs = out.frames
      }
      seen.set(key, fs)
    }
    clips.set(st, fs)
  }
  const head = header(paths.file)
  preserve(s.name, legacySource(head))
  await Bun.write(paths.file, serialize(s.name, s.fps, clips))
  writeStudio(s.name, { ...toStudio(s), sources })
  bump()
  return paths.file
}

export function useInstalled(name: string): void {
  if (!existsSync(file(name)) && !baked(name)) throw new Error(`eikon '${name}' is not installed`)
  prefs.set("eikon", name)
  bump()
}

/** Delete an installed eikon's folder. */
export function remove(name: string, opts: { confirmActive?: boolean } = {}): ActiveConsequence | undefined {
  if (prefs.get("eikon") === name && !opts.confirmActive) return {
    type: "active-consequence",
    action: "remove",
    name,
    message: `Removing '${name}' will clear the active avatar. Pass confirmActive to remove it.`,
  }
  rmSync(dir(name), { recursive: true, force: true })
  rmSync(flat(name), { force: true })
  if (prefs.get("eikon") === name) prefs.set("eikon", undefined)
  bump()
  return undefined
}

export async function update(name: string, opts: { confirmActive?: boolean } = {}): Promise<Fetched | ActiveConsequence> {
  if (prefs.get("eikon") === name && !opts.confirmActive) return {
    type: "active-consequence",
    action: "update",
    name,
    message: `Updating '${name}' will change the active avatar's backing package. Pass confirmActive to update it.`,
  }
  const info = lifecycle(name)
  const src = info.source.origin ?? info.source.packageUrl
  if (!src) throw new Error(`eikon '${name}' has no recorded source`)
  return fetchSource(src, { name })
}

// ── Install / fetch ──────────────────────────────────────────────────

export type Fetched = { name: string; sources: Sources; n: number; bytes: number }
export type LifecycleState = AvatarState
export type PackageState = "available" | "invalid" | "installed" | "active" | "update-available" | "incompatible"
export type PackageManifest = {
  kind: "eikon.package"
  schemaVersion: string
  id: string
  name: string
  version?: string
  display?: { title?: string; author?: string; description?: string; glyph?: string; tags?: string[] }
  compatibility: { eikon: string; hosts?: Record<string, string> }
  entrypoints: { default: string; [key: string]: string }
  files?: Array<{ path: string; mediaType?: string; size?: number; digest?: string; role?: string; encoding?: string; decodedSize?: number; decodedDigest?: string }>
  source?: { base?: string; states?: Partial<Record<string, { file: string; role?: string }>> }
  poster?: string
  triggers?: Array<{ signal: string; when: string; fallback?: string }>
  extensions?: { used?: string[]; required?: string[] }
  legacy?: { sourceFormat?: ".eikon"; migration?: "adapt" | "converted"; notes?: string[] }
  origin?: Record<string, unknown>
}
export type CatalogPackage = {
  kind: "eikon.catalog.entry"
  schemaVersion: string
  id: string
  sourceKey: string
  name: string
  title?: string
  author?: string
  description?: string
  glyph?: string
  tags?: string[]
  poster?: string
  packageUrl: string
  detailUrl?: string
  compatibility: { eikon: string; hosts?: Record<string, string>; available?: boolean; reason?: string }
  trust?: Record<string, unknown>
  state: PackageState
}
export type AdaptedPackage = {
  manifest: PackageManifest
  eikon: ReturnType<typeof parseEikon>
  states: LifecycleState[]
  triggers?: PackageManifest["triggers"]
  extensions?: PackageManifest["extensions"]
}

export const peekSource = peek

function stripManifestTrust(name: string) {
  const p = join(dir(name), "manifest.json")
  if (!existsSync(p)) return
  const man = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>
  if (!("license" in man) && !("provenance" in man)) return
  delete man.license
  delete man.provenance
  writeFileSync(p, JSON.stringify(man, null, 2) + "\n", "utf8")
}

function statResolved(r: ResolvedEikon): { n: number; bytes: number } | undefined {
  const xs = packageEntries(r.manifest)
  const files = Array.isArray((r.manifest as { files?: unknown }).files)
    ? (r.manifest as { files: Array<{ path?: string; size?: number }> }).files
    : []
  const sizes = xs.map(([, rel]) => files.find(f => f.path === rel)?.size)
  if (sizes.every((n): n is number => typeof n === "number")) return { n: xs.length, bytes: sizes.reduce((a, b) => a + b, 0) }
  if (r.staged) return { n: xs.length, bytes: xs.reduce((sum, [, rel]) => {
    const p = join(r.staged, rel)
    return existsSync(p) ? sum + statSync(p).size : sum
  }, 0) }
  return undefined
}

export async function inspectSource(src: string): Promise<InspectInfo> {
  const dl = /^http:\/\/localhost[:/]/.test(src) ? { allowPrivate: true } : undefined
  const r = await resolve(src, { downloader: dl })
  return inspectResolved(src, r, statResolved(r))
}

/** Install an eikon from any resolvable source (catalog name, git
 *  URL, local dir, http manifest base) into <profile>/eikons/<name>/.
 *  Seeds studio.json from the returned sources map and bumps the
 *  revision counter so the sidebar + Gallery reload. */
export function attachSources(name: string, sources: Sources) {
  const prev = readStudio(name)
  writeStudio(name, { ...(prev ?? toStudio(fresh(name, pick()))), sources: { ...prev?.sources, ...sources } })
  bump()
}

function digest(data: Uint8Array) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`
}

function dlOpts(url: string, opts: DownloadOptions = {}): DownloadOptions {
  return /^http:\/\/localhost[:/]/.test(url) ? { allowPrivate: true, ...opts } : opts
}

function manUrl(url: string): string {
  if (url.endsWith("manifest.json")) return url
  return new URL("manifest.json", url.endsWith("/") ? url : `${url}/`).toString()
}

function specOf(man: Record<string, unknown>, rel: string): Record<string, unknown> | undefined {
  const files = Array.isArray(man.files) ? man.files : []
  return files.find(f => OBJ(f) && f.path === rel) as Record<string, unknown> | undefined
}

async function readManifest(url: string, opts: DownloadOptions): Promise<Record<string, unknown>> {
  const raw = await downloadBytes(url, opts)
  const man = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown
  if (!OBJ(man)) throw new Error("source manifest: object required")
  return man
}

async function readSource(file: Record<string, unknown> | undefined, base: string, rel: string, opts: DownloadOptions) {
  const raw = await downloadBytes(new URL(rel, base).toString(), opts)
  const size = file?.size
  if (typeof size === "number" && raw.length !== size) throw new Error(`source size mismatch: ${rel}`)
  if (typeof file?.digest === "string" && digest(raw) !== file.digest) throw new Error(`source digest mismatch: ${rel}`)
  return raw
}

export async function downloadSource(name: string, opts: { downloader?: DownloadOptions } = {}): Promise<Fetched> {
  const url = sourceFetchUrl(name)
  if (!url) throw new Error(`eikon '${name}' has no published source`)
  const href = manUrl(url)
  const root = href.slice(0, href.lastIndexOf("/") + 1)
  const dl = dlOpts(url, opts.downloader)
  const man = await readManifest(href, dl)
  const xs = sourceEntries(man, true)
  if (xs.length === 0) throw new Error(`eikon '${name}' has no published source media`)
  const dir = ensure(name).source
  const pairs = await Promise.all(xs.map(async ([role, rel]) => {
    const file = specOf(man, rel)
    const fname = sourceName(man as SourceManifest, role, rel)
    if (!fileOk(fname)) throw new Error(`source media type unsupported: ${rel}`)
    return [role, fname, await readSource(file, root, rel, dl)] as const
  }))
  const sources: Sources = {}
  await Promise.all(pairs.map(async ([role, fname, data]) => {
    await Bun.write(join(dir, fname), data)
    sources[role] = fname
  }))
  attachSources(name, sources)
  return { name, sources, n: pairs.length, bytes: pairs.reduce((sum, [, , data]) => sum + data.length, 0) }
}

export async function fetchSource(src: string, opts?: { name?: string; media?: boolean;
                                   downloader?: DownloadOptions;
                                   progress?: (d: number, t: number) => void }): Promise<Fetched> {
  const out: Got = await install(src, ROOT(), opts)
  stripManifestTrust(out.name)
  const sources = normalizeSources(out.name, out.sources)
  attachSources(out.name, sources)
  return { name: out.name, sources, n: out.n, bytes: out.bytes }
}

const SAFE = /^[a-zA-Z0-9._/-]+$/
function safePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("./") || path.includes("../") || path === "..") return false
  if (!SAFE.test(path)) return false
  return !path.split("/").includes("..")
}

function pkgErr(path: string, msg: string): Error {
  return new Error(`${path}: ${msg}`)
}

function launchOk(range: string): boolean {
  const lower = range.match(/>=?\s*(\d+)/)
  if (lower && Number(lower[1]) > 1) return false
  const exact = range.match(/^\s*(\d+)(?:\.\d+)?\s*$/)
  if (exact && Number(exact[1]) !== 1) return false
  if (/>=?\s*2\b|\^\s*2\b/.test(range)) return false
  return !/^\s*>=?\s*99/.test(range)
}

function validatePkg(value: unknown): PackageManifest {
  if (!OBJ(value)) throw pkgErr("manifest", "object required")
  const man = value as PackageManifest
  if (man.kind !== "eikon.package") throw pkgErr("kind", "must be eikon.package")
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(String(man.name ?? ""))) throw pkgErr("name", "safe package name required")
  if (!man.id || typeof man.id !== "string") throw pkgErr("id", "safe id required")
  if (!OBJ(man.compatibility) || typeof man.compatibility.eikon !== "string") throw pkgErr("compatibility.eikon", "required")
  if (!launchOk(man.compatibility.eikon)) throw pkgErr("compatibility.eikon", "must support launch major version 1")
  if (!OBJ(man.entrypoints) || typeof man.entrypoints.default !== "string" || !safePath(man.entrypoints.default)) throw pkgErr("entrypoints.default", "safe relative path required")
  for (const [k, p] of Object.entries(man.entrypoints)) {
    if (typeof p !== "string" || !safePath(p)) throw pkgErr(`entrypoints.${k}`, "safe relative path required")
  }
  for (const f of man.files ?? []) {
    if (!f || typeof f.path !== "string" || !safePath(f.path)) throw pkgErr("files.path", "safe relative path required")
  }
  if (man.poster && !safePath(man.poster)) throw pkgErr("poster", "safe relative path required")
  return man
}

function asUrl(value: string, base?: string): string {
  if (/^file:\/\//.test(value)) return value
  const out = new URL(value, base)
  if (out.protocol !== "http:" && out.protocol !== "https:") throw pkgErr("packageUrl", "http(s) URL required")
  return out.toString()
}

function relUrl(base: string, path?: string): string | undefined {
  if (!path) return undefined
  if (/^(https?|file):\/\//.test(path)) return asUrl(path)
  if (!safePath(path)) throw pkgErr("path", "safe relative path required")
  return new URL(path, base).toString()
}

function entryState(name: string, available = true): PackageState {
  if (!available) return "incompatible"
  if (prefs.get("eikon") === name) return "active"
  if (existsSync(file(name))) return "installed"
  return "available"
}

function normalize(input: unknown, base?: string): CatalogPackage {
  if (!OBJ(input)) throw pkgErr("catalog", "entry object required")
  if (input.kind === "eikon.catalog.entry") {
    const entry = input as CatalogPackage
    return { ...entry, state: entryState(entry.name, entry.compatibility?.available !== false) }
  }
  if (OBJ(input.manifest) && typeof input.packageUrl === "string") {
    const man = validatePkg(input.manifest)
    const packageUrl = asUrl(input.packageUrl, base)
    const root = packageUrl.slice(0, packageUrl.lastIndexOf("/") + 1)
    return {
      kind: "eikon.catalog.entry", schemaVersion: "1.0",
      id: man.id, sourceKey: typeof input.sourceKey === "string" ? input.sourceKey : packageUrl,
      name: man.name, title: man.display?.title, author: man.display?.author,
      description: man.display?.description, glyph: man.display?.glyph, tags: man.display?.tags,
      poster: relUrl(root, man.poster),
      packageUrl, detailUrl: typeof input.detailUrl === "string" ? asUrl(input.detailUrl, root) : undefined,
      compatibility: { eikon: man.compatibility.eikon, hosts: man.compatibility.hosts, available: launchOk(man.compatibility.eikon) },
      state: entryState(man.name, launchOk(man.compatibility.eikon)),
    }
  }
  const name = String(input.name ?? "")
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw pkgErr("name", "safe catalog name required")
  const source = typeof input.source === "string" ? input.source : `${name}/`
  const packageUrl = /^(https?|file):\/\//.test(source) ? asUrl(source) : base ? new URL(source, base).toString() : source
  const manifest = packageUrl.endsWith("manifest.json") ? packageUrl : new URL("manifest.json", packageUrl.endsWith("/") ? packageUrl : `${packageUrl}/`).toString()
  return {
    kind: "eikon.catalog.entry", schemaVersion: "1.0", id: name,
    sourceKey: packageUrl, name, author: typeof input.author === "string" ? input.author : undefined,
    title: typeof input.title === "string" ? input.title : undefined,
    description: typeof input.description === "string" ? input.description : undefined,
    tags: Array.isArray(input.tags) ? input.tags.filter((x): x is string => typeof x === "string") : undefined,
    glyph: typeof input.glyph === "string" ? input.glyph : undefined,
    poster: typeof input.poster === "string" ? input.poster : undefined,
    packageUrl: manifest, compatibility: { eikon: ">=1 <2", available: true },
    state: entryState(name),
  }
}

async function loadText(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (url.startsWith("file://")) return readFileSync(new URL(url), "utf8")
  const res = await fetcher(url)
  if (!res.ok) throw new Error(`fetch: ${res.status} ${url}`)
  return await res.text()
}

async function loadBytes(url: string, fetcher: typeof fetch = fetch, desc?: RuntimeDescriptor): Promise<Uint8Array> {
  if (url.startsWith("file://")) return new Uint8Array(readFileSync(new URL(url)))
  const res = await fetcher(url)
  if (!res.ok) throw new Error(`fetch: ${res.status} ${url}`)
  const enc = res.headers.get("content-encoding")
  if (enc && enc.toLowerCase() !== "identity" && desc?.digest) throw pkgErr("runtime", `artifact must be served without Content-Encoding: ${enc}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function loadJson(url: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  return JSON.parse(await loadText(url, fetcher))
}

export async function loadCatalog(index = process.env.HERM_EIKON_MARKETPLACE || DEFAULT_PUBLIC_CATALOG, fetcher: typeof fetch = fetch): Promise<CatalogPackage[]> {
  const url = index.endsWith("index.json") ? index : `${index.replace(/\/$/, "")}/index.json`
  const raw = await loadJson(url, fetcher)
  if (!Array.isArray(raw)) throw pkgErr("catalog", "index array required")
  const base = url.slice(0, url.lastIndexOf("/") + 1)
  return raw.map(item => normalize(item, base))
}

export async function adaptPackage(manifest: unknown, streamText?: string, legacyText?: string): Promise<AdaptedPackage> {
  const man = validatePkg(manifest)
  const body = streamText ?? legacyText
  if (!body) throw pkgErr("entrypoints.default", "stream data required")
  const eik = parseEikon(body)
  for (const st of STATES) if (!eik.states.has(st)) throw pkgErr(`states.${st}`, "canonical lifecycle state required")
  return { manifest: man, eikon: eik, states: [...STATES], triggers: man.triggers, extensions: man.extensions }
}

async function loadPackage(url: string, fetcher: typeof fetch = fetch): Promise<{ man: PackageManifest; base: string }> {
  const man = validatePkg(await loadJson(url, fetcher))
  return { man, base: url.slice(0, url.lastIndexOf("/") + 1) }
}

function runtimeDesc(man: PackageManifest, path = man.entrypoints.default): RuntimeDescriptor | undefined {
  const file = man.files?.find(f => f.path === path) ?? man.files?.find(f => f.role === "runtime")
  if (!file || (!file.digest && file.size == null && !file.encoding && file.decodedSize == null && !file.decodedDigest)) return undefined
  return { digest: file.digest, size: file.size, encoding: file.encoding, decodedSize: file.decodedSize, decodedDigest: file.decodedDigest }
}

async function loadRuntime(man: PackageManifest, base: string, fetcher: typeof fetch = fetch, path = man.entrypoints.default): Promise<{ text: string; bytes: Uint8Array }> {
  const desc = runtimeDesc(man, path)
  const bytes = await loadBytes(new URL(path, base).toString(), fetcher, desc)
  return { bytes, text: decodeRuntimeBytes(bytes, { descriptor: desc }) }
}

export async function previewPackage(entry: CatalogPackage, fetcher: typeof fetch = fetch): Promise<AdaptedPackage> {
  const { man, base } = await loadPackage(entry.packageUrl, fetcher)
  return adaptPackage(man, (await loadRuntime(man, base, fetcher)).text)
}

export async function installPackage(src: string | CatalogPackage, opts: { name?: string; fetcher?: DownloadOptions["fetcher"] } = {}): Promise<Fetched> {
  const url = typeof src === "string" ? src : src.packageUrl
  return fetchSource(url, { name: opts.name, downloader: opts.fetcher ? { fetcher: opts.fetcher } : undefined })
}

export { parseEikon, parseEikonFile, probe }
export * as eikon from "./eikon"
