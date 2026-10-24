import { expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import * as readers from "../src/service/hermes-home"
import { HomeStore } from "../src/home/store"
import { skins } from "../src/context/skin"
import { prime } from "../src/theme/load"
import { eikon } from "../src/service/eikon"
import { publishedInfo, defaults } from "../src/service/eikon-submit"
import * as market from "../src/service/eikon-marketplace"
import { plugins } from "../src/service/bundled-plugins"
import { patchAt, resetWrites } from "../src/service/kanban-write"
import { boardStateOf, detailOf, listBoards, resetKanban } from "../src/service/hermes-kanban"
import { schema } from "./fixture/kanban"
import { tmpHome } from "./fixture/home"

const optional = [
  { path: "config.yaml", read: () => readers.readConfig(), empty: null },
  { path: "SOUL.md", read: () => readers.readSoul(), empty: null },
  { path: "memories/MEMORY.md", read: () => readers.readMemoryFile("MEMORY.md", 2200), empty: null },
  { path: ".env", read: () => readers.readEnvFile(), empty: {} },
  { path: "skills/.usage.json", read: () => readers.readSkillUsage(), empty: {} },
  { path: "skills/.curator_state", read: () => readers.readCuratorState(), empty: null },
  { path: "sessions/sessions.json", read: () => readers.readLiveSessions(), empty: {} },
  { path: "sessions", read: () => readers.readToolsFromLatestSession(), empty: null },
  { path: "logs/curator", read: () => readers.readLatestCuratorReport(), empty: null },
  { path: "logs/curator", read: () => readers.listCuratorRuns(), empty: [] },
  { path: "logs/curator", read: () => readers.indexCuratorLineage(), empty: new Map() },
  { path: "logs/curator/run/REPORT.md", read: () => readers.readCuratorReport("run"), empty: "" },
  { path: "cron/output/job", read: () => readers.readCronOutput("job"), empty: null },
]

for (const entry of optional) {
  test(`${entry.path} permits optional absence without masking read errors`, async () => {
    await using h = await tmpHome()
    expect(await entry.read()).toEqual(entry.empty)
    if (["skills/.usage.json", "skills/.curator_state", "sessions/sessions.json"].includes(entry.path)) return
    const path = join(h.path, entry.path)
    if (["sessions", "logs/curator", "cron/output/job"].includes(entry.path)) {
      h.write(entry.path, "not a directory")
      await expect(Promise.resolve().then<unknown>(() => entry.read())).rejects.toThrow(/ENOTDIR/)
      return
    }
    mkdirSync(path, { recursive: true })
    await expect(Promise.resolve().then<unknown>(() => entry.read())).rejects.toThrow("Directories cannot be read like files")
  })
}

for (const path of ["skills/.usage.json", "skills/.curator_state", "sessions/sessions.json"]) {
  test(`${path} reports a partial JSON write rather than losing state`, async () => {
    await using h = await tmpHome({ files: { [path]: "{" } })
    const entry = optional.find(e => e.path === path)!
    await expect(Promise.resolve().then<unknown>(() => entry.read())).rejects.toThrow(SyntaxError)
  })
}

test("curator run metadata and provider configuration report corrupt JSON", async () => {
  await using h = await tmpHome({
    files: {
      "logs/curator/20261023-120000/run.json": "{",
      "hermes-agent/plugins/memory/mem0/__init__.py": "",
      "mem0.json": "{",
    },
  })
  expect(() => readers.listCuratorRuns()).toThrow(SyntaxError)
  expect(() => readers.indexCuratorLineage()).toThrow(SyntaxError)
  await expect(readers.readMemoryProviders("mem0")).rejects.toThrow(SyntaxError)
})

test("invalid skill and skin YAML remains visible", async () => {
  await using h = await tmpHome({ files: { "skills/bad/SKILL.md": "---\ndescription: [\n---\n", "skins/bad.yaml": "name: [" } })
  expect(() => readers.readSkillFrontmatter(readers.makeSource("skills/bad/SKILL.md"))).toThrow("Flow sequence")
  expect(() => skins()).toThrow("Flow sequence")
})

test("environment mutations do not overwrite an unreadable env file", async () => {
  await using h = await tmpHome({ dirs: [".env"] })
  await expect(readers.writeEnvVar("NAME", "value")).rejects.toThrow("Directories cannot be read like files")
  await expect(readers.removeEnvVar("NAME")).rejects.toThrow("Directories cannot be read like files")
  rmSync(join(h.path, ".env"), { recursive: true })
  await readers.removeEnvVar("NAME")
  await readers.writeEnvVar("NAME", "value")
  expect(await readers.readEnvFile()).toEqual({ NAME: "value" })
})

test("a watcher registration failure rejects the home read with its raw error", async () => {
  await using h = await tmpHome({ config: {} })
  const error = new Error("watch ENOSPC: inotify limit reached")
  const store = new HomeStore(() => { throw error })
  try { await expect(store.ensure("config")).rejects.toBe(error) }
  finally { store.close() }
})

test("system-prompt query failures no longer turn into unknown context", async () => {
  await using h = await tmpHome({ files: { "state.db": "not a database" } })
  await expect(new HomeStore().ensure("systemPrompt")).rejects.toThrow("not a database")
})

test("theme preload reports the unknown theme name", async () => {
  await expect(prime("missing-theme-raw-error")).rejects.toThrow("Unknown theme: missing-theme-raw-error")
})

test("eikon studio normalization and publication metadata retain parse failures", async () => {
  await using h = await tmpHome()
  eikon.ensure("broken")
  writeFileSync(eikon.file("broken"), "{}\n")
  writeFileSync(join(eikon.dir("broken"), "studio.json"), "{")
  expect(() => eikon.list()).toThrow(SyntaxError)
  rmSync(join(eikon.dir("broken"), "studio.json"))
  writeFileSync(join(eikon.dir("broken"), "manifest.json"), "{")
  expect(() => publishedInfo(eikon.file("broken"))).toThrow(SyntaxError)
  const state = await market.load({ catalog: join(h.path, "missing-catalog") })
  expect(state.status).toBe("error")
  expect(state.error).toBeTruthy()
  await expect(defaults({ path: join(h.path, "missing.eikon") })).rejects.toThrow()
})

test("plugin installation reports the filesystem failure instead of partial success", async () => {
  await using h = await tmpHome({ files: { plugins: "not a directory" } })
  expect(() => plugins.sync()).toThrow(/EEXIST|ENOTDIR/)
})

test("board writes report invalid databases but an absent board remains empty", async () => {
  await using h = await tmpHome()
  try {
    expect(patchAt(h.path, "default", "missing", { title: "new" })).toBe(false)
    h.write("kanban.db", "not a database")
    expect(() => patchAt(h.path, "default", "missing", { title: "new" })).toThrow("not a database")
  } finally { resetWrites() }
})

test("missing system-prompt storage is quiet but corrupt storage is not", async () => {
  await using h = await tmpHome()
  expect(readers.readSystemPromptInfo()).toBeNull()
  h.write("state.db", "not a database")
  expect(() => readers.readSystemPromptInfo()).toThrow("not a database")
})

test("malformed packages cannot masquerade as clean eikons with no source entries", async () => {
  await using h = await tmpHome()
  eikon.ensure("broken")
  h.write("eikons/broken/studio.json", '{"sources":{"base":"base.png"}}')
  h.write("eikons/broken/manifest.json", '{"kind":"eikon.package"}')
  expect(() => eikon.readStudio("broken")).toThrow("schemaVersion: must be 1.0")
  h.write("eikons/broken/manifest.json", '{"origin":{"at":"2999-01-01T00:00:00Z"}}')
  symlinkSync("missing", join(eikon.dir("broken"), "dangling"))
  expect(() => eikon.lifecycle("broken")).toThrow("ENOENT")
})

test("missing board detail tables and query defects keep their raw errors", async () => {
  await using h = await tmpHome()
  const db = new Database(join(h.path, "kanban.db"))
  try {
    schema(db)
    db.run("INSERT INTO tasks (id, title, status) VALUES ('task', 'Test', 'todo')")
    resetKanban()
    for (const table of ["task_runs", "task_events", "task_attachments"]) {
      db.exec(`DROP TABLE ${table}`)
      expect(() => detailOf("default", "task")).toThrow(`no such table: ${table}`)
      schema(db)
    }
    db.exec("DROP TABLE task_runs; CREATE TABLE task_runs (id INTEGER)")
    expect(() => detailOf("default", "task")).toThrow("no such column: profile")
    db.exec("UPDATE tasks SET skills = '{' WHERE id = 'task'")
    expect(boardStateOf("default").error?.message).toContain("JSON Parse error")
  } finally { db.close(); resetKanban() }
})

test("a partial board metadata file is reported instead of hiding the board name", async () => {
  await using h = await tmpHome({ dirs: ["kanban/boards/test"] })
  expect(listBoards().some(b => b.slug === "test")).toBe(true)
  h.write("kanban/boards/test/board.json", "{")
  expect(() => listBoards()).toThrow(SyntaxError)
})
