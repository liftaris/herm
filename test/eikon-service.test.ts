import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { runtimeDescriptor } from "eikon"
import { eikon } from "../src/service/eikon"
import { knobs } from "../src/utils/eikon-knobs"
import { native, caps, type Rasterizer } from "../src/utils/eikon-render"
import { parseEikon, parseEikonFile } from "../src/components/avatar/eikon"
import * as prefs from "../src/context/preferences"
import { eikons } from "./fixture/eikon"

const HH = process.env.HERMES_HOME!
if (!HH || resolve(HH) === resolve(join(homedir(), ".hermes"))) throw new Error("sandbox not applied")
const legacy = readFileSync(join(import.meta.dir, "fixtures/eikon/mono-v1.6.0-extract.eikon"), "utf8")
const legacyUrl = (JSON.parse(legacy.split("\n")[0]) as { source_url: string }).source_url
const current = [
  JSON.stringify({ type: "header", eikon: 1, size: { cols: 1, rows: 1 }, defaultSignal: "state.idle", signals: { "state.idle": { clip: "idle" } } }),
  JSON.stringify({ type: "clip", name: "idle", fps: 1, frameCount: 1, loopFrom: 0 }),
  JSON.stringify({ type: "frame", clip: "idle", index: 0, rows: ["."] }),
].join("\n") + "\n"
const digest = (data: string | Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`
const wire = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
let fx: ReturnType<typeof eikons>
beforeEach(() => { fx = eikons() })
afterEach(() => fx[Symbol.dispose]())

describe("service/eikon: layout", () => {
  test("ensure creates folder form", () => {
    const p = eikon.ensure("foo")
    expect(p.dir).toBe(join(HH, "eikons", "foo"))
    expect(existsSync(p.source)).toBe(true)
  })

  test("adopt + findSource: base → idle → first; per-state wins", () => {
    writeFileSync(join(HH, "ext.png"), "png")
    const f = eikon.adopt("foo", join(HH, "ext.png"))
    expect(f).toBe("base.png")
    expect(eikon.findSource("foo")).toBe(join(HH, "eikons", "foo", "source", "base.png"))
    writeFileSync(join(HH, "eikons", "foo", "source", "error.jpg"), "j")
    expect(eikon.findSource("foo", "error")).toMatch(/error\.jpg$/)
    expect(eikon.findSource("foo", "idle")).toMatch(/base\.png$/)
  })

  test("sourceStatus discovers media and honors draft tombstones", () => {
    eikon.ensure("status")
    writeFileSync(eikon.file("status"), current)
    writeFileSync(join(eikon.sourceDir("status"), "base.png"), "b")
    writeFileSync(join(eikon.sourceDir("status"), "thinking.png"), "t")

    const own = eikon.sourceStatus("status", "thinking")
    expect(own.kind).toBe("local")
    expect(own.role).toBe("thinking")
    expect(own.origin).toBe("discovered")
    const inherited = eikon.sourceStatus("status", "thinking", { sources: { thinking: null, base: "base.png" } })
    expect(inherited.kind).toBe("local")
    expect(inherited.role).toBe("base")
    expect(inherited.inherited).toBe(true)
    expect(inherited.removed).toBe(true)
    const removed = eikon.sourceStatus("status", "thinking", { sources: { thinking: null, base: null } })
    expect(removed.kind).toBe("baked")
    expect(removed.path).toBeUndefined()
  })

  test("sourceStatus advertises packageUrl-only downloads", () => {
    eikon.ensure("pkgstatus")
    writeFileSync(eikon.file("pkgstatus"), '{"eikon":1,"name":"pkgstatus"}\n')
    writeFileSync(join(eikon.dir("pkgstatus"), "manifest.json"), JSON.stringify({
      name: "pkgstatus",
      origin: { packageUrl: "http://x/pkgstatus/manifest.json", kind: "catalog-package" },
    }))

    const status = eikon.sourceStatus("pkgstatus")
    expect(status.kind).toBe("downloadable")
    expect(status.sourceUrl).toBe("http://x/pkgstatus/manifest.json")
    expect(eikon.list().find(x => x.name === "pkgstatus")!.sourceUrl).toBe("http://x/pkgstatus/manifest.json")
  })

  test("studio.json round-trip", () => {
    const s = knobs.fresh("foo", native)
    eikon.writeStudio("foo", knobs.toStudio(s))
    const r = eikon.readStudio("foo")!
    expect(r.rasterizer).toBe("native")
    expect(r.glyph).toBe("◆")
  })

  test("default bundled alias resolves to Nous", () => {
    expect(eikon.baked("default")).toBe(eikon.baked("nous"))
    expect(eikon.baked("nous")).toEndWith("nous.eikon")
  })

  test("bundled Nous can be selected through installed-use path", () => {
    eikon.useInstalled("nous")
    expect(prefs.get("eikon")).toBe("nous")
  })

  test("list returns folder-form installs only", () => {
    eikon.ensure("foo")
    writeFileSync(eikon.file("foo"), current)
    eikon.ensure("bar"); writeFileSync(eikon.file("bar"), current)
    writeFileSync(join(HH, "eikons", "flat.eikon"), "{}")
    const xs = eikon.list()
    const names = xs.map(x => x.name)
    expect(names).toContain("foo"); expect(names).toContain("bar")
    expect(names).not.toContain("flat")
    expect(xs.find(x => x.name === "foo")!.hasSource).toBe(false)
  })
})

describe("service/eikon: registry", () => {
  test("built-ins present; register/unregister; pick prefers available", () => {
    expect(eikon.rasterizers().map(r => r.name)).toEqual(["chafa", "native"])
    const fake: Rasterizer = {
      name: "fake", knobs: {},
      available: () => true, render: async () => ({ frames: [[""]] }),
    }
    let pinged = 0
    const off = eikon.onRegistry(() => pinged++)
    const un = eikon.register(fake)
    expect(eikon.rasterizer("fake")).toBe(fake)
    expect(pinged).toBe(1)
    // pick: unavailable prefer → first available. fake is always
    // available, so this holds regardless of chafa/ffmpeg on the host.
    expect(eikon.pick("nope").available()).toBe(true)
    expect(eikon.pick("fake")).toBe(fake)
    un()
    expect(eikon.rasterizer("fake")).toBeUndefined()
    off()
    // With only built-ins, pick() at least falls back to native.
    expect(["chafa", "native"]).toContain(eikon.pick("nope").name)
  })
})

describe("service/eikon: save", () => {
  const run = caps.ffmpeg ? test : test.skip
  run("save writes launch stream, preserves legacy source_url as manifest origin, and bumps revision", async () => {
    const before = eikon.revision()
    eikon.ensure("pack")
    // Valid 16×16 gray PNG via ffmpeg so native can decode it.
    const png = join(HH, "eikons", "pack", "source", "base.png")
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=gray:s=16x16", "-frames:v", "1", "-y", png])
    writeFileSync(eikon.file("pack"), legacy)
    const s = knobs.fresh("pack", native, eikon.readStudio("pack"))
    s.sources = { base: "base.png" }
    const out = await eikon.save(s)
    expect(out).toBe(eikon.file("pack"))
    expect(prefs.get("eikon")).toBeUndefined()
    expect(eikon.revision()).toBe(before + 1)
    const doc = parseEikon(readFileSync(out, "utf8"))
    expect(doc.meta.width).toBe(48)
    expect(doc.states.size).toBe(6)
    expect(eikon.header(out)!.source_url).toBeUndefined()
    const man = JSON.parse(readFileSync(join(eikon.dir("pack"), "manifest.json"), "utf8"))
    expect(man.origin.source).toBe(legacyUrl)
    expect(eikon.list().find(x => x.name === "pack")!.sourceUrl).toBe(legacyUrl)
  })

  test("save with no source writes glyph placeholder frames", async () => {
    eikon.ensure("empty"); writeFileSync(eikon.file("empty"), '{"eikon":1,"name":"empty"}\n')
    const s = knobs.fresh("empty", native)
    const out = await eikon.save(s)
    const doc = parseEikon(readFileSync(out, "utf8"))
    expect(doc.states.get("idle")!.frames[0]!.join("")).toContain("◆")
  })
})

describe("service/eikon: fetchSource", () => {
  const png = new Uint8Array([137, 80, 78, 71])
  const launch = [
    JSON.stringify({ type: "header", eikon: 1, size: { cols: 4, rows: 2 }, defaultSignal: "state.idle", signals: { "state.idle": { clip: "idle" } } }),
    JSON.stringify({ type: "clip", name: "idle", fps: 12, frameCount: 1 }),
    JSON.stringify({ type: "frame", clip: "idle", index: 0, rows: ["abcd", "efgh"] }),
  ].join("\n") + "\n"
  const body = (name: string) => {
    if (name === "manifest.json") return Response.json({
      kind: "eikon.package",
      schemaVersion: "1.0",
      id: "liftaris/ares",
      name: "ares",
      version: "1.0.0",
      compatibility: { eikon: ">=1 <2" },
      entrypoints: { default: "ares.eikon" },
      files: [
        { path: "ares.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: launch.length, digest: digest(launch) },
        { path: "source.png", role: "source.base", mediaType: "image/png", size: png.length, digest: digest(png) },
      ],
      source: { base: "source.png" },
    })
    if (name === "ares.eikon") return new Response(launch)
    if (name === "source.png") return new Response(png)
    if (name.endsWith(".mp4")) return new Response(new Uint8Array(1024))
    return new Response("404", { status: 404 })
  }
  test("eikon-repo manifest: role-mapped, studio.json sources written, peek caches", async () => {
    const srv = Bun.serve({ port: 0, fetch: r => body(new URL(r.url).pathname.split("/").pop()!) })
    const url = `http://localhost:${srv.port}/x/`
    const peek = await eikon.peekSource(url)
    expect(peek!.n).toBe(1)
    expect(peek!.bytes).toBe(4)
    const out = await eikon.fetchSource(url, { name: "remix" })
    expect(out.name).toBe("remix")
    expect(out.n).toBe(1)
    expect(out.sources.base).toBe("base.png")
    expect(existsSync(join(eikon.sourceDir("remix"), "base.png"))).toBe(true)
    // studio.json + manifest.json (with origin) both written.
    expect(eikon.readStudio("remix")!.sources.base).toBe("base.png")
    const man = JSON.parse(readFileSync(join(eikon.dir("remix"), "manifest.json"), "utf8"))
    expect(man.origin.source).toBe(url)
    expect(eikon.list().find(x => x.name === "remix")!.manifest!.origin).toEqual(man.origin)
    expect(man.license).toBeUndefined()
    expect(man.provenance).toBeUndefined()
    // peekSource memoized — second call returns the first Promise.
    const first = eikon.peekSource(url)
    const second = eikon.peekSource(url)
    expect(first).toBe(second)
    srv.stop()
  })

  test("downloadSource writes source without replacing runtime or manifest", async () => {
    const srv = Bun.serve({ port: 0, fetch: r => body(new URL(r.url).pathname.split("/").pop()!) })
    const url = `http://localhost:${srv.port}/source-only/manifest.json`
    eikon.ensure("sourceonly")
    writeFileSync(eikon.file("sourceonly"), "OLD-RUNTIME\n")
    const mf = join(eikon.dir("sourceonly"), "manifest.json")
    writeFileSync(mf, JSON.stringify({ name: "sourceonly", origin: { packageUrl: url, kind: "catalog-package" } }, null, 2))
    const before = readFileSync(mf, "utf8")

    const out = await eikon.downloadSource("sourceonly")

    expect(out.name).toBe("sourceonly")
    expect(out.sources.base).toBe("base.png")
    expect(readFileSync(eikon.file("sourceonly"), "utf8")).toBe("OLD-RUNTIME\n")
    expect(readFileSync(mf, "utf8")).toBe(before)
    expect(existsSync(join(eikon.sourceDir("sourceonly"), "base.png"))).toBe(true)
    expect(eikon.readStudio("sourceonly")!.sources.base).toBe("base.png")
    expect(eikon.sourceStatus("sourceonly").kind).toBe("local")
    srv.stop()
  })

  test("fetchSource can install without source media", async () => {
    const srv = Bun.serve({ port: 0, fetch: r => body(new URL(r.url).pathname.split("/").pop()!) })
    const url = `http://localhost:${srv.port}/nosource/`
    const out = await eikon.fetchSource(url, { name: "nosource", media: false })
    expect(out.name).toBe("nosource")
    expect(out.n).toBe(1)
    expect(out.bytes).toBe(0)
    expect(out.sources).toEqual({})
    expect(eikon.readStudio("nosource")!.sources).toEqual({})
    expect(existsSync(join(eikon.sourceDir("nosource"), "base.png"))).toBe(false)
    srv.stop()
  })

  test("fetchSource preserves media extensions for content-addressed source blobs", async () => {
    const mp4 = new Uint8Array(1024)
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path.endsWith("manifest.json")) return Response.json({
          kind: "eikon.package",
          schemaVersion: "1.0",
          id: "liftaris/blobbed",
          name: "blobbed",
          version: "1.0.0",
          compatibility: { eikon: ">=1 <2" },
          entrypoints: { default: "blobbed.eikon" },
          files: [
            { path: "blobbed.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: launch.length, digest: digest(launch) },
            { path: "blobs/sha256/base", role: "source.base", mediaType: "image/png", size: png.length, digest: digest(png) },
            { path: "blobs/sha256/idle", role: "source.idle", mediaType: "video/mp4", size: mp4.length, digest: digest(mp4) },
          ],
          source: { base: "blobs/sha256/base", states: { idle: { file: "blobs/sha256/idle" } } },
        })
        if (path.endsWith("blobbed.eikon")) return new Response(launch)
        if (path.endsWith("/base")) return new Response(png)
        if (path.endsWith("/idle")) return new Response(mp4)
        return new Response("404", { status: 404 })
      },
    })

    const out = await eikon.fetchSource(`http://localhost:${srv.port}/pkg/manifest.json`)

    expect(out.sources.base).toBe("base.png")
    expect(out.sources.idle).toBe("idle.mp4")
    expect(existsSync(join(eikon.sourceDir("blobbed"), "base.png"))).toBe(true)
    expect(existsSync(join(eikon.sourceDir("blobbed"), "idle.mp4"))).toBe(true)
    expect(eikon.findSource("blobbed")).toEndWith("base.png")
    expect(eikon.findSource("blobbed", "idle")).toEndWith("idle.mp4")
    expect(eikon.readStudio("blobbed")!.sources).toEqual({ base: "base.png", idle: "idle.mp4" })
    srv.stop()
  })


  test("installPackage honors the supplied fetcher instead of global fetch", async () => {
    const seen: string[] = []
    const fetcher = async (input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      seen.push(u.pathname)
      return body(u.pathname.split("/").pop()!)
    }

    const out = await eikon.installPackage("https://example.com/pkg/manifest.json", { fetcher })

    expect(out.name).toBe("ares")
    expect(seen).toContain("/pkg/manifest.json")
    expect(seen).toContain("/pkg/ares.eikon")
    expect(existsSync(eikon.file("ares"))).toBe(true)
  })

  test("fetchSource installs gzip runtime packages as stored bytes", async () => {
    const info = runtimeDescriptor(launch, { encoding: "gzip" })
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const name = new URL(req.url).pathname.split("/").pop()!
        if (name === "manifest.json") return Response.json({
          kind: "eikon.package",
          schemaVersion: "1.0",
          id: "liftaris/gzip",
          name: "gzip",
          version: "1.0.0",
          compatibility: { eikon: ">=1 <2" },
          entrypoints: { default: "gzip.eikon" },
          files: [{
            path: "gzip.eikon",
            role: "runtime",
            mediaType: "application/vnd.eikon.stream+jsonl",
            encoding: "gzip",
            size: info.size,
            digest: info.digest,
            decodedSize: info.decodedSize,
            decodedDigest: info.decodedDigest,
          }],
        })
        if (name === "gzip.eikon") return new Response(wire(info.bytes))
        return new Response("404", { status: 404 })
      },
    })

    const out = await eikon.fetchSource(`http://localhost:${srv.port}/pkg/`, { media: false })

    expect(out.name).toBe("gzip")
    expect(Buffer.from(readFileSync(eikon.file("gzip"))).equals(Buffer.from(info.bytes))).toBe(true)
    expect(parseEikonFile(eikon.file("gzip")).states.get("idle")!.frames[0]).toEqual(["abcd", "efgh"])
    srv.stop()
  })

  test("fetchSource rejects digest-bound gzip runtime served with Content-Encoding", async () => {
    const info = runtimeDescriptor(launch, { encoding: "gzip" })
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const name = new URL(req.url).pathname.split("/").pop()!
        if (name === "manifest.json") return Response.json({
          kind: "eikon.package",
          schemaVersion: "1.0",
          id: "liftaris/wiregzip",
          name: "wiregzip",
          version: "1.0.0",
          compatibility: { eikon: ">=1 <2" },
          entrypoints: { default: "wiregzip.eikon" },
          files: [{
            path: "wiregzip.eikon",
            role: "runtime",
            mediaType: "application/vnd.eikon.stream+jsonl",
            encoding: "gzip",
            size: info.size,
            digest: info.digest,
            decodedSize: info.decodedSize,
            decodedDigest: info.decodedDigest,
          }],
        })
        if (name === "wiregzip.eikon") return new Response(wire(info.bytes), { headers: { "content-encoding": "gzip" } })
        return new Response("404", { status: 404 })
      },
    })

    await expect(eikon.fetchSource(`http://localhost:${srv.port}/pkg/`, { media: false })).rejects.toThrow(/content-encoding/i)
    expect(existsSync(eikon.file("wiregzip"))).toBe(false)
    srv.stop()
  })

  test("previewPackage decodes gzip package entrypoints", async () => {
    const names = ["idle", "listening", "thinking", "speaking", "working", "error"]
    const full = [
      JSON.stringify({ type: "header", eikon: 1, size: { cols: 4, rows: 2 }, defaultSignal: "state.idle", signals: Object.fromEntries(names.map(name => [`state.${name}`, { clip: name }])) }),
      ...names.flatMap(name => [
        JSON.stringify({ type: "clip", name, fps: 12, frameCount: 1 }),
        JSON.stringify({ type: "frame", clip: name, index: 0, rows: ["abcd", "efgh"] }),
      ]),
    ].join("\n") + "\n"
    const info = runtimeDescriptor(full, { encoding: "gzip" })
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const name = new URL(req.url).pathname.split("/").pop()!
        if (name === "manifest.json") return Response.json({
          kind: "eikon.package",
          schemaVersion: "1.0",
          id: "liftaris/preview-gzip",
          name: "preview-gzip",
          version: "1.0.0",
          compatibility: { eikon: ">=1 <2" },
          entrypoints: { default: "preview-gzip.eikon" },
          files: [{
            path: "preview-gzip.eikon",
            role: "runtime",
            mediaType: "application/vnd.eikon.stream+jsonl",
            encoding: "gzip",
            size: info.size,
            digest: info.digest,
            decodedSize: info.decodedSize,
            decodedDigest: info.decodedDigest,
          }],
        })
        if (name === "preview-gzip.eikon") return new Response(wire(info.bytes))
        return new Response("404", { status: 404 })
      },
    })

    const out = await eikon.previewPackage({ packageUrl: `http://localhost:${srv.port}/pkg/manifest.json` } as Parameters<typeof eikon.previewPackage>[0])

    expect(out.eikon.states.get("idle")!.frames[0]).toEqual(["abcd", "efgh"])
    srv.stop()
  })
})

