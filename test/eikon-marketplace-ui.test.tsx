import { describe, expect, test, afterEach } from "bun:test"
import { act } from "react"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { mount, mountNode, until } from "./harness"
import { EikonGroup } from "../src/tabs/EikonGroup"
import { eikon } from "../src/service/eikon"
import * as prefs from "../src/context/preferences"

const HH = process.env.HERMES_HOME!
const launchBody = (name: string, author: string, frames: Record<string, string>) => {
  const rows = (line: string) => Array.from({ length: 24 }, (_, i) => (i === 0 ? line : "").padEnd(48))
  return [
    JSON.stringify({
      type: "header", eikon: 1, id: `liftaris/${name}`, version: "1.0", title: name,
      author: { name: author }, size: { cols: 48, rows: 24 }, defaultSignal: "state.idle",
      signals: Object.fromEntries(Object.keys(frames).map(state => [
        `state.${state}`,
        state === "idle" ? { clip: state } : { clip: state, fallback: "state.idle" },
      ])),
    }),
    ...Object.entries(frames).flatMap(([state, frame]) => [
      JSON.stringify({ type: "clip", name: state, fps: 1, frameCount: 1, loopFrom: 0 }),
      JSON.stringify({ type: "frame", clip: state, index: 0, rows: rows(frame) }),
    ]),
  ].join("\n") + "\n"
}
const body = launchBody("ares", "Kaio", { idle: "ARES-IDLE", thinking: "ARES-THINKING" })
const monoBody = launchBody("mono", "Nous", { idle: "MONO-IDLE" })
const digest = (data: string | Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`
const png = new Uint8Array([137, 80, 78, 71])
const servers = new Set<ReturnType<typeof Bun.serve>>()

type Route = { path: string; body: BodyInit | object | ((req?: Request) => Response | Promise<Response> | BodyInit | object); status?: number; headers?: HeadersInit }

function serve(routes: Route[], seen: string[] = []) {
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      seen.push(path)
      const hit = routes.findLast(r => r.path === path)
      if (!hit) return new Response("404", { status: 404 })
      if (typeof hit.body === "function") {
        const out = hit.body(req)
        return out instanceof Response || out instanceof Promise ? out as Response | Promise<Response> : typeof out === "object" && !(out instanceof Uint8Array) ? Response.json(out, { status: hit.status ?? 200, headers: hit.headers }) : new Response(out as BodyInit, { status: hit.status ?? 200, headers: hit.headers })
      }
      if (typeof hit.body === "object" && !(hit.body instanceof Uint8Array))
        return Response.json(hit.body, { status: hit.status ?? 200, headers: hit.headers })
      return new Response(hit.body as BodyInit, { status: hit.status ?? 200, headers: hit.headers })
    },
  })
  servers.add(srv)
  return srv
}

function catalog(extra: Route[] = [], seen: string[] = []) {
  const aresManifest = {
    kind: "eikon.package", schemaVersion: "1.0", id: "liftaris/ares", name: "ares", version: "1.0.0",
    display: { title: "Ares", author: "Kaio", description: "red warrior" },
    compatibility: { eikon: ">=1 <2" }, entrypoints: { default: "ares.eikon" },
    files: [
      { path: "ares.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: body.length, digest: digest(body) },
      { path: "source/base.png", role: "source.base", mediaType: "image/png", size: png.length, digest: digest(png) },
    ],
    source: { base: "source/base.png" },
  }
  const monoManifest = {
    ...aresManifest,
    id: "liftaris/mono", name: "mono",
    display: { title: "Mono", author: "Nous", description: "quiet lines" },
    entrypoints: { default: "mono.eikon" },
    files: [
      { path: "mono.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: monoBody.length, digest: digest(monoBody) },
      { path: "source/base.png", role: "source.base", mediaType: "image/png", size: png.length, digest: digest(png) },
    ],
  }
  const srv = serve([
    { path: "/eikons/index.json", body: [
      { name: "ares", author: "Kaio", width: 48, height: 24, poster: "ARES-POSTER", source: "ares/", description: "red warrior" },
      { name: "mono", author: "Nous", width: 48, height: 24, poster: "MONO-POSTER", source: "mono/", description: "quiet lines" },
      { name: "delta", author: "Other", width: 48, height: 24, poster: "DELTA-POSTER", source: "delta/", description: "triangle field" },
      { name: "echo", author: "Echo", width: 48, height: 24, poster: "ECHO-POSTER", source: "echo/", description: "sound wall" },
      { name: "foxtrot", author: "Fox", width: 48, height: 24, poster: "FOX-POSTER", source: "foxtrot/", description: "fox field" },
      { name: "gamma", author: "Gamma", width: 48, height: 24, poster: "GAMMA-POSTER", source: "gamma/", description: "green field" },
    ] },
    { path: "/eikons/ares/ares.eikon", body },
    { path: "/eikons/ares/manifest.json", body: aresManifest },
    { path: "/eikons/ares/source/base.png", body: png },
    { path: "/eikons/mono/mono.eikon", body: monoBody },
    { path: "/eikons/mono/manifest.json", body: monoManifest },
    { path: "/eikons/mono/source/base.png", body: png },
    ...extra,
  ], seen)
  return { srv, seen, base: `http://localhost:${srv.port}/eikons` }
}

