import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseDocument } from "yaml"
import { hermesPath } from "./hermes-home"

const locate = () => {
  let dir = import.meta.dir
  for (let i = 0; i < 5; i++) {
    const path = join(dir, "assets/plugins")
    if (existsSync(path)) return path
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return undefined
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : []

function ours(dir: string): boolean {
  const path = join(dir, "plugin.yaml")
  if (!existsSync(path)) return false
  const raw = readFileSync(path, "utf8")
  return raw.includes("name: eikon") && raw.includes("eikon_install")
}

function enable(name: string): boolean {
  const path = hermesPath("config.yaml")
  const raw = existsSync(path) ? readFileSync(path, "utf8") : ""
  const doc = parseDocument(raw || "{}\n")
  const js = doc.toJS()
  if (!js || typeof js !== "object" || Array.isArray(js))
    (doc as unknown as { contents: unknown }).contents = doc.createNode({})
  const cfg = obj(doc.toJS())
  const plug = obj(cfg.plugins)
  if (arr(plug.disabled).includes(name) || arr(plug.enabled).includes(name)) return false
  doc.setIn(["plugins", "enabled"], [...arr(plug.enabled), name])
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, String(doc), "utf8")
  return true
}

export function sync(): string[] {
  const src = locate()
  if (!src) return []
  const root = hermesPath("plugins")
  const out: string[] = []
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dst = join(root, e.name)
    const fresh = !existsSync(dst)
    if (fresh) {
      mkdirSync(root, { recursive: true })
      cpSync(join(src, e.name), dst, { recursive: true })
      out.push(e.name)
    }
    if (fresh || ours(dst)) enable(e.name)
  }
  return out
}

export * as plugins from "./bundled-plugins"
