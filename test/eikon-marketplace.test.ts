import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { runtimeDescriptor, type Catalog } from "eikon"
import * as market from "../src/service/eikon-marketplace"
import { eikon } from "../src/service/eikon"
import * as prefs from "../src/context/preferences"

const HH = process.env.HERMES_HOME!
if (!HH || resolve(HH) === resolve(join(homedir(), ".hermes"))) throw new Error("sandbox not applied")
const legacy = readFileSync(join(import.meta.dir, "fixtures/eikon/mono-v1.6.0-extract.eikon"), "utf8")

const launch = [
  JSON.stringify({ type: "header", eikon: 1, size: { cols: 4, rows: 2 }, defaultSignal: "state.idle", signals: { "state.idle": { clip: "idle" } } }),
  JSON.stringify({ type: "clip", name: "idle", fps: 12, frameCount: 1 }),
  JSON.stringify({ type: "frame", clip: "idle", index: 0, rows: ["abcd", "efgh"] }),
].join("\n") + "\n"
const png = new Uint8Array([137, 80, 78, 71])
const digest = (data: string | Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`
const wire = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

function pack(name: string, text = launch) {
  return {
    kind: "eikon.package",
    schemaVersion: "1.0",
    id: `liftaris/${name}`,
    name,
    version: "1.0.0",
    compatibility: { eikon: ">=1 <2" },
    entrypoints: { default: `${name}.eikon` },
    files: [
      { path: `${name}.eikon`, role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: text.length, digest: digest(text) },
      { path: "source.png", role: "source.base", mediaType: "image/png", size: png.length, digest: digest(png) },
    ],
    source: { base: "source.png" },
  }
}

function gzip(name: string) {
  const info = runtimeDescriptor(launch, { encoding: "gzip" })
  return {
    bytes: info.bytes,
    trust: {
      runtimeDigest: info.digest,
      runtimeSize: info.size,
      runtimeEncoding: info.encoding,
      runtimeDecodedSize: info.decodedSize,
      runtimeDecodedDigest: info.decodedDigest,
    },
    manifest: {
      kind: "eikon.package",
      schemaVersion: "1.0",
      id: `liftaris/${name}`,
      name,
      version: "1.0.0",
      compatibility: { eikon: ">=1 <2" },
      entrypoints: { default: `${name}.eikon` },
      files: [
        {
          path: `${name}.eikon`,
          role: "runtime",
          mediaType: "application/vnd.eikon.stream+jsonl",
          encoding: "gzip",
          size: info.size,
          digest: info.digest,
          decodedSize: info.decodedSize,
          decodedDigest: info.decodedDigest,
        },
      ],
    },
  }
}

type RouteBody = BodyInit | object | ((req: Request) => BodyInit | object)
type Route = { path: string; body: RouteBody; status?: number; headers?: HeadersInit }
type CatalogEntrySeed = {
  name: string
  id?: string
  version?: string
  author?: string
  description?: string
  poster?: string
  source?: string
  sourceKey?: string
  runtimeUrl?: string
  packageUrl?: string
  trust?: Record<string, unknown>
}

function url(raw: string, base: string) {
  return new URL(raw, base.endsWith("/") ? base : `${base}/`).toString()
}

function catalogRow(seed: CatalogEntrySeed, base: string) {
  const dir = url(seed.source ?? `${seed.name}/`, base)
  const runtimeUrl = seed.runtimeUrl ? url(seed.runtimeUrl, dir) : url(`${seed.name}.eikon`, dir)
  const packageUrl = seed.packageUrl ? url(seed.packageUrl, dir) : url("manifest.json", dir)
  return {
    kind: "eikon.catalog.entry",
    schemaVersion: "1.0",
    id: seed.id ?? seed.name,
    version: seed.version ?? "1.0.0",
    sourceKey: seed.sourceKey ?? dir,
    name: seed.name,
    title: seed.name,
    ...(seed.author ? { author: seed.author } : {}),
    ...(seed.description ? { description: seed.description } : {}),
    poster: seed.poster ?? seed.name,
    runtimeUrl,
    packageUrl,
    compatibility: { eikon: ">=1 <2", available: true },
    trust: seed.trust ?? {},
  }
}

function entry(seed: CatalogEntrySeed): Catalog["entries"][number] {
  const raw = catalogRow(seed, "https://example.com/eikons/")
  return {
    ...raw,
    w: 48,
    h: 24,
    width: 48,
    height: 24,
    trust: raw.trust,
    identityKey: raw.sourceKey,
    raw,
  } as Catalog["entries"][number]
}

function serve(routes: Route[], seen: string[] = []) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      seen.push(path)
      const hit = routes.find(r => r.path === path)
      if (!hit) return new Response("404", { status: 404 })
      const body = typeof hit.body === "function" ? hit.body(req) : hit.body
      if (typeof body === "object" && !(body instanceof Uint8Array))
        return Response.json(body, { status: hit.status ?? 200, headers: hit.headers })
      return new Response(body as BodyInit, { status: hit.status ?? 200, headers: hit.headers })
    },
  })
}

function fixture() {
  const seen: string[] = []
  const srv = serve([
    { path: "/eikons/index.json", body: req => {
      const base = `${new URL(req.url).origin}/eikons/`
      return [
        catalogRow({ name: "ares", author: "Kaio", poster: "ARES", source: "ares/" }, base),
        catalogRow({ name: "mono", author: "Nous", poster: "MONO", source: "mono/" }, base),
        catalogRow({ name: "ares", author: "Other", poster: "ALT", source: "alt/" }, base),
      ]
    } },
    { path: "/eikons/ares/ares.eikon", body: launch },
    { path: "/eikons/ares/manifest.json", body: pack("ares") },
    { path: "/eikons/ares/source.png", body: png },
    { path: "/eikons/mono/mono.eikon", body: launch },
    { path: "/eikons/mono/manifest.json", body: pack("mono") },
    { path: "/eikons/mono/source.png", body: png },
    { path: "/eikons/alt/ares.eikon", body: launch },
    { path: "/eikons/alt/manifest.json", body: pack("ares") },
    { path: "/eikons/alt/source.png", body: png },
  ], seen)
  return { srv, seen, base: `http://localhost:${srv.port}/eikons` }
}

