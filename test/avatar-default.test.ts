import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"
import { defaultFrames } from "../src/components/avatar/states"

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "herm-default-"))
  const result = await Bun.build({
    entrypoints: [resolve("src/components/avatar/states/index.ts")],
    outdir: dir,
    publicPath: `${dir}/`,
    target: "bun",
  })
  if (!result.success) throw new AggregateError(result.logs, "Default eikon fixture build failed")
  const asset = result.outputs.find(output => output.kind === "asset")!.path
  const entry = result.outputs.find(output => output.kind === "entry-point")!.path
  return {
    asset,
    load: () => import(pathToFileURL(entry).href) as Promise<typeof import("../src/components/avatar/states")>,
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test("the bundled default preserves every frame and each state's playback metadata", () => {
  const clips = [
    ["idle", 64, 0, "ec47ddec1303dd8f08c49fbb31478e39bcd565bbda0bc320702c9fdd69fff42e"],
    ["listening", 65, 65, "7a8da3c7f691f9315d9d9239bac97ab48ed37a237f996c7fd1da08eb3f9b58d7"],
    ["thinking", 33, 33, "fbd0c45d770f80ea985b3eca1a0300f4f584c736dbbfcebbba20016abe56a539"],
    ["speaking", 66, 33, "37b425130f15fd6401936911c6d4225e07fe4b95de5a7b4a966a6fe732bb712b"],
    ["working", 130, 65, "51d3ddc407ec5496c0b7fdb4be2db63fd4c6d83d8dc71b7d922018ef4b133c05"],
    ["error", 33, 33, "4508e1ace73d15f69161c52dc8eab2ccbe2a3e5897637e014012ca5adfc82342"],
  ] as const
  for (const [state, count, loop, digest] of clips) {
    const clip = defaultFrames(state)
    expect([clip.frames.length, clip.fps, clip.loopFrom]).toEqual([count, 16, loop])
    expect(new Bun.CryptoHasher("sha256").update(JSON.stringify(clip.frames)).digest("hex")).toBe(digest)
  }
})

test("importing the default does not read it, and first use caches it across states", async () => {
  using f = await fixture()
  renameSync(f.asset, `${f.asset}.saved`)
  const loader = await f.load()
  expect(() => loader.defaultFrames("idle")).toThrow("ENOENT")
  renameSync(`${f.asset}.saved`, f.asset)
  const clip = loader.defaultFrames("idle")
  rmSync(f.asset)
  expect(loader.defaultFrames("idle")).toBe(clip)
  expect(loader.defaultFrames("thinking").frames).toHaveLength(33)
})

test("a malformed bundled default throws its raw parser error instead of blank frames", async () => {
  using f = await fixture()
  writeFileSync(f.asset, gzipSync('{"type":"header","eikon":99}\n'))
  const loader = await f.load()
  expect(() => loader.defaultFrames("idle")).toThrow("line 1: header.eikon must be 1")
})

test("a bundled default missing a required state is a build defect", async () => {
  using f = await fixture()
  const text = new TextDecoder().decode(Bun.gunzipSync(readFileSync(f.asset)))
  writeFileSync(f.asset, gzipSync(text.replaceAll('"name":"thinking"', '"name":"other"').replaceAll('"clip":"thinking"', '"clip":"other"')))
  const loader = await f.load()
  expect(() => loader.defaultFrames("thinking")).toThrow("Bundled default eikon has no thinking state")
})