function local(name: string) {
  const p = eikon.ensure(name)
  writeFileSync(join(p.source, "base.png"), png)
  writeFileSync(eikon.file(name), JSON.stringify({ eikon: 1, name, author: "Local", width: 48, height: 24 }) + "\n")
}

function packageCatalog(extra: Route[] = [], seen: string[] = []) {
  const runtime = {
    kind: "eikon.package", schemaVersion: "1.0", id: "liftaris/ares", name: "ares", version: "1.0.0",
    display: { title: "Ares", author: "Kaio", description: "red warrior" },
    compatibility: { eikon: ">=1 <2" }, entrypoints: { default: "ares.eikon" },
    files: [{ path: "ares.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: body.length, digest: digest(body) }], poster: "poster.txt",
  }
  const source = {
    ...runtime,
    id: "liftaris/mono",
    name: "mono",
    display: { title: "Mono", author: "Nous", description: "quiet lines" },
    entrypoints: { default: "mono.eikon" },
    files: [
      { path: "mono.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: monoBody.length, digest: digest(monoBody) },
      { path: "source/base.png", role: "source.base", mediaType: "image/png", size: png.length, digest: digest(png) },
    ],
    source: { base: "source/base.png" },
  }
  const srv = serve([
    { path: "/eikons/index.json", body: [
      {
        name: "ares", author: "Kaio", description: "red warrior", poster: "ARES-POSTER", source: "ares/",
        trust: { manifestDigest: "sha256:manifest", runtimeDigest: digest(body) },
      },
      { manifest: source, packageUrl: "mono/manifest.json" },
    ] },
    { path: "/eikons/ares/manifest.json", body: runtime },
    { path: "/eikons/ares/ares.eikon", body },
    { path: "/eikons/mono/manifest.json", body: source },
    { path: "/eikons/mono/mono.eikon", body: monoBody },
    { path: "/eikons/mono/source/base.png", body: png },
    ...extra,
  ], seen)
  return { srv, seen, base: `http://localhost:${srv.port}/eikons` }
}

function group(props: { sub?: number } = {}) {
  let sub = props.sub ?? 1
  return <EikonGroup focused sub={sub} setSub={i => { sub = i }} />
}

async function openMarketplaceTab(t: Awaited<ReturnType<typeof mount>>) {
  act(() => t.keys.pressKey("5", { meta: true }))
  await t.settle()
  act(() => t.keys.pressArrow("right", { shift: true }))
  await until(t, () => t.frame().includes("ARES-IDLE"))
}

afterEach(() => {
  for (const srv of servers) {
    try { srv.stop() } catch {}
  }
  servers.clear()
  delete process.env.EIKON_URL
  prefs.set("eikon", undefined)
  rmSync(join(HH, "eikons"), { recursive: true, force: true })
})

describe("EikonMarketplace tab", () => {
  test("inactive marketplace pane does not load the catalog", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group({ sub: 0 }), { width: 120, height: 28 })
    await t.settle()
    await Bun.sleep(30)
    expect(fx.seen).toEqual([])
    fx.srv.stop()
  })

  test("poster grid fetches only the selected runtime preview", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 220, height: 28 })
    await until(t, () => t.frame().includes("ARES-POSTER") && t.frame().includes("ARES-IDLE"))
    await t.settle()

    expect(fx.seen.filter(path => path.endsWith(".eikon"))).toEqual(["/eikons/ares/ares.eikon"])
    fx.srv.stop()
  })

  test("poster cards reserve the full ASCII thumbnail height", async () => {
    const poster = Array.from({ length: 24 }, (_, i) => `ARES-${String(i).padStart(2, "0")}`).join("\n")
    const fx = catalog([{ path: "/eikons/index.json", body: [
      { name: "ares", author: "Kaio", width: 48, height: 24, poster, source: "ares/", description: "red warrior" },
    ] }])
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 220, height: 36 })
    await until(t, () => t.frame().includes("ARES-00") && t.frame().includes("ARES-23"))
    const lines = t.frame().split("\n")
    expect(lines.findIndex(line => line.includes("ARES-23")) - lines.findIndex(line => line.includes("ARES-00"))).toBe(23)
    fx.srv.stop()
  })

  test("catalog grid wraps more than two cards when space allows", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 300, height: 36 })
    await until(t, () => t.frame().includes("ARES-POSTER") && t.frame().includes("DELTA-POSTER"))
    const line = t.frame().split("\n").find(l => l.includes("ARES-POSTER")) ?? ""
    expect(line).toContain("MONO-POSTER")
    expect(line).toContain("DELTA-POSTER")
    fx.srv.stop()
  })

  test("catalog grid hides only below one card of available width", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using shown = await mountNode(group(), { width: 122, height: 48 })
    await until(shown, () => shown.frame().includes("ARES-POSTER") && shown.frame().includes("ARES-IDLE"))

    await using hidden = await mountNode(group(), { width: 121, height: 48 })
    await until(hidden, () => hidden.frame().includes("ARES-IDLE"))
    expect(hidden.frame()).not.toContain("ARES-POSTER")
    fx.srv.stop()
  })

  test("stale catalog loads cannot overwrite newer search results", async () => {
    let calls = 0
    const fx = catalog([{ path: "/eikons/index.json", body: async () => {
      calls++
      if (calls === 1) {
        await Bun.sleep(120)
        return Response.json([{ name: "ares", author: "Kaio", width: 48, height: 24, poster: "ARES-POSTER", source: "ares/", description: "red warrior" }])
      }
      return Response.json([{ name: "mono", author: "Nous", width: 48, height: 24, poster: "MONO-POSTER", source: "mono/", description: "quiet lines" }])
    } }])
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    await act(async () => { await t.keys.typeText("mono") })
    await until(t, () => t.frame().includes("MONO-IDLE"))
    await Bun.sleep(160)
    await t.settle()
    expect(t.frame()).toContain("MONO-IDLE")
    expect(t.frame()).not.toContain("ARES-IDLE")
    fx.srv.stop()
  })

  test("package metadata failures reach the action toast", async () => {
    const fx = catalog([{ path: "/eikons/ares/manifest.json", body: "metadata denied", status: 503 }])
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("ARES-IDLE"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("503"))
    expect(t.frame()).toContain("503")
    fx.srv.stop()
  })

  test("repeated Enter while sizes load starts one catalog action", async () => {
    let hits = 0
    const man = {
      kind: "eikon.package", schemaVersion: "1.0", id: "liftaris/ares", name: "ares", version: "1.0.0",
      display: { title: "Ares", author: "Kaio", description: "red warrior" },
      compatibility: { eikon: ">=1 <2" }, entrypoints: { default: "ares.eikon" },
      files: [{ path: "ares.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: body.length, digest: digest(body) }],
    }
    const fx = catalog([{ path: "/eikons/ares/manifest.json", body: async () => {
      hits++
      await Bun.sleep(120)
      return Response.json(man)
    } }])
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("ARES-IDLE"))
    act(() => { t.keys.pressEnter(); t.keys.pressEnter() })
    await until(t, () => hits === 1)
    await Bun.sleep(140)
    expect(hits).toBe(1)
    fx.srv.stop()
  })

  test("slash search filters the catalog in place", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("ARES-IDLE"))

    await act(async () => { await t.keys.typeText("/") })
    await t.settle()
    await act(async () => { await t.keys.typeText("mono") })
    await until(t, () => t.frame().includes("MONO-IDLE"))
    expect(t.frame()).not.toContain("ARES-POSTER")
    fx.srv.stop()
  })

  test("install leaves the current avatar active until a later use action", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    mkdirSync(join(HH, "eikons"), { recursive: true })
    local("localone")
    prefs.set("eikon", "localone")
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("ARES-IDLE"))

    act(() => t.keys.pressEnter())
    await until(t, () => fx.seen.includes("/eikons/ares/manifest.json"))
    await t.settle(); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => eikon.list().some(x => x.name === "ares") && prefs.get("eikon") === "localone")
    expect(eikon.list().find(x => x.name === "ares")!.hasSource).toBe(false)

    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => prefs.get("eikon") === "ares")
    fx.srv.stop()
  })

  test("runtime-only package can be installed and removed without changing the avatar", async () => {
    const fx = packageCatalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 120, height: 48 })
    await until(t, () => t.frame().includes("ARES-IDLE"))

    act(() => t.keys.pressEnter())
    await until(t, () => fx.seen.includes("/eikons/ares/manifest.json"))
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => eikon.list().some(x => x.name === "ares"))
    expect(eikon.list().find(x => x.name === "ares")!.hasSource).toBe(false)
    expect(prefs.get("eikon")).toBeUndefined()

    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.keys.pressKey("y"))
    await until(t, () => !eikon.list().some(x => x.name === "ares"))
    expect(prefs.get("eikon")).toBeUndefined()
    fx.srv.stop()
  })

  test("source-bearing installed package can download source", async () => {
    const fx = packageCatalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 40 })
    await until(t, () => t.frame().includes("MONO-IDLE") || t.frame().includes("ARES-IDLE"))
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("MONO-IDLE"))
    act(() => t.keys.pressEnter())
    await until(t, () => fx.seen.includes("/eikons/mono/manifest.json"))
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => eikon.list().some(x => x.name === "mono"))
    expect(eikon.list().find(x => x.name === "mono")!.hasSource).toBe(false)

    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressKey(" "))
    await until(t, () => eikon.list().find(x => x.name === "mono")!.hasSource)
    fx.srv.stop()
  })

  test("active package downloads source without changing active state", async () => {
    const fx = packageCatalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 40 })
    await until(t, () => t.frame().includes("ARES-IDLE"))
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("MONO-IDLE"))
    act(() => t.keys.pressEnter())
    await until(t, () => fx.seen.includes("/eikons/mono/manifest.json"))
    await t.settle(); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => eikon.list().some(x => x.name === "mono"))

    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => prefs.get("eikon") === "mono")

    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => eikon.list().find(x => x.name === "mono")!.hasSource)
    expect(eikon.list().some(x => x.name === "mono")).toBe(true)
    expect(prefs.get("eikon")).toBe("mono")
    fx.srv.stop()
  })

  test("installed package has no hidden numeric delete route", async () => {
    const fx = packageCatalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 40 })
    await until(t, () => t.frame().includes("ARES-IDLE"))
    act(() => t.keys.pressEnter())
    await until(t, () => fx.seen.includes("/eikons/ares/manifest.json"))
    await t.settle(); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => eikon.list().some(x => x.name === "ares"))

    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.keys.pressKey("2"))
    await t.settle()
    expect(eikon.list().some(x => x.name === "ares")).toBe(true)
    fx.srv.stop()
  })

  test("grid keys change preview state and install the selected package", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 180, height: 28 })
    await until(t, () => t.frame().includes("ARES-IDLE"))

    await act(async () => { await t.keys.pressKey(" ") })
    await until(t, () => t.frame().includes("ARES-THINKING"))
    expect(eikon.list().some(x => x.name === "ares")).toBe(false)

    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("MONO-IDLE"))
    act(() => t.keys.pressEnter())
    await until(t, () => fx.seen.includes("/eikons/mono/manifest.json"))
    await t.settle(); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => eikon.list().some(x => x.name === "mono"))
    expect(eikon.list().some(x => x.name === "ares")).toBe(false)
    fx.srv.stop()
  })

  test("detail preview state falls back when the next package lacks that state", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("ARES-IDLE"))

    await act(async () => { await t.keys.pressKey(" ") })
    await until(t, () => t.frame().includes("ARES-THINKING"))

    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("MONO-IDLE"))
    expect(t.frame()).not.toContain("MONO-THINKING")
    expect(prefs.get("eikon")).toBeUndefined()
    fx.srv.stop()
  })

  test("detail focus routes arrows to preview state until focus returns to grid", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("ARES-IDLE"))
    act(() => t.keys.pressTab())
    await t.settle()
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("ARES-THINKING"))
    act(() => t.keys.pressEscape())
    await t.settle()
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("MONO-IDLE"))
    fx.srv.stop()
  })

  test("detail preview is omitted on load failure", async () => {
    const fx = catalog([{ path: "/eikons/ares/ares.eikon", body: "missing", status: 500 }])
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("500"))
    expect(t.frame()).toContain("500")
    expect(t.frame()).not.toContain("ARES-IDLE")
    fx.srv.stop()
  })

  test("late preview load does not overwrite newer selection", async () => {
    let releaseAres!: (value: Response) => void
    const delayedAres = new Promise<Response>(resolve => { releaseAres = resolve })
    const fx = catalog([{ path: "/eikons/ares/ares.eikon", body: delayedAres as unknown as BodyInit }])
    const stop = fx.srv.stop.bind(fx.srv)
    fx.srv.stop()
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/eikons/ares/ares.eikon") return delayedAres
        const hit = [
          { path: "/eikons/index.json", body: [
            { name: "ares", author: "Kaio", width: 48, height: 24, poster: "ARES-POSTER", source: "ares/", description: "red warrior" },
            { name: "mono", author: "Nous", width: 48, height: 24, poster: "MONO-POSTER", source: "mono/", description: "quiet lines" },
          ] },
          { path: "/eikons/mono/mono.eikon", body: monoBody },
        ].find(r => r.path === path)
        if (!hit) return new Response("404", { status: 404 })
        if (typeof hit.body === "object" && !(hit.body instanceof Uint8Array)) return Response.json(hit.body)
        return new Response(hit.body as BodyInit)
      },
    })
    servers.add(srv)
    process.env.EIKON_URL = `http://localhost:${srv.port}/eikons`
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("ARES-POSTER") && t.frame().includes("MONO-POSTER"))
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("MONO-IDLE"))
    releaseAres(new Response(body))
    await t.settle(); await t.settle()
    expect(t.frame()).toContain("MONO-IDLE")
    expect(t.frame()).not.toContain("ARES-IDLE")
    srv.stop()
    stop()
  })

  test("narrow marketplace keeps the selected preview in the fixed detail column", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 100, height: 40 })
    await until(t, () => t.frame().includes("ARES-IDLE"))
    const line = t.frame().split("\n").find(row => row.includes("ARES-IDLE")) ?? ""
    expect(line.indexOf("ARES-IDLE")).toBeGreaterThanOrEqual(20)
    expect(t.frame()).not.toContain("ARES-POSTER")
    await act(async () => { await t.keys.pressKey(" ") })
    await until(t, () => t.frame().includes("ARES-THINKING"))
    fx.srv.stop()
  })

  test("wide shell keeps the marketplace preview in the right detail column", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mount({ width: 180, height: 48 })
    await t.settle()
    await openMarketplaceTab(t)

    const line = t.frame().split("\n").find(row => row.includes("ARES-IDLE")) ?? ""
    expect(line.indexOf("ARES-IDLE")).toBeGreaterThanOrEqual(80)
    act(() => t.keys.pressTab())
    await t.settle()
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("ARES-THINKING"))
    fx.srv.stop()
  })

  test("clicking a row installs that row without a prior hover", async () => {
    const fx = catalog()
    process.env.EIKON_URL = fx.base
    await using t = await mountNode(group(), { width: 160, height: 48 })
    await until(t, () => t.frame().includes("ARES-POSTER") && t.frame().includes("MONO-POSTER"))

    const pos = () => {
      const lines = t.frame().split("\n")
      const y = lines.findIndex(l => l.includes("mono"))
      return { x: Math.max(0, lines[y]?.indexOf("mono") ?? 0), y }
    }
    await act(async () => { const p = pos(); await t.mouse.click(p.x, p.y) })
    await until(t, () => fx.seen.includes("/eikons/mono/manifest.json"))
    act(() => t.keys.pressEnter())
    await until(t, () => eikon.list().some(x => x.name === "mono"))
    expect(eikon.list().some(x => x.name === "ares")).toBe(false)
    fx.srv.stop()
  })
})
