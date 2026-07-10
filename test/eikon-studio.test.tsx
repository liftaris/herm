import { describe, expect, test } from "bun:test"
import { act, useState } from "react"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { mountNode, until } from "./harness"
import { EikonGroup } from "../src/tabs/EikonGroup"
import { EikonGallery } from "../src/tabs/EikonGallery"
import { EikonStudio, resetToolsetsCache } from "../src/tabs/EikonStudio"
import { gen } from "../src/service/eikon-gen"
import { eikon } from "../src/service/eikon"
import { native, caps, type Rasterizer } from "../src/utils/eikon-render"
import * as prefs from "../src/context/preferences"

const HH = process.env.HERMES_HOME!
const PX = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,0,0,0,0,58,126,155,85,0,0,0,10,73,68,65,84,120,156,99,104,0,0,0,130,0,129,119,205,114,182,0,0,0,0,73,69,78,68,174,66,96,130])
const STREAM = [
  JSON.stringify({ type: "header", eikon: 1, size: { cols: 4, rows: 2 }, defaultSignal: "state.idle", signals: { "state.idle": { clip: "idle" } } }),
  JSON.stringify({ type: "clip", name: "idle", fps: 12, frameCount: 1 }),
  JSON.stringify({ type: "frame", clip: "idle", index: 0, rows: ["abcd", "efgh"] }),
].join("\n") + "\n"
const digest = (data: string | Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`
const run = caps.ffmpeg ? test : test.skip

// Stub rasterizer — deterministic, no binaries.
const stub: Rasterizer = {
  name: "stub",
  knobs: {
    tone: { kind: "cycle", options: ["lo", "hi"], default: "lo" },
    flip: { kind: "toggle", default: false },
    gain: { kind: "slider", min: 0, max: 10, step: 1, default: 5 },
  },
  available: () => true,
  render: async () => ({ frames: [Array.from({ length: 24 }, () => "STUB-ROW".padEnd(48))] }),
}

function seed(name: string, opts: { published?: boolean } = {}) {
  const p = eikon.ensure(name)
  writeFileSync(join(p.source, "base.png"), PX)
  const head = { eikon: 1, name, width: 48, height: 24, ...(opts.published ? { source_url: "https://catalog.example/eikons/" + name } : {}) }
  writeFileSync(eikon.file(name), JSON.stringify(head) + "\n")
  eikon.writeStudio(name, { rasterizer: "stub", spatial: { zoom: 1, ox: 0.5, oy: 0.5 }, tone: { contrast: 1, invert: true, flip: "none" }, fps: 16, base: {}, per: {}, glyph: "◆", sources: { base: "base.png" } })
  if (opts.published) writeFileSync(join(p.dir, "manifest.json"), JSON.stringify({ name, source: "source/base.png", origin: { source: "https://catalog.example/eikons/" + name, at: "2026-05-31T00:00:00Z" } }, null, 2) + "\n")
}

describe("EikonStudio tab", () => {
  run("published marketplace installs cannot submit from Studio", async () => {
    const un = eikon.register(stub)
    seed("pub", { published: true })
    prefs.set("eikon", "pub")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    act(() => t.keys.pressKey("u"))
    await until(t, () => t.frame().includes("Create a local draft before submitting"))
    expect(t.frame()).not.toContain("Submit eikon")
    un()
  })

  run("u key release does not submit from Studio", async () => {
    const un = eikon.register(stub)
    seed("pub", { published: true })
    prefs.set("eikon", "pub")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    act(() => t.renderer.keyInput.processParsedKey({
      name: "u", ctrl: false, meta: false, shift: false, option: false,
      sequence: "u", number: false, raw: "u", eventType: "release", source: "raw",
    }))
    await t.settle()
    expect(t.frame()).not.toContain("Create a local draft before submitting")
    expect(t.frame()).not.toContain("Submit eikon")
    un()
  })

  test("runtime-only package installs expose Studio fetch from manifest origin", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path.endsWith("manifest.json")) return Response.json({
          kind: "eikon.package",
          schemaVersion: "1.0",
          id: "liftaris/bare",
          name: "bare",
          version: "1.0.0",
          compatibility: { eikon: ">=1 <2" },
          entrypoints: { default: "bare.eikon" },
          files: [
            { path: "bare.eikon", role: "runtime", mediaType: "application/vnd.eikon.stream+jsonl", size: STREAM.length, digest: digest(STREAM) },
            { path: "source.png", role: "source.base", mediaType: "image/png", size: PX.length, digest: digest(PX) },
          ],
          source: { base: "source.png" },
        })
        if (path.endsWith("bare.eikon")) return new Response(STREAM)
        if (path.endsWith("source.png")) return new Response(PX)
        return new Response("404", { status: 404 })
      },
    })
    await eikon.fetchSource(`http://localhost:${srv.port}/pkg/manifest.json`, { media: false })
    prefs.set("eikon", "bare")

    await using t = await mountNode(<EikonStudio focused />, { width: 160, height: 48 })

    await until(t, () => t.frame().includes("Download source") && t.frame().includes("1 files"))
    srv.stop()
  })

  run("renders three panes; knob nav via handleListKey; ←→ adjusts cycle knob", async () => {
    const un = eikon.register(stub)
    seed("owl")
    prefs.set("eikon", "owl")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 60 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    expect(t.frame()).toContain("Preview")
    expect(t.frame()).toContain("States")
    // Preview frame arrives after async decode+rasterize.
    await until(t, () => t.frame().includes("STUB-ROW"))

    // Source row shows basename · dims · size.
    expect(t.frame()).toMatch(/base\.png · 1×1 · \d+\s*B/)
    // knobs-for cycle row.
    expect(t.frame()).toContain("tune")
    expect(t.frame()).toContain("◂ all states ▸")
    expect(t.frame()).not.toContain("fork state")
    // Strip labels carry no glyphs.
    expect(t.frame()).not.toContain("📎")
    // Knobs hint uses "edit", not "open".
    expect(t.frame()).toContain("[Enter] edit")

    // Nav to first rasterizer knob (stub's 'tone') — HEAD has 8 nav
    // rows when not dirty (open, rasterizer, source, knobsfor, reset,
    // contrast, invert, flip), so stub.tone is at index 8.
    for (let i = 0; i < 8; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    await until(t, () => /▸ tone/.test(t.frame()))
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("◂ hi ▸"))
    expect(t.frame()).toContain("● unsaved")

    // Tab cycles pane focus → hint line swaps per pane.
    act(() => t.keys.pressTab())
    await until(t, () => t.frame().includes("[wheel]"))
    act(() => t.keys.pressTab())
    await until(t, () => t.frame().includes("state") && t.frame().includes("actions"))
    un()
  })

  run("tune: ←→ forks current state and toggles back", async () => {
    const un = eikon.register(stub)
    seed("knb")
    prefs.set("eikon", "knb")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 60 },
    )
    await until(t, () => t.frame().includes("tune"))
    expect(t.frame()).toContain("◂ all states ▸")
    // Land on knobs-for row (open=0, rasterizer=1, source=2, knobsfor=3).
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    await until(t, () => /▸ tune/.test(t.frame()))
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("◂ idle only ▸"))
    expect(t.frame()).toContain("● unsaved")
    // Strip label for idle reads "forked" once per[idle] is set.
    expect(t.frame()).toContain("forked")
    // Toggle back.
    act(() => t.keys.pressArrow("left"))
    await until(t, () => t.frame().includes("◂ all states ▸"))
    un()
  })


  run("Enter on rasterizer row opens DialogSelect; unavailable shows reason", async () => {
    const un = eikon.register(stub)
    seed("cat")
    prefs.set("eikon", "cat")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    // Selection starts on row 0 (eikon picker). Move down once to land on
    // the rasterizer row, then Enter → dialog.
    act(() => t.keys.pressArrow("down")); await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Rasterizer") && t.frame().includes("● stub"))
    // chafa + native also listed; one may show an install hint.
    expect(t.frame()).toContain("chafa")
    expect(t.frame()).toContain("native")
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("● stub") || t.frame().includes("Settings"))
    un()
  })

  run("Enter on eikon row opens picker with seeded eikon + New…; New creates and opens", async () => {
    const un = eikon.register(stub)
    seed("alpha")
    prefs.set("eikon", "alpha")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    // Row 0 = eikon picker. Enter opens it; "alpha" appears as the
    // current selection. The trailers (+ New, + Install) may be below
    // the viewport in a populated sandbox, so filter down to "new" to
    // bring + New into view, then Enter selects it.
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Open eikon"))
    expect(t.frame()).toContain("alpha")
    await act(async () => { await t.keys.typeText("new") })
    await until(t, () => t.frame().includes("+ New"))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("New eikon"))
    // Type a fresh name; default `from` is blank, so Enter resolves.
    await act(async () => { await t.keys.typeText("beta") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("beta ▸"))
    un()
  })

  run("dirty Esc → three-way save/discard; [d] reloads from disk", async () => {
    const un = eikon.register(stub)
    seed("dog")
    prefs.set("eikon", "dog")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
    )
    await until(t, () => t.frame().includes("rasterizer"))
    // Make dirty via a knob adjust.
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("● unsaved"))
    act(() => t.keys.pressEscape())
    await until(t, () => t.frame().includes("Unsaved edits") && t.frame().includes("[D] discard"))
    act(() => t.keys.pressKey("d"))
    await until(t, () => !t.frame().includes("● unsaved"))
    un()
  })

  run("dirty Esc → [s] saves and drops dirty", async () => {
    const un = eikon.register(stub)
    seed("cow")
    prefs.set("eikon", "cow")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
    )
    await until(t, () => t.frame().includes("rasterizer"))
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("● unsaved"))
    act(() => t.keys.pressEscape())
    await until(t, () => t.frame().includes("Unsaved edits"))
    act(() => t.keys.pressKey("s"))
    await until(t, () => t.frame().includes("Saved →"))
    await until(t, () => !t.frame().includes("● unsaved"))
    un()
  })

  run("dirty Esc → failed [s] save keeps dirty edits", async () => {
    const bad: Rasterizer = { ...stub, name: "bad", render: async () => ({ err: "save failed" }) }
    const un = eikon.register(bad)
    seed("badsave")
    eikon.writeStudio("badsave", { ...eikon.readStudio("badsave")!, rasterizer: "bad" })
    prefs.set("eikon", "badsave")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
    )
    await until(t, () => t.frame().includes("rasterizer"))
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("● unsaved"))
    act(() => t.keys.pressEscape())
    await until(t, () => t.frame().includes("Unsaved edits"))
    act(() => t.keys.pressKey("s"))
    await until(t, () => t.frame().includes("save failed"))

    expect(t.frame()).toContain("● unsaved")
    expect(t.frame()).not.toContain("Saved →")
    un()
  })

  run("dirty submit prompts save and active consequence before preview", async () => {
    const un = eikon.register(stub)
    seed("submitdirty")
    prefs.set("eikon", "submitdirty")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("● unsaved"))
    act(() => t.keys.pressKey("u"))
    await until(t, () => t.frame().includes("Save before submit?"))
    act(() => t.keys.pressKey("s"))
    await until(t, () => t.frame().includes("Save active 'submitdirty' before submit?"))
    expect(t.frame()).toContain("Submit itself will not change active selection")
    un()
  })

  run("Ctrl+S saves without activation; Ctrl+U explicitly saves and uses", async () => {
    const un = eikon.register(stub)
    seed("active")
    seed("draft")
    prefs.set("eikon", "active")
    await using t = await mountNode(
      <EikonStudio focused name="draft" />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("● unsaved"))
    act(() => t.keys.pressKey("s", { ctrl: true }))
    await until(t, () => !t.frame().includes("● unsaved"))
    expect(prefs.get("eikon")).toBe("active")
    act(() => t.keys.pressKey("u", { ctrl: true }))
    await until(t, () => prefs.get("eikon") === "draft")
    un()
  })

  run("revert row appears when dirty and routes through three-way", async () => {
    const un = eikon.register(stub)
    seed("fox")
    prefs.set("eikon", "fox")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
    )
    await until(t, () => t.frame().includes("rasterizer"))
    expect(t.frame()).not.toContain("revert")
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("revert"))
    expect(t.frame()).toContain("▸ reload from disk")
    un()
  })

    run("cold start: Enter opens New eikon; submitting seeds a session", async () => {
    const un = eikon.register(stub)
    prefs.set("eikonRasterizer", "stub")
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("No eikon open"))
    expect(t.frame()).toContain("[Enter] new eikon")
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("New eikon"))
    await act(async () => { await t.keys.typeText("cold") })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("rasterizer"))
    expect(t.frame()).toContain("cold ▸")
    un()
  })

  run("dirty session survives name prop change until confirm", async () => {
    const un = eikon.register(stub)
    seed("alpha")
    seed("beta")
    prefs.set("eikon", "alpha")
    let set: ((n: string) => void) | undefined
    function Wrap() {
      const [n, sn] = useState<string | undefined>(undefined)
      set = sn
      return <EikonStudio focused name={n} />
    }
    await using t = await mountNode(<Wrap />, { width: 160, height: 48 })
    await until(t, () => t.frame().includes("rasterizer"))
    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("● unsaved"))
    act(() => set!("beta"))
    await until(t, () => t.frame().includes("Discard unsaved"))
    expect(t.frame()).toContain("● unsaved")
    act(() => t.keys.pressEscape())
    await until(t, () => !t.frame().includes("Discard unsaved"))
    expect(t.frame()).toContain("● unsaved")
    act(() => set!("beta-x"))
    act(() => set!("beta"))
    await until(t, () => t.frame().includes("Discard unsaved"))
    act(() => t.keys.pressKey("y"))
    await until(t, () => !t.frame().includes("● unsaved"))
    un()
  })

  run("reload refreshes clean source metadata and preserves dirty drafts", async () => {
    const un = eikon.register(stub)
    seed("refresh")
    prefs.set("eikon", "refresh")
    await using t = await mountNode(<EikonGroup focused sub={2} setSub={() => {}} />, { width: 160, height: 48 })
    await until(t, () => t.frame().includes("base.png · 1×1 · 67 B"))

    writeFileSync(join(eikon.sourceDir("refresh"), "base.png"), new Uint8Array([...PX, 0]))
    act(() => t.keys.pressKey("r"))
    await until(t, () => t.frame().includes("base.png · 1×1 · 68 B"))

    for (let i = 0; i < 5; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressArrow("right"))
    await until(t, () => t.frame().includes("● unsaved"))
    writeFileSync(join(eikon.sourceDir("refresh"), "base.png"), new Uint8Array([...PX, 0, 0]))
    act(() => t.keys.pressKey("r"))
    await until(t, () => t.frame().includes("● unsaved") && t.frame().includes("Reload skipped"))
    un()
  })

  run("download source action fetches published media without local path entry", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname.endsWith("manifest.json")
          ? Response.json({
            kind: "eikon.package",
            schemaVersion: "1.0",
            id: "liftaris/remote",
            name: "remote",
            version: "1.0.0",
            compatibility: { eikon: ">=1 <2" },
            entrypoints: { default: "remote.eikon" },
            source: { base: "base.png" },
          })
          : new Response(PX)
      },
    })
    const un = eikon.register(stub)
    eikon.ensure("remote")
    writeFileSync(eikon.file("remote"), JSON.stringify({ eikon: 1, name: "remote", width: 48, height: 24, source_url: `http://localhost:${srv.port}/remote/` }) + "\n")
    eikon.writeStudio("remote", { rasterizer: "stub", spatial: { zoom: 1, ox: 0.5, oy: 0.5 }, tone: { contrast: 1, invert: true, flip: "none" }, fps: 16, base: {}, per: {}, glyph: "◆", sources: {} })
    prefs.set("eikon", "remote")
    await using t = await mountNode(<EikonGroup focused sub={2} setSub={() => {}} />, { width: 160, height: 48 })
    await until(t, () => t.frame().includes("Download source"))

    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    act(() => t.keys.pressEnter())
    await until(t, () => Bun.file(join(eikon.sourceDir("remote"), "base.png")).size > 0)
    expect(eikon.readStudio("remote")!.sources.base).toBe("base.png")
    srv.stop()
    un()
  })

  run("Enter on source row → menu with Local file…; pick + path + Enter adopts source", async () => {
    const un = eikon.register(stub)
    seed("fox")
    prefs.set("eikon", "fox")
    // Pre-create a file we can adopt.
    const extPath = join(HH, "extra.png")
    writeFileSync(extPath, PX)
    resetToolsetsCache()
    gen.setProbe(async () => ({ image: false, video: false }))
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))

    // Nav from eikon (0) → rasterizer (1) → source (2).
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressArrow("down"))
    await until(t, () => /▸ source/.test(t.frame()))

    // Enter → source-actions menu.
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Local file"))
    expect(t.frame()).toContain("Source for 'idle'")

    // Pick fallback "Local file…" after the detected base source.
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Tab complete"))

    // Type the path + Enter.
    await act(async () => { await t.keys.typeText(extPath) })
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("● unsaved"))

    // Adopted file landed in the eikon's source dir as <role>.png.
    const adoptedDir = eikon.ensure("fox").source
    const f = Bun.file(join(adoptedDir, "idle.png"))
    expect(await f.exists()).toBe(true)
    gen.setProbe(null)
    un()
  })

  run("Generate image… row appears when backend available; submit adopts + persists prompt", async () => {
    const un = eikon.register(stub)
    seed("owlgen")
    prefs.set("eikon", "owlgen")
    // Pre-stage the path the mock gen will return.
    const genPath = join(HH, "generated.png")
    writeFileSync(genPath, PX)
    resetToolsetsCache()
    gen.setProbe(async () => ({ image: true, video: false }))
    let got: { kind: string; prompt: string } | undefined
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    gen.setImpl(async (kind, prompt) => {
      calls++
      got = { kind, prompt }
      await gate
      return { path: genPath }
    })
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 60 },
    )
    await until(t, () => t.frame().includes("rasterizer"))

    // Nav to source row (open=0, rasterizer=1, source=2) → open menu.
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressArrow("down"))
    await until(t, () => /▸ source/.test(t.frame()))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Local file"))
    expect(t.frame()).toContain("Generate image")
    // video_gen not enabled → row hidden.
    expect(t.frame()).not.toContain("Generate video")

    // Move to "Generate image…" (row 2 — Local file is 0, Generate image is 1).
    act(() => t.keys.pressArrow("down"))
    await t.settle()
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Generate image"))
    // Prompt textarea is pre-filled with style hints on line 2+ and
    // the cursor is parked at (0,0). Type the subject on line 1.
    await act(async () => { await t.keys.typeText("a wise owl") })
    // Enter on the textarea advances to the next field (BINDS maps
    // return→submit); the form is prompt → seed → submit since
    // base.png is auto-detected. Enter×3 walks through and fires.
    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => t.keys.pressEnter())
    await t.settle()
    act(() => { t.keys.pressEnter(); t.keys.pressEnter() })
    await until(t, () => calls > 0)
    expect(calls).toBe(1)
    release()
    // Adoption lands in source/idle.png (st='idle' and base exists so role='idle').
    await until(t, () => {
      const f = Bun.file(join(eikon.ensure("owlgen").source, "idle.png"))
      return f.size > 0
    })
    expect(t.frame()).toContain("● unsaved")
    // Gen fn was called with subject + the pre-filled style hints.
    expect(got?.kind).toBe("image")
    expect(got?.prompt).toMatch(/^a wise owl\nhigh contrast, light subject on dark, black background$/)
    gen.setImpl(null); gen.setProbe(null)
    un()
  })

  run("Generate rows hidden when no gen backend configured", async () => {
    const un = eikon.register(stub)
    seed("nogen")
    prefs.set("eikon", "nogen")
    resetToolsetsCache()
    gen.setProbe(async () => ({ image: false, video: false }))
    let sub = 2
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    act(() => t.keys.pressArrow("down"))
    act(() => t.keys.pressArrow("down"))
    await until(t, () => /▸ source/.test(t.frame()))
    act(() => t.keys.pressEnter())
    await until(t, () => t.frame().includes("Local file"))
    expect(t.frame()).not.toContain("Generate image")
    expect(t.frame()).not.toContain("Generate video")
    gen.setProbe(null)
    un()
  })

  run("Settings help footer follows selection", async () => {
    const un = eikon.register(stub)
    seed("helpt")
    prefs.set("eikon", "helpt")
    await using t = await mountNode(
      <EikonGroup focused sub={2} setSub={() => {}} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("rasterizer"))
    // Pane is titled Settings now.
    expect(t.frame()).toContain("Settings — helpt")
    // Row 0 (eikon) → open help.
    expect(t.frame()).toContain("Which eikon you're editing")
    // ↓ to rasterizer.
    act(() => t.keys.pressArrow("down")); await t.settle()
    expect(t.frame()).toContain("engine that turns your source")
    // ↓ to source.
    act(() => t.keys.pressArrow("down")); await t.settle()
    expect(t.frame()).toContain("Pick, generate, or clear source")
    // ↓↓↓ → contrast (studio-owned tone row, has a KnobDef.hint).
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    expect(t.frame()).toContain("Spread pixel values around their mean")
    // ↓↓↓ past invert/flip → first rasterizer knob (stub's 'tone' has
    // no declared hint, so the generic cycle text renders).
    for (let i = 0; i < 3; i++) { act(() => t.keys.pressArrow("down")); await t.settle() }
    expect(t.frame()).toMatch(/←→ or Enter cycles: lo · hi/)
    un()
  })

  run("preview wheel: stops scrollbox propagation; ctrl=zoom, shift=pan-x, bare=pan-y", async () => {
    const un = eikon.register(stub)
    seed("wheelt")
    // Start at zoom 0.5 so pan has room and the vbar thumb is ~half.
    eikon.writeStudio("wheelt", { rasterizer: "stub", spatial: { zoom: 0.5, ox: 0.5, oy: 0.5 }, tone: { contrast: 1, invert: true, flip: "none" }, fps: 16, base: {}, per: {}, glyph: "◆", sources: { base: "base.png" } })
    prefs.set("eikon", "wheelt")
    await using t = await mountNode(
      <EikonGroup focused sub={2} setSub={() => {}} />,
      { width: 180, height: 30 },  // short → outer scrollbox is scrollable
    )
    await until(t, () => t.frame().includes("STUB-ROW"))
    const lines = () => t.frame().split("\n")
    // A cell inside the preview body.
    const y = lines().findIndex(l => l.includes("STUB-ROW"))
    const x = lines()[y]!.indexOf("STUB-ROW") + 2
    const top0 = lines()[0]
    // pan-y vbar = rows where the body line ends in ██ flank.
    const vrows = () => lines().filter(l => /STUB-ROW.*██/.test(l))
    const vtop = () => lines().findIndex(l => /STUB-ROW.*██/.test(l))
    const v0 = vtop(), vlen0 = vrows().length
    expect(vlen0).toBeGreaterThan(2)
    // Bare wheel down → pan-y: thumb moves down, outer viewport doesn't.
    for (let i = 0; i < 3; i++) {
      await act(async () => { await t.mouse.scroll(x, y, "down") }); await t.settle()
    }
    expect(vtop()).toBeGreaterThan(v0)
    expect(lines()[0]).toBe(top0)
    // Ctrl+wheel → zoom (vbar thumb length changes); outer unchanged.
    for (let i = 0; i < 3; i++) {
      await act(async () => { await t.mouse.scroll(x, y, "up", { modifiers: { ctrl: true } }) }); await t.settle()
    }
    expect(vrows().length).not.toBe(vlen0)
    expect(lines()[0]).toBe(top0)
    // Shift+wheel → pan-x is asserted via the sidebar pan-x hbar
    // in the full layout test; at height=30 it's clipped, so just
    // confirm dirty flipped and the outer viewport still hasn't moved.
    await act(async () => { await t.mouse.scroll(x, y, "down", { modifiers: { shift: true } }) }); await t.settle()
    expect(t.frame()).toContain("● unsaved")
    expect(lines()[0]).toBe(top0)
    un()
  })
})

