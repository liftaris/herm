import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, dirname, extname, join } from "node:path"
import { downloadBytes, entries as packageEntries, type Catalog, type PublicCatalogEntry as CatalogEntry, type CatalogOptions, type DownloadOptions } from "eikon"
import { loadCatalog, loadRuntimeArtifact, publicCatalogUrl, searchCatalog } from "eikon/catalog"
import { eikon } from "./eikon"
import * as delist from "./eikon-delist"
import * as prefs from "../context/preferences"
import { listEikons } from "../components/avatar/eikon"
import { BUNDLED_EIKON_DIR } from "../components/avatar/bundled"

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type EntryState = "available" | "installed" | "active" | "active-name-conflict" | "legacy-name-match" | "incompatible" | "mismatch"
type LoadStatus = "ready" | "empty" | "error"

export type InstalledManifest = {
  name?: string
  kind?: string
  id?: string
  version?: string
  origin?: { source?: string; at?: string; sha?: string; kind?: string; trust?: string; sourceKey?: string; identityKey?: string; packageUrl?: string; repo?: string; selector?: string; catalogRoot?: string }
  [key: string]: unknown
}

export type InstalledMetadata = eikon.Installed & {
  manifest?: InstalledManifest
  identityKeys: string[]
}

export type MarketplaceRow = {
  entry: CatalogEntry
  installed: boolean
  active: boolean
  installState: EntryState
  installedManifest?: InstalledManifest
  installedName?: string
  installedPath?: string
  lifecycle: eikon.LifecycleInfo
  trust: eikon.LifecycleInfo["trust"]
  updateable: boolean
  updateAvailable: boolean
  removable: boolean
  sourceIdentity?: string
  sourcePresent: boolean
  sourceAvailable: boolean
  sourceDownloadable: boolean
  reason?: string
  action: "install" | "use" | "active" | "retry"
}

export type MarketplaceState = {
  status: LoadStatus
  query: string
  rows: MarketplaceRow[]
  selected?: MarketplaceRow
  error?: string
  service?: MarketplaceService
}

export type MarketplaceOptions = CatalogOptions & {
  catalog?: string
  fetcher?: Fetcher
  delistRepo?: string
  delistRun?: delist.Run
  query?: string
  timeoutMs?: number
  previewCacheLimit?: number
  concurrency?: number
}

type PreviewOptions = { signal?: AbortSignal; timeoutMs?: number }
export type MarketplaceInstall = { name: string; n: number; bytes: number }
export type MarketplaceSizes = { eikon?: number; source?: number }

type Job<T> = {
  run: () => Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (err: unknown) => void
}

const DEFAULT_TIMEOUT = 5000
const DEFAULT_CACHE_LIMIT = 24
const OFFICIAL_CATALOG = "https://eikon.liftaris.dev/eikons"
const dec = new TextDecoder()