describe("service/eikon: lifecycle", () => {
  test("normalizes typed origin, trust, metadata, and active state", () => {
    eikon.ensure("typed")
    writeFileSync(eikon.file("typed"), '{"eikon":1,"name":"typed"}\n')
    writeFileSync(join(eikon.dir("typed"), "manifest.json"), JSON.stringify({
      kind: "eikon.package",
      id: "liftaris/typed",
      name: "typed",
      version: "1.2.3",
      display: { title: "Typed", author: "Kaio" },
      compatibility: { eikon: ">=1 <2" },
      entrypoints: { default: "typed.eikon" },
      origin: {
        source: "github.com/liftaris/eikon/typed",
        at: "2026-06-07T00:00:00.000Z",
        kind: "github-catalog",
        trust: "verified",
        repo: "github.com/liftaris/eikon/typed",
        selector: "typed",
        sha: "abc123",
        sourceKey: "liftaris/typed",
      },
    }, null, 2))
    prefs.set("eikon", "typed")

    const info = eikon.lifecycle("typed")

    expect(info.title).toBe("Typed")
    expect(info.author).toBe("Kaio")
    expect(info.version).toBe("1.2.3")
    expect(info.source.kind).toBe("github-catalog")
    expect(info.source.identity).toBe("liftaris/typed")
    expect(info.source.selector).toBe("typed")
    expect(info.source.sha).toBe("abc123")
    expect(info.trust).toBe("verified")
    expect(info.active).toBe(true)
    expect(info.removable).toBe(true)
    expect(info.updateable).toBe(true)
  })


  test("list surfaces malformed installed manifests instead of losing their metadata", () => {
    eikon.ensure("corrupt")
    writeFileSync(eikon.file("corrupt"), '{"eikon":1,"name":"corrupt"}\n')
    writeFileSync(join(eikon.dir("corrupt"), "manifest.json"), "{")
    expect(() => eikon.list()).toThrow(SyntaxError)
  })

  test("packageUrl-only origins are advertised and updateable", async () => {
    const text = [
      JSON.stringify({ type: "header", eikon: 1, size: { cols: 4, rows: 2 }, defaultSignal: "state.idle", signals: { "state.idle": { clip: "idle" } } }),
      JSON.stringify({ type: "clip", name: "idle", fps: 12, frameCount: 1 }),
      JSON.stringify({ type: "frame", clip: "idle", index: 0, rows: ["abcd", "efgh"] }),
    ].join("\n") + "\n"
    const data = new Uint8Array([137, 80, 78, 71])
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const name = new URL(req.url).pathname.split("/").pop()!
        if (name === "manifest.json") return Response.json({
          kind: "eikon.package",
          schemaVersion: "1.0",
          id: "liftaris/pkgonly",
          name: "pkgonly",
          version: "1.0.0",
          compatibility: { eikon: ">=1 <2" },
          entrypoints: { default: "pkgonly.eikon" },
          files: [
            { path: "pkgonly.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: text.length, digest: digest(text) },
            { path: "source.png", role: "source.base", mediaType: "image/png", size: data.length, digest: digest(data) },
          ],
          source: { base: "source.png" },
        })
        if (name === "pkgonly.eikon") return new Response(text)
        if (name === "source.png") return new Response(data)
        return new Response("404", { status: 404 })
      },
    })
    const url = `http://localhost:${srv.port}/pkg/manifest.json`
    eikon.ensure("pkgonly")
    writeFileSync(eikon.file("pkgonly"), '{"eikon":1,"name":"pkgonly"}\n')
    writeFileSync(join(eikon.dir("pkgonly"), "manifest.json"), JSON.stringify({
      name: "pkgonly",
      origin: { packageUrl: url, kind: "catalog-package" },
    }))

    expect(eikon.lifecycle("pkgonly").updateable).toBe(true)
    const out = await eikon.update("pkgonly")

    expect("type" in out).toBe(false)
    expect(out.name).toBe("pkgonly")
    srv.stop()
  })

  test("active remove/update require explicit acknowledgement before mutation", async () => {
    eikon.ensure("live")
    writeFileSync(eikon.file("live"), '{"eikon":1,"name":"live"}\n')
    writeFileSync(join(eikon.dir("live"), "manifest.json"), JSON.stringify({ name: "live", origin: { source: "http://x/live/", at: "2026-06-07T00:00:00.000Z", kind: "catalog-package" } }))
    prefs.set("eikon", "live")

    const remove = eikon.remove("live")
    expect(remove?.type).toBe("active-consequence")
    expect(existsSync(eikon.file("live"))).toBe(true)
    expect(prefs.get("eikon")).toBe("live")

    const update = await eikon.update("live")
    expect("type" in update && update.type).toBe("active-consequence")
    expect(existsSync(eikon.file("live"))).toBe(true)
  })

  test("remove deletes flat legacy eikon files", () => {
    mkdirSync(join(HH, "eikons"), { recursive: true })
    const old = join(HH, "eikons", "liftaris.eikon")
    writeFileSync(old, legacy)
    prefs.set("eikon", "liftaris")

    expect(eikon.baked("liftaris")).toBe(old)
    const held = eikon.remove("liftaris")
    expect(held?.type).toBe("active-consequence")
    expect(existsSync(old)).toBe(true)

    expect(eikon.remove("liftaris", { confirmActive: true })).toBeUndefined()
    expect(existsSync(old)).toBe(false)
    expect(prefs.get("eikon")).toBeUndefined()
  })
})
