import { afterEach, test, expect } from "bun:test"
import { act } from "react"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mountNode, until } from "./harness"
import { EikonGallery } from "../src/tabs/EikonGallery"
import { EikonGroup } from "../src/tabs/EikonGroup"
import { EIKON_TAB, SUB_TABS, TAB_SLASH } from "../src/app/tabs"

let server: ReturnType<typeof Bun.serve> | undefined
const HH = process.env.HERMES_HOME!

const eikonBody = [
  JSON.stringify({
    type: "header", eikon: 1, id: "liftaris/ares", version: "1.0", title: "ares",
    author: { name: "Kaio" }, size: { cols: 48, rows: 24 }, defaultSignal: "state.idle",
    signals: { "state.idle": { clip: "idle" } },
  }),
  JSON.stringify({ type: "clip", name: "idle", fps: 1, frameCount: 1, loopFrom: 0 }),
  JSON.stringify({
    type: "frame", clip: "idle", index: 0,
    rows: Array.from({ length: 24 }, (_, i) => (i === 0 ? "ARES-IDLE" : "").padEnd(48)),
  }),
].join("\n") + "\n"

function useCatalog() {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/eikons/index.json") return Response.json([
        { name: "ares", author: "Kaio", width: 48, height: 24, poster: "ARES-POSTER", source: "ares/", description: "red warrior" },
      ])
      if (path === "/eikons/ares/ares.eikon") return new Response(eikonBody)
      return new Response("404", { status: 404 })
    },
  })
  process.env.EIKON_URL = `http://localhost:${server.port}/eikons`
}

afterEach(() => {
  delete process.env.EIKON_URL
  server?.stop()
  server = undefined
  rmSync(join(HH, "eikons"), { recursive: true, force: true })
})

test("Eikon sub-tabs put Studio after Library and Catalog and preserve slash routes", () => {
  expect(SUB_TABS[EIKON_TAB]).toEqual(["Library", "Catalog", "Studio", "Import"])
  expect(TAB_SLASH.library).toEqual({ tab: EIKON_TAB, sub: 0 })
  expect(TAB_SLASH.catalog).toEqual({ tab: EIKON_TAB, sub: 1 })
  expect(TAB_SLASH.studio).toEqual({ tab: EIKON_TAB, sub: 2 })
  expect(TAB_SLASH.import).toEqual({ tab: EIKON_TAB, sub: 3 })
  expect(Object.keys(TAB_SLASH).filter(k => ["gallery", "marketplace"].includes(k))).toEqual([])
})

test("Library no longer embeds a Catalog header action", async () => {
  await using t = await mountNode(<EikonGallery focused />, { width: 160, height: 48 })
  await until(t, () => t.frame().includes("Library ("))
  expect(t.frame()).not.toContain("[ Catalog ]")
  expect(t.frame()).not.toContain("Catalog (")
})

test("Catalog renders as its own Eikon sub-tab", async () => {
  useCatalog()
  let sub = 1
  await using t = await mountNode(<EikonGroup focused sub={sub} setSub={i => { sub = i }} />, { width: 160, height: 48 })
  await until(t, () => t.frame().includes("Catalog (1)") && t.frame().includes("ARES-IDLE"))
  expect(t.frame()).toContain("Details — ares")
})

test("Library title remains readable without catalog action at narrow widths", async () => {
  await using t = await mountNode(<EikonGallery focused />, { width: 80, height: 32 })
  await until(t, () => t.frame().includes("Library ("))
  const row = t.frame().split("\n").find(l => l.includes("Library (")) ?? ""
  expect(row).toContain("Library (")
  expect(row).not.toContain("Catalog")
})

test("Library grid hides only below one card of available width", async () => {
  await using shown = await mountNode(<EikonGallery focused />, { width: 124, height: 36 })
  await until(shown, () => shown.frame().includes("Library (") && shown.frame().includes("Grid"))

  await using hidden = await mountNode(<EikonGallery focused />, { width: 123, height: 36 })
  await until(hidden, () => hidden.frame().includes("Library (") && hidden.frame().includes("Preview"))
  expect(hidden.frame()).not.toContain("Grid")
})

test("Library prefers folder-form duplicate over flat legacy row", async () => {
  mkdirSync(join(HH, "eikons", "dup"), { recursive: true })
  writeFileSync(join(HH, "eikons", "dup.eikon"), eikonBody.replaceAll("ares", "dup"))
  writeFileSync(join(HH, "eikons", "dup", "dup.eikon"), eikonBody.replaceAll("ares", "dup"))

  await using t = await mountNode(<EikonGallery focused />, { width: 160, height: 48 })
  await until(t, () => t.frame().includes("Library (") && t.frame().includes("dup"))
  const rows = t.frame().split("\n").filter(l => /^│\s*(?:▸\s*)?(?:●\s*)?dup\s+│/i.test(l))
  expect(rows).toHaveLength(1)
})

test("Library action pane names management actions", async () => {
  await using t = await mountNode(<EikonGallery focused />, { width: 180, height: 48 })
  await until(t, () => t.frame().includes("Library (") && t.frame().includes("Actions"))
  expect(t.frame()).toContain("Use as active avatar")
  act(() => t.keys.pressTab())
  await until(t, () => t.frame().includes("[Tab] library"))
})

test("Library active action label refreshes after bundled activation", async () => {
  await using t = await mountNode(<EikonGallery focused />, { width: 180, height: 48 })
  await until(t, () => t.frame().includes("Library (") && t.frame().includes("Use as active avatar"))
  act(() => t.keys.pressEnter())
  await until(t, () => t.frame().includes("Use as active avatar (active)"))
})

test("Library delete removes flat legacy eikon files", async () => {
  mkdirSync(join(HH, "eikons"), { recursive: true })
  const old = join(HH, "eikons", "liftaris.eikon")
  writeFileSync(old, eikonBody.replaceAll("ares", "liftaris"))

  await using t = await mountNode(<EikonGallery focused />, { width: 160, height: 48 })
  await until(t, () => t.frame().includes("liftaris"))
  for (let i = 0; i < 20; i++) {
    if (t.frame().split("\n").some(l => l.includes("▸") && l.includes("liftaris"))) break
    act(() => t.keys.pressArrow("down"))
    await t.settle()
  }
  act(() => t.keys.pressKey("d"))
  await until(t, () => t.frame().includes("Delete 'liftaris'?"))
  expect(t.frame()).toContain("Removes legacy flat file liftaris.eikon.")
  expect(t.frame()).not.toContain(`${HH}/eikons and all its sources`)
  act(() => t.keys.pressEnter())
  await until(t, () => !existsSync(old))
})