function hash(data: Uint8Array) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`
}

function keyIdentity(s: string) {
  const u = URL.parse(s)
  return u && (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") ? u.href.replace(/\/?$/, "/") : s
}

function manifestBaseKey(s: string) {
  const u = URL.parse(s)
  if (u && (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") && u.pathname.endsWith("/manifest.json")) return new URL(".", u).href
  return undefined
}

function registryKey(man: InstalledManifest | undefined, source: string | undefined) {
  if (man?.kind !== "eikon.package" || typeof man.id !== "string") return undefined
  const sourceKey = man.origin?.sourceKey ?? man.origin?.identityKey
  if (sourceKey) return keyIdentity(sourceKey)
  const host = source ? URL.parse(source)?.host : undefined
  if (!host) return undefined
  return `registry:${host}:${man.id}${typeof man.version === "string" && man.version ? `@${man.version}` : ""}`
}

function entryKeys(entry: CatalogEntry) {
  return [...new Set([entry.identityKey, entry.sourceKey].filter(Boolean).map(keyIdentity))]
}

function keysFor(inst: eikon.Installed): string[] {
  const keys = new Set<string>()
  const man = inst.manifest as InstalledManifest | undefined
  const origin = typeof man?.origin?.source === "string" ? man.origin.source : undefined
  const head = eikon.header(inst.file)
  const src = typeof head?.source_url === "string" ? head.source_url : inst.sourceUrl
  const registry = registryKey(man, origin)
  if (registry) keys.add(registry)
  if (origin) {
    keys.add(keyIdentity(origin))
    const base = manifestBaseKey(origin)
    if (base) keys.add(keyIdentity(base))
  }
  if (src) {
    keys.add(keyIdentity(src))
    const base = manifestBaseKey(src)
    if (base) keys.add(keyIdentity(base))
  }
  return [...keys]
}

function read(path: string): InstalledManifest | undefined {
  try {
    const man = JSON.parse(readFileSync(path, "utf8")) as unknown
    return obj(man) ? man as InstalledManifest : undefined
  } catch (err) {
    if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) throw err
    return undefined
  }
}

function chosen(active: unknown, name: string) {
  return active === name || (active === "default" && name === "nous")
}

function media(dir: string) {
  return existsSync(dir) && readdirSync(dir).length > 0
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function life(name: string, man: InstalledManifest): eikon.LifecycleInfo {
  const origin = obj(man.origin) ? man.origin : {}
  const display = obj(man.display) ? man.display : {}
  const src = text(origin.source)
  const identity = text(origin.identityKey) ?? text(origin.sourceKey) ?? text(origin.packageUrl) ?? text(origin.repo) ?? src
  const title = text(display.title) ?? text(man.title)
  const author = text(display.author) ?? text(man.author)
  return {
    name,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(text(man.version) ? { version: text(man.version) } : {}),
    source: {
      kind: (text(origin.kind) ?? "default-catalog") as eikon.SourceInfo["kind"],
      ...(identity ? { identity } : {}),
      ...(src ? { origin: src } : {}),
      ...(text(origin.repo) ? { repo: text(origin.repo) } : {}),
      ...(text(origin.selector) ? { selector: text(origin.selector) } : {}),
      ...(text(origin.catalogRoot) ? { catalogRoot: text(origin.catalogRoot) } : {}),
      ...(text(origin.sha) ? { sha: text(origin.sha) } : {}),
      ...(text(origin.packageUrl) ? { packageUrl: text(origin.packageUrl) } : {}),
    },
    trust: (text(origin.trust) ?? "verified") as eikon.LifecycleInfo["trust"],
    active: chosen(prefs.get("eikon"), name),
    removable: false,
    updateable: Boolean(src ?? text(origin.packageUrl)),
    updateAvailable: false,
    dirty: false,
    ...(text(man.poster) ? { poster: text(man.poster) } : {}),
    ...(obj(man.compatibility) ? { compatibility: man.compatibility as Record<string, unknown> } : {}),
    ...(text(origin.at) ? { installedAt: text(origin.at) } : {}),
  }
}

function bundled(xs: InstalledMetadata[]): InstalledMetadata[] {
  const names = new Set(xs.map(x => x.name.toLowerCase()))
  return listEikons([BUNDLED_EIKON_DIR]).flatMap(e => {
    const man = read(join(dirname(e.path), "manifest.json"))
    if (man?.kind !== "eikon.package") return []
    const name = text(man.name) ?? e.meta.name.toLowerCase()
    if (names.has(name.toLowerCase())) return []
    const inst: eikon.Installed = {
      name,
      file: e.path,
      source: eikon.sourceDir(name),
      hasSource: media(eikon.sourceDir(name)),
      sourceUrl: text(man.origin?.source) ?? text(man.origin?.packageUrl),
      manifest: man,
      lifecycle: life(name, man),
    }
    return [{ ...inst, manifest: man, identityKeys: keysFor(inst) }]
  })
}

function cacheKey(entry: CatalogEntry) {
  return [entry.identityKey || entry.sourceKey || entry.id, entry.runtimeUrl, entry.trust?.runtimeDigest, entry.trust?.runtimeSize].filter(Boolean).join("|")
}

function blob(url: string) {
  return /\/blobs\/sha256\/[^/?#]+/.test(url)
}

function artifact(entry: CatalogEntry): CatalogEntry {
  return entry
}

type Trust = { manifestDigest?: string; runtimeDigest?: string; digest?: string }
type PackageFile = { path?: string; digest?: string; size?: number; role?: string }
type SourceManifest = { source?: { base?: unknown; states?: unknown }; files?: PackageFile[] }
type Package = { kind?: string; entrypoints?: { default?: string }; files?: PackageFile[] }
type SizedPackage = Omit<Package, "files"> & { files?: Array<{ path?: string; digest?: string; size?: number; role?: string }> }
type SourceRole = keyof eikon.Sources & string

function obj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function rawManifest(entry: CatalogEntry): SourceManifest | undefined {
  const raw = entry.raw as Record<string, unknown>
  return obj(raw.manifest) ? raw.manifest as SourceManifest : undefined
}

function role(file: PackageFile): SourceRole | undefined {
  if (file.role === "source.base") return "base"
  if (file.role?.startsWith("source.")) return file.role.slice("source.".length) as SourceRole
  if (!file.path) return undefined
  return (basename(file.path, extname(file.path)).toLowerCase() || "base") as SourceRole
}

function sourceEntries(man: SourceManifest | undefined, strict = false): Array<[SourceRole, string]> {
  if (!man) return []
  try {
    const xs = packageEntries(man as never).map(([r, rel]) => [r as SourceRole, rel] as [SourceRole, string])
    if (xs.length) return xs
    return (man.files ?? []).flatMap(file => {
      if (typeof file.path !== "string" || !file.role?.startsWith("source")) return []
      const r = role(file)
      return r ? [[r, file.path] as [SourceRole, string]] : []
    })
  } catch (err) {
    if (strict) throw err
  }
  return (man.files ?? []).flatMap(file => {
    if (typeof file.path !== "string" || !file.role?.startsWith("source")) return []
    const r = role(file)
    return r ? [[r, file.path] as [SourceRole, string]] : []
  })
}

function sourceDescriptors(man: SourceManifest | undefined) {
  return sourceEntries(man).length > 0
}

function sourceAvailable(entry: CatalogEntry, inst?: InstalledMetadata) {
  return sourceDescriptors(inst?.manifest as SourceManifest | undefined) || sourceDescriptors(rawManifest(entry))
}

function trust(entry: CatalogEntry): Trust {
  return entry.trust as Trust
}

function boundTrust(entry: CatalogEntry, raw: Uint8Array): eikon.LifecycleInfo["trust"] {
  const t = trust(entry)
  const man = t.manifestDigest
  const run = t.runtimeDigest
  if (!man && !run) return "unverified"
  if (man && hash(raw) !== man) throw new Error(`catalog trust mismatch: manifest digest for ${entry.name}`)
  const pkg = JSON.parse(dec.decode(raw)) as Package
  const rel = pkg.entrypoints?.default
  const got = rel ? pkg.files?.find(f => f.path === rel)?.digest : undefined
  if (run && got !== run) throw new Error(`catalog trust mismatch: runtime digest for ${entry.name}`)
  return man && run ? "verified" : "unverified"
}

function spec(man: SourceManifest, rel: string): PackageFile | undefined {
  return man.files?.find(f => f.path === rel)
}

async function sourceBytes(man: SourceManifest, base: string, rel: string, opts: DownloadOptions) {
  const file = spec(man, rel)
  if (!file?.digest || typeof file.size !== "number") throw new Error(`source descriptor missing digest or size: ${rel}`)
  const raw = await downloadBytes(new URL(rel, base).href, opts)
  if (raw.length !== file.size) throw new Error(`source size mismatch: ${rel}`)
  if (hash(raw) !== file.digest) throw new Error(`source digest mismatch: ${rel}`)
  return raw
}

function target(input: string | URL | Request) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

function verifiedCatalogTrust(entry: CatalogEntry) {
  const t = trust(entry)
  return typeof t.manifestDigest === "string" && t.manifestDigest.length > 0
    && typeof t.runtimeDigest === "string" && t.runtimeDigest.length > 0
}

export function installed(): InstalledMetadata[] {
  const xs = eikon.list().map(inst => ({ ...inst, manifest: inst.manifest as InstalledManifest | undefined, identityKeys: keysFor(inst) }))
  return [...xs, ...bundled(xs)]
}

function match(entry: CatalogEntry, xs: InstalledMetadata[]) {
  const keys = entryKeys(entry)
  const exact = xs.find(x => x.identityKeys.some(k => keys.includes(k)))
  if (exact) return { inst: exact, legacy: false }
  const named = xs.find(x => x.name === entry.name && x.identityKeys.length === 0)
  if (named) return { inst: named, legacy: true }
  return undefined
}

function row(entry: CatalogEntry, xs: InstalledMetadata[]): MarketplaceRow {
  const usable = match(entry, xs)
  const active = usable ? chosen(prefs.get("eikon"), usable.inst.name) : false
  const installed = Boolean(usable)
  const conflict = !usable && chosen(prefs.get("eikon"), entry.name)
  const blocked = entry.compatibility?.available === false
  const mismatch = usable?.inst.lifecycle.trust === "mismatch"
  const installState: EntryState = mismatch ? "mismatch" : blocked ? "incompatible" : active ? "active" : conflict ? "active-name-conflict" : !usable ? "available" : usable.legacy ? "legacy-name-match" : "installed"
  const lifecycle = usable?.inst.lifecycle ?? {
    name: entry.name,
    title: entry.title,
    author: entry.author,
    version: entry.version,
    source: { kind: "default-catalog" as const, identity: entry.sourceKey, packageUrl: entry.packageUrl },
    trust: verifiedCatalogTrust(entry) ? "verified" as const : "unverified" as const,
    active: false,
    removable: false,
    updateable: false,
    updateAvailable: false,
    dirty: false,
    ...(entry.poster ? { poster: entry.poster } : {}),
    compatibility: entry.compatibility as Record<string, unknown>,
  }
  const available = sourceAvailable(entry, usable?.inst)
  return {
    entry,
    installed,
    active,
    installState,
    ...(usable?.inst.file ? { installedPath: usable.inst.file, installedName: usable.inst.name } : {}),
    ...(usable?.inst.manifest ? { installedManifest: usable.inst.manifest } : {}),
    lifecycle,
    trust: lifecycle.trust,
    updateable: lifecycle.updateable,
    updateAvailable: lifecycle.updateAvailable,
    removable: lifecycle.removable,
    sourceIdentity: lifecycle.source.identity,
    sourcePresent: usable?.inst.hasSource ?? false,
    sourceAvailable: available,
    sourceDownloadable: Boolean(usable && !usable.inst.hasSource && available),
    reason: blocked ? entry.compatibility?.reason ?? "incompatible" : mismatch ? "trust mismatch" : conflict ? "install would replace the active avatar backing package" : undefined,
    action: active ? "active" : installed ? "use" : "install",
  }
}

function sizes(man: SizedPackage): MarketplaceSizes {
  const files = Array.isArray(man.files) ? man.files : []
  const eikon = files
    .filter(f => f.role === "runtime" || f.path === man.entrypoints?.default)
    .map(f => f.size)
    .filter((n): n is number => typeof n === "number")
    .reduce((sum, n) => sum + n, 0)
  const source = files
    .filter(f => typeof f.role === "string" && f.role.startsWith("source"))
    .map(f => f.size)
    .filter((n): n is number => typeof n === "number")
    .reduce((sum, n) => sum + n, 0)
  return {
    ...(eikon > 0 ? { eikon } : {}),
    ...(source > 0 ? { source } : {}),
  }
}

function abortErr() {
  return new DOMException("aborted", "AbortError")
}

export class MarketplaceService {
  private catalog: Catalog
  private fetcher: Fetcher
  private timeoutMs: number
  private previewCacheLimit: number
  private concurrency: number
  private allowPrivate: boolean
  private official: boolean
  private delistRepo?: string
  private delistRun?: delist.Run
  private activeLoads = 0
  private queue: Job<string>[] = []
  private cache = new Map<string, string>()
  private inFlight = new Map<string, Promise<string>>()

  constructor(catalog: Catalog, opts: MarketplaceOptions = {}) {
    this.catalog = catalog
    this.fetcher = opts.fetcher ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
    this.previewCacheLimit = opts.previewCacheLimit ?? DEFAULT_CACHE_LIMIT
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4))
    this.allowPrivate = opts.allowPrivate === true
    this.official = keyIdentity(publicCatalogUrl(opts.catalog ?? OFFICIAL_CATALOG, undefined, opts)) === keyIdentity(OFFICIAL_CATALOG)
    this.delistRepo = opts.delistRepo
    this.delistRun = opts.delistRun
  }

  rows(query = ""): MarketplaceRow[] {
    const entries = searchCatalog(this.catalog.entries, query)
    const xs = installed()
    return entries.map(e => row(e, xs))
  }

  entry(id: string): CatalogEntry | undefined {
    const key = keyIdentity(id)
    return this.catalog.entries.find(e => keyIdentity(e.identityKey) === key || keyIdentity(e.sourceKey) === key || e.id === id || e.name === id)
  }

  private dl(signal?: AbortSignal, fetcher = this.fetcher): DownloadOptions {
    return { allowPrivate: this.allowPrivate, fetcher: (input, init) => fetcher(input, signal ? { ...init, signal } : init) }
  }

  private runtime(entry: CatalogEntry, signal?: AbortSignal): Fetcher {
    return async input => {
      const url = target(input)
      const bound = keyIdentity(url) === keyIdentity(entry.runtimeUrl) && (!!entry.trust?.runtimeDigest || blob(url))
      const raw = await downloadBytes(url, { ...this.dl(signal), rejectContentEncoding: bound })
      const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
      return new Response(buf, { headers: { "content-length": String(raw.length) } })
    }
  }

  private cached(url: string, raw: Uint8Array): Fetcher {
    const key = keyIdentity(url)
    return async (input, init) => {
      if (keyIdentity(target(input)) === key) return new Response(raw.slice(), { headers: { "content-length": String(raw.length) } })
      return this.fetcher(input, init)
    }
  }

  async preview(id: string, opts: PreviewOptions = {}): Promise<string> {
    if (opts.signal?.aborted) throw abortErr()
    const entry = this.entry(id)
    if (!entry) throw new Error(`marketplace: unknown eikon "${id}"`)
    const key = cacheKey(entry)
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const active = this.inFlight.get(key)
    if (active) return active
    const p = this.enqueue(() => this.loadPreview(entry, opts)).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, p)
    return p
  }

  async packageSizes(id: string): Promise<MarketplaceSizes> {
    const entry = this.entry(id)
    if (!entry) throw new Error(`marketplace: unknown eikon "${id}"`)
    return sizes(JSON.parse(dec.decode(await downloadBytes(entry.packageUrl, this.dl()))) as SizedPackage)
  }

  async delistInfo(id: string): Promise<delist.Info> {
    const entry = this.entry(id)
    if (!entry) throw new Error(`marketplace: unknown eikon "${id}"`)
    if (!this.official) return { eligible: false, reason: "Registry delist is only available from the official Eikon catalog" }
    return delist.info(entry, { repo: this.delistRepo, run: this.delistRun })
  }

  async delist(id: string): Promise<delist.Result> {
    const entry = this.entry(id)
    if (!entry) throw new Error(`marketplace: unknown eikon "${id}"`)
    if (!this.official) throw new Error("Registry delist is only available from the official Eikon catalog")
    return delist.submit(entry, { repo: this.delistRepo, run: this.delistRun })
  }

  async install(id: string, opts: { media?: boolean; confirmActive?: boolean } = {}): Promise<MarketplaceInstall> {
    const entry = this.entry(id)
    if (!entry) throw new Error(`marketplace: unknown eikon "${id}"`)
    if (entry.compatibility?.available === false) throw new Error(entry.compatibility.reason ?? "eikon is incompatible")
    if (!match(entry, installed()) && chosen(prefs.get("eikon"), entry.name) && !opts.confirmActive) throw new Error(`Installing '${entry.name}' will replace the active avatar's backing package. Pass confirmActive to install it.`)
    const raw = await downloadBytes(entry.packageUrl, this.dl())
    const state = boundTrust(entry, raw)
    const out = await eikon.fetchSource(entry.packageUrl, { name: entry.name, media: opts.media === true, downloader: this.dl(undefined, this.cached(entry.packageUrl, raw)) })
    const ef = eikon.file(out.name)
    if (!existsSync(ef)) {
      const art = await loadRuntimeArtifact(entry, this.runtime(entry), { allowPrivate: this.allowPrivate })
      await Bun.write(ef, art.bytes)
      eikon.notifyRevision()
    }
    const mf = join(eikon.dir(out.name), "manifest.json")
    const man = JSON.parse(readFileSync(mf, "utf8")) as Record<string, unknown>
    const origin = man.origin && typeof man.origin === "object" && !Array.isArray(man.origin) ? man.origin as Record<string, unknown> : {}
    writeFileSync(mf, JSON.stringify({ ...man, origin: { ...origin, sourceKey: entry.sourceKey, identityKey: entry.identityKey, packageUrl: entry.packageUrl, trust: state } }, null, 2) + "\n")
    return out
  }

  async downloadSource(id: string): Promise<MarketplaceInstall> {
    const entry = this.entry(id)
    if (!entry) throw new Error(`marketplace: unknown eikon "${id}"`)
    const usable = match(entry, installed())
    if (!usable) throw new Error(`marketplace: "${entry.name}" is not installed`)
    if (!sourceAvailable(entry, usable.inst)) throw new Error(`marketplace: no source media published for "${entry.name}"`)
    const raw = await downloadBytes(entry.packageUrl, this.dl())
    boundTrust(entry, raw)
    const man = JSON.parse(dec.decode(raw)) as SourceManifest
    const xs = sourceEntries(man, true)
    if (xs.length === 0) throw new Error(`marketplace: no source media published for "${entry.name}"`)
    const base = new URL(".", entry.packageUrl).href
    const dir = eikon.ensure(usable.inst.name).source
    const pairs = await Promise.all(xs.map(async ([r, rel]) => {
      const data = await sourceBytes(man, base, rel, this.dl())
      return [r, eikon.sourceName(man, r, rel), data] as const
    }))
    const sources: eikon.Sources = {}
    await Promise.all(pairs.map(async ([r, fname, data]) => {
      await Bun.write(join(dir, fname), data)
      sources[r] = fname
    }))
    eikon.attachSources(usable.inst.name, sources)
    return { name: usable.inst.name, n: pairs.length, bytes: pairs.reduce((sum, [, , data]) => sum + data.length, 0) }
  }

  private enqueue(run: () => Promise<string>) {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ run, resolve, reject })
      this.pump()
    })
  }

  private pump() {
    if (this.activeLoads >= this.concurrency) return
    const job = this.queue.shift()
    if (!job) return
    this.activeLoads += 1
    job.run()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.activeLoads -= 1
        this.pump()
      })
  }

  private async loadPreview(entry: CatalogEntry, opts: PreviewOptions) {
    const ctl = new AbortController()
    const timeout = setTimeout(() => ctl.abort(), opts.timeoutMs ?? this.timeoutMs)
    const off = () => ctl.abort()
    opts.signal?.addEventListener("abort", off, { once: true })
    try {
      const item = artifact(entry)
      const text = (await loadRuntimeArtifact(item, this.runtime(item, ctl.signal), { signal: ctl.signal, allowPrivate: this.allowPrivate })).text
      this.cache.set(cacheKey(entry), text)
      while (this.cache.size > this.previewCacheLimit) this.cache.delete(this.cache.keys().next().value!)
      return text
    } finally {
      clearTimeout(timeout)
      opts.signal?.removeEventListener("abort", off)
    }
  }
}

export async function load(opts: MarketplaceOptions = {}): Promise<MarketplaceState> {
  const query = opts.query ?? ""
  try {
    if (opts.catalog) publicCatalogUrl(opts.catalog, undefined, opts)
    const cat = await loadCatalog(opts.catalog, opts.fetcher ?? fetch, opts)
    const service = new MarketplaceService(cat, opts)
    const rows = service.rows(query)
    return { status: rows.length > 0 ? "ready" : "empty", query, rows, selected: rows[0], service }
  } catch (err) {
    return { status: "error", query, rows: [], error: err instanceof Error ? err.message : String(err) }
  }
}