describe("EikonGallery tab", () => {
  test("shows installed Nous once when it shadows bundled Nous", async () => {
    mkdirSync(join(HH, "eikons"), { recursive: true })
    seed("nous")
    prefs.set("eikon", "nous")
    await using t = await mountNode(<EikonGallery focused />, { width: 160, height: 48 })
    await until(t, () => t.frame().includes("Library (") && /●\s+nous/.test(t.frame()))
    const rows = t.frame().split("\n").filter(l => /^│\s*(?:▸\s*)?(?:●\s*)?nous\s+│/i.test(l))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/●\s+nous/i)
  })

  test("lists bundled + installed; Enter sets active eikon", async () => {
    mkdirSync(join(HH, "eikons"), { recursive: true })
    seed("galone")
    let sub = 0
    await using t = await mountNode(
      <EikonGroup focused sub={sub} setSub={i => { sub = i }} />,
      { width: 160, height: 48 },
    )
    await until(t, () => t.frame().includes("Library ("))
    expect(t.frame()).toContain("galone")
    // Bundled Nous also shows when no installed eikon shadows it.
    // Move to galone and activate.
    const rows = t.frame()
    const target = rows.split("\n").findIndex(l => l.includes("galone"))
    expect(target).toBeGreaterThan(0)
    // Navigate until selected row contains galone.
    for (let i = 0; i < 20; i++) {
      if (t.frame().split("\n").some(l => l.includes("▸") && l.includes("galone"))) break
      act(() => t.keys.pressArrow("down"))
      await t.settle()
    }
    act(() => t.keys.pressEnter())
    await until(t, () => prefs.get("eikon") === "galone")
  })
})

void native