afterEach(() => {
  prefs.set("eikon", undefined)
  rmSync(join(HH, "eikons"), { recursive: true, force: true })
})

describe("service/eikon-marketplace", () => {
  test("searches catalog metadata without fetching package payloads", async () => {
    const fx = fixture()
    const state = await market.load({ catalog: fx.base, allowPrivate: true, query: "kaio" })
    expect(state.rows.map(r => r.entry.name)).toEqual(["ares"])
    expect(fx.seen).toEqual(["/eikons/index.json"])
    fx.srv.stop()
  })

  test("returns recoverable error state for catalog load failure", async () => {
    const srv = serve([{ path: "/eikons/index.json", body: "nope", status: 503 }])
    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })
    expect(state.status).toBe("error")
    expect(state.error).toContain("catalog: HTTP 503")
    expect(state.rows).toEqual([])
    srv.stop()
  })

  test("custom catalogs cannot target official registry delist", async () => {
    const fx = fixture()
    const calls: string[][] = []
    const state = await market.load({ catalog: fx.base, allowPrivate: true, delistRun: async args => { calls.push(args); return "" } })
    const row = state.rows[0]!

    await expect(state.service!.delist(row.entry.identityKey)).rejects.toThrow(/official Eikon catalog/)
    expect(await state.service!.delistInfo(row.entry.identityKey)).toMatchObject({ eligible: false, reason: "Registry delist is only available from the official Eikon catalog" })
    expect(calls).toEqual([])
    fx.srv.stop()
  })

  test("maps installed and active state by catalog identity before name fallback", async () => {
    const fx = fixture()
    eikon.ensure("ares")
    writeFileSync(eikon.file("ares"), launch)
    writeFileSync(join(eikon.dir("ares"), "manifest.json"), JSON.stringify({
      name: "ares",
      origin: { source: `${fx.base}/alt/`, at: "2026-05-31T00:00:00.000Z" },
    }, null, 2))
    prefs.set("eikon", "ares")

    const state = await market.load({ catalog: fx.base, allowPrivate: true })
    const byPoster = new Map(state.rows.map(r => [r.entry.poster, r]))
    expect(byPoster.get("ALT")!.installed).toBe(true)
    expect(byPoster.get("ALT")!.active).toBe(true)
    expect(byPoster.get("ARES")!.installed).toBe(false)
    expect(byPoster.get("ALT")!.installedManifest?.origin?.source).toBe(`${fx.base}/alt/`)
    fx.srv.stop()
  })

  test("flat legacy files do not satisfy marketplace installed state", async () => {
    const fx = fixture()
    mkdirSync(join(HH, "eikons"), { recursive: true })
    writeFileSync(join(HH, "eikons", "mono.eikon"), legacy)

    const state = await market.load({ catalog: fx.base, allowPrivate: true })
    expect(state.rows.find(r => r.entry.name === "mono")!.installed).toBe(false)
    fx.srv.stop()
  })

  test("unkeyed local name fallback is not suppressed by unrelated keyed installs", async () => {
    const fx = fixture()
    eikon.ensure("ares")
    writeFileSync(eikon.file("ares"), launch)
    writeFileSync(join(eikon.dir("ares"), "manifest.json"), JSON.stringify({
      name: "ares",
      origin: { source: `${fx.base}/alt/`, at: "2026-05-31T00:00:00.000Z" },
    }))
    eikon.ensure("mono")
    writeFileSync(eikon.file("mono"), launch)

    const state = await market.load({ catalog: fx.base, allowPrivate: true })
    const mono = state.rows.find(r => r.entry.name === "mono")!
    const alt = state.rows.find(r => r.entry.poster === "ALT")!
    const ares = state.rows.find(r => r.entry.poster === "ARES")!

    expect(mono.installed).toBe(true)
    expect(mono.installState).toBe("legacy-name-match")
    expect(alt.installed).toBe(true)
    expect(ares.installed).toBe(false)
    fx.srv.stop()
  })

  test("preview loads selected entry with cache and abort support", async () => {
    const fx = fixture()
    const state = await market.load({ catalog: fx.base, allowPrivate: true })
    const svc = state.service!
    const row = state.rows[0]!

    expect(await svc.preview(row.entry.identityKey)).toBe(launch)
    expect(await svc.preview(row.entry.identityKey)).toBe(launch)
    expect(fx.seen.filter(p => p.endsWith("ares.eikon"))).toHaveLength(1)

    const ctl = new AbortController()
    ctl.abort()
    await expect(svc.preview(state.rows[1]!.entry.identityKey, { signal: ctl.signal })).rejects.toThrow(/aborted/i)
    fx.srv.stop()
  })

  test("preview decodes gzip runtime bytes and rejects transport gzip", async () => {
    const gz = gzip("zip")
    const srv = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({ name: "zip", source: "zip/", trust: gz.trust }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/zip/manifest.json", body: gz.manifest },
      { path: "/eikons/zip/zip.eikon", body: gz.bytes },
    ])
    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })

    expect(await state.service!.preview(state.rows[0]!.entry.identityKey)).toBe(launch)
    srv.stop()

    const bad = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({ name: "zip", source: "zip/", trust: gz.trust }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/zip/manifest.json", body: gz.manifest },
      { path: "/eikons/zip/zip.eikon", body: gz.bytes, headers: { "content-encoding": "gzip" } },
    ])
    const broken = await market.load({ catalog: `http://localhost:${bad.port}/eikons`, allowPrivate: true })

    await expect(broken.service!.preview(broken.rows[0]!.entry.identityKey)).rejects.toThrow(/content-encoding/i)
    bad.stop()
  })

  test("preview keeps explicit preview URLs and allows unverified transport gzip", async () => {
    const prev = launch.replace("abcd", "prev")
    const gz = runtimeDescriptor(launch, { encoding: "gzip" })
    const cat: Catalog = {
      base: "https://example.com/eikons",
      entries: [entry({ name: "split", runtimeUrl: "runtime.eikon" })],
      load: async () => "",
    }
    const seen: string[] = []
    const svc = new market.MarketplaceService(cat, {
      fetcher: async input => {
        seen.push(String(input))
        if (String(input).endsWith("runtime.eikon")) return new Response(wire(gz.bytes), { headers: { "content-encoding": "gzip" } })
        return new Response(prev)
      },
    })

    expect(await svc.preview(cat.entries[0]!.identityKey)).toBe(launch)
    expect(seen.some(u => u.endsWith("runtime.eikon"))).toBe(true)

    const raw: Catalog = { ...cat, entries: [entry({ name: "raw", runtimeUrl: "runtime.eikon" })] }
    const open = new market.MarketplaceService(raw, { fetcher: async () => new Response(wire(gz.bytes), { headers: { "content-encoding": "gzip" } }) })

    expect(await open.preview(raw.entries[0]!.identityKey)).toBe(launch)
  })

  test("preview deduplicates concurrent requests and caps cached entries", async () => {
    const fx = fixture()
    const state = await market.load({ catalog: fx.base, allowPrivate: true, previewCacheLimit: 1 })
    const svc = state.service!
    const ares = state.rows.find(r => r.entry.poster === "ARES")!
    const mono = state.rows.find(r => r.entry.name === "mono")!

    const [left, right] = await Promise.all([
      svc.preview(ares.entry.identityKey),
      svc.preview(ares.entry.identityKey),
    ])
    expect(left).toBe(launch)
    expect(right).toBe(launch)
    expect(fx.seen.filter(p => p.endsWith("ares.eikon"))).toHaveLength(1)

    expect(await svc.preview(mono.entry.identityKey)).toBe(launch)
    expect(await svc.preview(ares.entry.identityKey)).toBe(launch)
    expect(fx.seen.filter(p => p.endsWith("ares.eikon"))).toHaveLength(2)
    fx.srv.stop()
  })

  test("preview limits concurrent network loads", async () => {
    let active = 0
    let peak = 0
    const pending: (() => void)[] = []
    const waits: (() => void)[] = []
    const waitForFetch = () => pending.length > 0 ? Promise.resolve() : new Promise<void>(resolve => waits.push(resolve))
    const cat: Catalog = {
      base: "https://example.com/eikons",
      entries: ["one", "two", "three"].map(name => entry({ name })),
      load: async () => "",
    }
    const svc = new market.MarketplaceService(cat, {
      concurrency: 1,
      fetcher: async input => {
        active += 1
        peak = Math.max(peak, active)
        const done = waits.shift()
        if (done) done()
        await new Promise<void>(resolve => pending.push(resolve))
        active -= 1
        return new Response(String(input))
      },
    })

    const xs = cat.entries.map(e => svc.preview(e.identityKey))
    await waitForFetch()
    expect(active).toBe(1)
    pending.shift()!()
    await waitForFetch()
    expect(active).toBe(1)
    pending.shift()!()
    await waitForFetch()
    expect(active).toBe(1)
    pending.shift()!()

    await Promise.all(xs)
    expect(peak).toBe(1)
  })

  test("marketplace install writes files, bumps revision, and does not activate", async () => {
    const fx = fixture()
    prefs.set("eikon", "old")
    const before = eikon.revision()
    const state = await market.load({ catalog: fx.base, allowPrivate: true })
    const out = await state.service!.install(state.rows[0]!.entry.identityKey)

    expect(out.name).toBe("ares")
    expect(existsSync(eikon.file("ares"))).toBe(true)
    expect(existsSync(join(eikon.sourceDir("ares"), "base.png"))).toBe(false)
    expect(prefs.get("eikon")).toBe("old")
    expect(eikon.revision()).toBe(before + 1)
    const man = JSON.parse(readFileSync(join(eikon.dir("ares"), "manifest.json"), "utf8"))
    expect(man.origin.source).toBe(`${fx.base}/ares/manifest.json`)
    fx.srv.stop()
  })

  test("marketplace install preserves gzip runtime stored bytes", async () => {
    const gz = gzip("zip")
    const srv = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({ name: "zip", source: "zip/", trust: gz.trust }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/zip/manifest.json", body: gz.manifest },
      { path: "/eikons/zip/zip.eikon", body: gz.bytes },
    ])
    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })

    const out = await state.service!.install(state.rows[0]!.entry.identityKey)

    expect(out.name).toBe("zip")
    expect(Buffer.from(readFileSync(eikon.file("zip"))).equals(Buffer.from(gz.bytes))).toBe(true)
    expect(eikon.parseEikonFile(eikon.file("zip")).states.get("idle")!.frames[0]).toEqual(["abcd", "efgh"])
    srv.stop()
  })

  test("marketplace installs launch package catalog entries from explicit manifest URLs", async () => {
    const pkgManifest = {
      kind: "eikon.package",
      schemaVersion: "1.0",
      id: "liftaris/pkg",
      version: "1.0.0",
      name: "pkg",
      compatibility: { eikon: ">=1 <2" },
      entrypoints: { default: "streams/pkg.eikon" },
      files: [
        { path: "streams/pkg.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: launch.length, digest: digest(launch) },
        { path: "source/base.png", role: "source.base", mediaType: "image/png", size: png.length, digest: digest(png) },
        { path: "source/idle.mp4", role: "source.clip", mediaType: "video/mp4", size: 8, digest: digest(new Uint8Array(8)) },
      ],
      source: { base: "source/base.png", states: { idle: { file: "source/idle.mp4" } } },
    }
    const srv = serve([
      { path: "/eikons/index.json", body: req => {
        const u = new URL(req.url)
        return [catalogRow({
          id: "liftaris/pkg",
          version: "1.0.0",
          name: "pkg",
          source: "packages/pkg/",
          sourceKey: `registry:${u.host}:liftaris/pkg@1.0.0`,
          runtimeUrl: "streams/pkg.eikon",
          packageUrl: "manifest.json",
        }, `${u.origin}/eikons/`)]
      } },
      { path: "/eikons/packages/pkg/manifest.json", body: pkgManifest },
      { path: "/eikons/packages/pkg/streams/pkg.eikon", body: launch },
      { path: "/eikons/packages/pkg/source/base.png", body: png },
      { path: "/eikons/packages/pkg/source/idle.mp4", body: new Uint8Array(8) },
    ])
    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })
    const out = await state.service!.install(state.rows[0]!.entry.identityKey, { media: true })

    expect(out.name).toBe("pkg")
    expect(existsSync(eikon.file("pkg"))).toBe(true)
    expect(existsSync(join(eikon.sourceDir("pkg"), "base.png"))).toBe(true)
    expect(existsSync(join(eikon.sourceDir("pkg"), "idle.mp4"))).toBe(true)
    expect(JSON.parse(readFileSync(eikon.file("pkg"), "utf8").split("\n", 1)[0]!).type).toBe("header")
    srv.stop()
  })

  test("marketplace install binds verified catalog trust to fetched package manifest", async () => {
    const good = pack("ares")
    const evil = pack("ares", launch.replace("abcd", "EVIL"))
    const srv = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({
        name: "ares",
        source: "ares/",
        trust: { manifestDigest: digest(JSON.stringify(good)), runtimeDigest: digest(launch) },
      }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/ares/manifest.json", body: evil },
      { path: "/eikons/ares/ares.eikon", body: launch.replace("abcd", "EVIL") },
      { path: "/eikons/ares/source.png", body: png },
    ])
    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })

    await expect(state.service!.install(state.rows[0]!.entry.identityKey)).rejects.toThrow(/catalog trust mismatch: manifest digest/)
    expect(existsSync(eikon.file("ares"))).toBe(false)
    srv.stop()
  })

  test("marketplace install records verified trust after catalog digest binding", async () => {
    const man = pack("ares")
    const srv = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({
        name: "ares",
        source: "ares/",
        trust: { manifestDigest: digest(JSON.stringify(man)), runtimeDigest: digest(launch) },
      }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/ares/manifest.json", body: man },
      { path: "/eikons/ares/ares.eikon", body: launch },
      { path: "/eikons/ares/source.png", body: png },
    ])
    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })
    await state.service!.install(state.rows[0]!.entry.identityKey)

    const got = JSON.parse(readFileSync(join(eikon.dir("ares"), "manifest.json"), "utf8"))
    expect(got.origin.trust).toBe("verified")
    srv.stop()
  })

  test("preview enforces private-host policy outside explicit private mode", async () => {
    let seen = 0
    const cat: Catalog = {
      base: "https://example.com/eikons",
      entries: [entry({ name: "secret", runtimeUrl: "http://127.0.0.1:65530/secret.eikon" })],
      load: async () => "",
    }
    const svc = new market.MarketplaceService(cat, { fetcher: async () => { seen += 1; return new Response(launch) } })

    await expect(svc.preview(cat.entries[0]!.identityKey)).rejects.toThrow(/private host/)
    expect(seen).toBe(0)

    const dev = new market.MarketplaceService(cat, { allowPrivate: true, fetcher: async () => { seen += 1; return new Response(launch) } })
    expect(await dev.preview(cat.entries[0]!.identityKey)).toBe(launch)
    expect(seen).toBe(1)
  })

  test("rows expose installed record name instead of trusting manifest name", async () => {
    const fx = fixture()
    eikon.ensure("local")
    writeFileSync(eikon.file("local"), '{"eikon":1,"name":"local"}\n')
    writeFileSync(join(eikon.dir("local"), "manifest.json"), JSON.stringify({
      kind: "eikon.package",
      id: "liftaris/ares",
      name: "victim",
      origin: { sourceKey: `${fx.base}/ares/`, identityKey: `${fx.base}/ares/`, packageUrl: `${fx.base}/ares/manifest.json` },
    }))

    const state = await market.load({ catalog: fx.base, allowPrivate: true })
    const row = state.rows.find(r => r.entry.poster === "ARES")!

    expect(row.installed).toBe(true)
    expect(row.installedName).toBe("local")
    expect(row.installedManifest?.name).toBe("victim")
    fx.srv.stop()
  })

  test("failed marketplace install is retryable and does not activate or mark installed", async () => {
    const srv = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({ name: "bad", poster: "B", source: "bad/" }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/bad/manifest.json", body: "missing", status: 404 },
    ])
    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })
    await expect(state.service!.install(state.rows[0]!.entry.identityKey)).rejects.toThrow(/download failed 404/)
    expect(prefs.get("eikon")).toBeUndefined()
    expect(eikon.list().some(x => x.name === "bad")).toBe(false)
    srv.stop()
  })

  test("downloadSource writes source without replacing active runtime or manifest", async () => {
    const old = launch.replace("abcd", "OLDX")
    const next = launch.replace("abcd", "NEWX")
    const man = pack("live", next)
    const srv = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({ name: "live", source: "live/" }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/live/manifest.json", body: man },
      { path: "/eikons/live/live.eikon", body: next },
      { path: "/eikons/live/source.png", body: png },
    ])
    eikon.ensure("live")
    writeFileSync(eikon.file("live"), old)
    const mf = join(eikon.dir("live"), "manifest.json")
    writeFileSync(mf, JSON.stringify({
      ...man,
      origin: { sourceKey: `http://localhost:${srv.port}/eikons/live/`, identityKey: `http://localhost:${srv.port}/eikons/live/`, packageUrl: `http://localhost:${srv.port}/eikons/live/manifest.json` },
    }, null, 2))
    prefs.set("eikon", "live")
    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })
    const row = state.rows[0]!
    const before = readFileSync(mf, "utf8")

    expect(row.active).toBe(true)
    expect(row.sourceDownloadable).toBe(true)
    const out = await state.service!.downloadSource(row.entry.identityKey)

    expect(out.name).toBe("live")
    expect(readFileSync(eikon.file("live"), "utf8")).toContain("OLDX")
    expect(readFileSync(eikon.file("live"), "utf8")).not.toContain("NEWX")
    expect(readFileSync(mf, "utf8")).toBe(before)
    expect(existsSync(join(eikon.sourceDir("live"), "base.png"))).toBe(true)
    expect(prefs.get("eikon")).toBe("live")
    srv.stop()
  })

  test("downloadSource preserves extensions for content-addressed source blobs", async () => {
    const old = launch.replace("abcd", "OLDX")
    const next = launch.replace("abcd", "NEWX")
    const mp4 = new Uint8Array(1024)
    const man = {
      ...pack("blob", next),
      files: [
        { path: "blob.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: next.length, digest: digest(next) },
        { path: "blobs/sha256/base", role: "source.base", mediaType: "image/png", size: png.length, digest: digest(png) },
        { path: "blobs/sha256/idle", role: "source.idle", mediaType: "video/mp4", size: mp4.length, digest: digest(mp4) },
      ],
      source: { base: "blobs/sha256/base", states: { idle: { file: "blobs/sha256/idle" } } },
    }
    const srv = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({ name: "blob", source: "blob/" }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/blob/manifest.json", body: man },
      { path: "/eikons/blob/blob.eikon", body: next },
      { path: "/eikons/blob/blobs/sha256/base", body: png },
      { path: "/eikons/blob/blobs/sha256/idle", body: mp4 },
    ])
    eikon.ensure("blob")
    writeFileSync(eikon.file("blob"), old)
    writeFileSync(join(eikon.dir("blob"), "manifest.json"), JSON.stringify({
      ...man,
      origin: { sourceKey: `http://localhost:${srv.port}/eikons/blob/`, identityKey: `http://localhost:${srv.port}/eikons/blob/`, packageUrl: `http://localhost:${srv.port}/eikons/blob/manifest.json` },
    }, null, 2))

    const state = await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })
    const out = await state.service!.downloadSource(state.rows[0]!.entry.identityKey)

    expect(out.name).toBe("blob")
    expect(existsSync(join(eikon.sourceDir("blob"), "base.png"))).toBe(true)
    expect(existsSync(join(eikon.sourceDir("blob"), "idle.mp4"))).toBe(true)
    expect(eikon.findSource("blob")).toEndWith("base.png")
    expect(eikon.findSource("blob", "idle")).toEndWith("idle.mp4")
    expect(eikon.readStudio("blob")!.sources).toEqual({ base: "base.png", idle: "idle.mp4" })
    srv.stop()
  })

  test("bundled Nous satisfies the registry package identity", () => {
    prefs.set("eikon", "nous")
    const cat: Catalog = {
      base: "https://eikon.liftaris.dev/eikons",
      entries: [entry({
        name: "nous",
        id: "liftaris/nous",
        version: "1.0.0",
        sourceKey: "registry:eikon.liftaris.dev:liftaris/nous@1.0.0",
        packageUrl: "https://eikon.liftaris.dev/packages/liftaris/nous/1.0.0.json",
      })],
      load: async () => "",
    }
    const row = new market.MarketplaceService(cat).rows()[0]!

    expect(row.installed).toBe(true)
    expect(row.active).toBe(true)
    expect(row.installState).toBe("active")
    expect(row.action).toBe("active")
    expect(row.removable).toBe(false)
    expect(row.installedName).toBe("nous")
    expect(row.sourceIdentity).toBe("registry:eikon.liftaris.dev:liftaris/nous@1.0.0")
    expect(row.reason).toBeUndefined()
  })

  test("bundled Nous can download registry source without replacing runtime", async () => {
    const man = pack("nous")
    const srv = serve([
      { path: "/eikons/index.json", body: req => [catalogRow({
        name: "nous",
        id: "liftaris/nous",
        source: "nous/",
        sourceKey: "registry:eikon.liftaris.dev:liftaris/nous@1.0.0",
      }, `${new URL(req.url).origin}/eikons/`)] },
      { path: "/eikons/nous/manifest.json", body: man },
      { path: "/eikons/nous/nous.eikon", body: launch },
      { path: "/eikons/nous/source.png", body: png },
    ])
    prefs.set("eikon", "nous")
    const svc = (await market.load({ catalog: `http://localhost:${srv.port}/eikons`, allowPrivate: true })).service!
    const before = svc.rows()[0]!

    expect(before.installed).toBe(true)
    expect(before.active).toBe(true)
    expect(before.sourceDownloadable).toBe(true)
    const out = await svc.downloadSource(before.entry.identityKey)
    const after = svc.rows()[0]!

    expect(out.name).toBe("nous")
    expect(existsSync(eikon.file("nous"))).toBe(false)
    expect(existsSync(join(eikon.sourceDir("nous"), "base.png"))).toBe(true)
    expect(after.sourcePresent).toBe(true)
    expect(after.sourceDownloadable).toBe(false)
    expect(after.installState).toBe("active")
    srv.stop()
  })

  test("marketplace install requires acknowledgement before replacing active same-name package", async () => {
    const fx = fixture()
    const old = launch.replace("abcd", "OLDX")
    eikon.ensure("ares")
    writeFileSync(eikon.file("ares"), old)
    writeFileSync(join(eikon.dir("ares"), "manifest.json"), JSON.stringify({
      ...pack("ares", old),
      origin: { sourceKey: `${fx.base}/alt/`, identityKey: `${fx.base}/alt/`, packageUrl: `${fx.base}/alt/manifest.json`, at: "2026-06-07T00:00:00.000Z" },
    }, null, 2))
    prefs.set("eikon", "ares")
    const state = await market.load({ catalog: fx.base, allowPrivate: true })
    const row = state.rows.find(r => r.entry.poster === "ARES")!

    expect(row.installState).toBe("active-name-conflict")
    await expect(state.service!.install(row.entry.identityKey)).rejects.toThrow(/replace the active avatar/)
    expect(readFileSync(eikon.file("ares"), "utf8")).toContain("OLDX")

    await state.service!.install(row.entry.identityKey, { confirmActive: true })
    expect(readFileSync(eikon.file("ares"), "utf8")).not.toContain("OLDX")
    expect(readFileSync(eikon.file("ares"), "utf8")).toContain("abcd")
    expect(prefs.get("eikon")).toBe("ares")
    fx.srv.stop()
  })

  test("downloadSource rejects runtime-only descriptors before network access", async () => {
    const runtime = pack("runtime")
    delete (runtime as { source?: unknown }).source
    runtime.files = runtime.files.filter(f => f.role === "runtime")
    const cat: Catalog = {
      base: "https://example.com/eikons",
      entries: [entry({ name: "runtime", packageUrl: "https://example.com/eikons/runtime/manifest.json" })],
      load: async () => "",
    }
    eikon.ensure("runtime")
    writeFileSync(eikon.file("runtime"), '{"eikon":1,"name":"runtime"}\n')
    writeFileSync(join(eikon.dir("runtime"), "manifest.json"), JSON.stringify({
      ...runtime,
      origin: { sourceKey: "https://example.com/eikons/runtime/", identityKey: "https://example.com/eikons/runtime/", packageUrl: "https://example.com/eikons/runtime/manifest.json" },
    }, null, 2))
    let calls = 0
    const svc = new market.MarketplaceService(cat, { fetcher: async () => { calls += 1; return new Response(JSON.stringify(runtime)) } })

    await expect(svc.downloadSource(cat.entries[0]!.identityKey)).rejects.toThrow(/no source media published/)
    expect(calls).toBe(0)
  })

  test("available catalog rows require descriptor digests for verified trust", async () => {
    const cat: Catalog = {
      base: "https://example.com/eikons",
      entries: [
        entry({ name: "legacy", trust: {} }),
        entry({ name: "partial", trust: { manifestDigest: digest("manifest") } }),
        entry({ name: "signed", trust: { manifestDigest: digest("manifest"), runtimeDigest: digest(launch) } }),
      ],
      load: async () => "",
    }
    const svc = new market.MarketplaceService(cat)
    const rows = svc.rows()

    expect(rows.find(r => r.entry.name === "legacy")!.trust).toBe("unverified")
    expect(rows.find(r => r.entry.name === "partial")!.trust).toBe("unverified")
    expect(rows.find(r => r.entry.name === "signed")!.trust).toBe("verified")
  })

  test("incompatible rows are blocked before install", async () => {
    const cat: Catalog = {
      base: "https://example.com/eikons",
      entries: [{ ...entry({ name: "future" }), compatibility: { eikon: ">=99", available: false, reason: "requires newer Herm" } }],
      load: async () => "",
    }
    const svc = new market.MarketplaceService(cat)
    const row = svc.rows()[0]!

    expect(row.installState).toBe("incompatible")
    expect(row.reason).toBe("requires newer Herm")
    await expect(svc.install(row.entry.identityKey)).rejects.toThrow(/requires newer Herm/)
  })
})
