// Direct subprocess bridge to hermes-agent's image_generate /
// video_generate tool functions. No gateway RPC — the installed
// hermes-agent venv is on disk and the tool modules are plain
// synchronous Python that returns a JSON string. We call them with
// `python -c`, parse stdout, and normalize to a local file path.
//
// `GenerateFn` is the injectable surface so tests (and future
// providers) can swap the backend without touching callers.

import { existsSync, readFileSync } from "node:fs"
import { hermesPath } from "./hermes-home"

export type GenerateKind = "image" | "video"
export type GenerateOpts = { seed?: string; seconds?: number; aspect?: string }
export type GenerateOut = { path: string } | { err: string }
export type GenerateFn = (kind: GenerateKind, prompt: string, opts: GenerateOpts) => Promise<GenerateOut>

const ROOT = () => hermesPath("hermes-agent")
const isWin = process.platform === "win32"
const PY = () => {
  for (const v of ["venv", ".venv"]) {
    const bin = isWin ? `${ROOT()}/${v}/Scripts/python.exe` : `${ROOT()}/${v}/bin/python`
    if (existsSync(bin)) return bin
  }
  return isWin ? "python" : "python3"
}

/** API keys live in ~/.hermes/.env (per AGENTS.md: env file is keys-
 *  only). Bun auto-loads .env from the project cwd, not from
 *  HERMES_HOME, so the python subprocess won't see them unless we
 *  parse the file and merge it into the child env. Quoted values
 *  and `export ` prefixes are stripped; existing process env wins
 *  so per-shell overrides still apply. */
function dotenv(): Record<string, string> {
  const out: Record<string, string> = {}
  const path = hermesPath(".env")
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const ln = raw.trim()
    if (!ln || ln.startsWith("#")) continue
    const eq = ln.indexOf("=")
    if (eq < 1) continue
    const k = ln.slice(0, eq).replace(/^export\s+/, "").trim()
    let v = ln.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

const env = (): Record<string, string> => {
  // Merge order: ~/.hermes/.env < process.env so a live shell override wins.
  const base = dotenv()
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
  return base
}

const q = (s: string) => JSON.stringify(s)

function code(kind: GenerateKind, prompt: string, o: GenerateOpts): string {
  // _handle_image_generate / _handle_video_generate route through
  // `image_gen.provider` / `video_gen.provider` config so a plugin
  // (openai, xai, etc.) wins when configured; the raw _tool funcs
  // only know about the in-tree FAL backend.
  if (kind === "image") return [
    "from tools.image_generation_tool import _handle_image_generate as g",
    `print(g({"prompt": ${q(prompt)}, "aspect_ratio": ${q(o.aspect ?? "square")}}))`,
  ].join("; ")
  const args: string[] = [`"prompt":${q(prompt)}`, `"aspect_ratio":${q(o.aspect ?? "1:1")}`]
  if (o.seconds) args.push(`"duration":${o.seconds}`)
  if (o.seed) args.push(`"image_url":${q(o.seed)}`)
  return [
    "from tools.video_generation_tool import _handle_video_generate as g",
    `print(g({${args.join(",")}}))`,
  ].join("; ")
}

/** Probe whether each gen backend is configured — cheaper than
 *  `toolsets.list` and checks provider availability, not just the
 *  toolset toggle. */
export async function probe(): Promise<{ image: boolean; video: boolean }> {
  const root = ROOT()
  if (!existsSync(root)) return { image: false, video: false }
  const src = [
    "import json",
    "from tools.image_generation_tool import check_image_generation_requirements as ci",
    "from tools.video_generation_tool import check_video_generation_requirements as cv",
    "print(json.dumps({'image': bool(ci()), 'video': bool(cv())}))",
  ].join("; ")
  let r
  try { r = Bun.spawn([PY(), "-c", src], { cwd: root, env: env(), stdout: "pipe", stderr: "pipe" }) }
  catch { return { image: false, video: false } }
  const out = await new Response(r.stdout).text()
  if ((await r.exited) !== 0) return { image: false, video: false }
  const last = out.trim().split("\n").pop()!
  try { return JSON.parse(last) } catch { return { image: false, video: false } }
}

async function fetchTo(url: string, ext: string): Promise<string> {
  const tmp = `${process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp"}/eikon-gen-${Date.now()}${ext}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${res.status}`)
  await Bun.write(tmp, await res.arrayBuffer())
  return tmp
}

export const generate: GenerateFn = async (kind, prompt, opts) => {
  const r = Bun.spawn([PY(), "-c", code(kind, prompt, opts)],
    { cwd: ROOT(), env: env(), stdout: "pipe", stderr: "pipe" })
  const [out, err, exit] = await Promise.all([
    new Response(r.stdout).text(),
    new Response(r.stderr).text(),
    r.exited,
  ])
  if (exit !== 0) return { err: (err || out).trim().split("\n").slice(-3).join(" ") || `python exited ${exit}` }
  const last = out.trim().split("\n").pop()
  if (!last) return { err: "no output" }
  let j: { success?: boolean; image?: string; video?: string; error?: string }
  try { j = JSON.parse(last) } catch { return { err: `unparseable: ${last.slice(0, 200)}` } }
  if (j.success === false || j.error) return { err: String(j.error ?? "provider error") }
  const ref = j.image ?? j.video
  if (!ref) return { err: "provider returned no asset" }
  if (ref.startsWith("/") || ref.startsWith("file://"))
    return { path: ref.replace(/^file:\/\//, "") }
  if (/^https?:\/\//.test(ref))
    return fetchTo(ref, kind === "image" ? ".png" : ".mp4")
      .then(p => ({ path: p }))
      .catch(e => ({ err: `download: ${e instanceof Error ? e.message : e}` }))
  return { err: `unrecognized asset ref: ${ref.slice(0, 80)}` }
}

// Swappable for tests; callers take GenerateFn as a parameter.
let impl: GenerateFn = generate
let probeImpl = probe
export const current = (): GenerateFn => impl
export const setImpl = (fn: GenerateFn | null) => { impl = fn ?? generate }
export const setProbe = (fn: typeof probe | null) => { probeImpl = fn ?? probe }
export const probeCached = () => probeImpl()

export * as gen from "./eikon-gen"
