#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join, resolve } from "node:path"
import { RULES } from "../src/config/rules"
import { RPC_ALIAS, route } from "../src/config/lane"
import { MERGE, SELECTS } from "../src/config/semantics"
import { findRoot, generate, remote, schemaTarget, type Entry } from "./schema-source"

type Base = {
  SCHEMA: Record<string, Entry>
  SCHEMA_KEYS?: string[]
  APPROVAL_MODES: readonly string[]
}

type Source = {
  kind: "pinned" | "current_upstream"
  root: string
  sha: string
  remote_url: string
  reproducible: boolean
  schema_source_sha?: string
  workflow_shas?: string[]
  ref?: string
  resolved_sha?: string
}

type Cmp = {
  added: string[]
  removed: string[]
  changed: { key: string; fields: string[] }[]
}

type Finding = {
  id: string
  provenance: "pinned" | "current_upstream"
  category: string
  severity: "blocking" | "warning" | "info"
  key?: string
  producer?: Entry | null
  generated?: Entry | null
  classification?: Record<string, unknown>
  evidence: string[]
}

const arg = (name: string) => {
  const pos = Bun.argv.indexOf(name)
  return pos >= 0 ? Bun.argv[pos + 1] : undefined
}

const has = (name: string) => Bun.argv.includes(name)

const sort = <T>(xs: T[], f = (x: T) => String(x)) => [...xs].sort((a, b) => f(a).localeCompare(f(b)))

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const stamp = () => process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString()

const hermSha = () => {
  const proc = Bun.spawnSync(["git", "-C", join(import.meta.dir, ".."), "rev-parse", "HEAD"])
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : "unknown"
}

const load = async (path: string): Promise<Base> => {
  const url = `${pathToFileURL(resolve(path)).href}?v=${Date.now()}`
  return await import(url) as Base
}

const shaOf = (path: string) => {
  if (!existsSync(path)) return "unknown"
  const m = readFileSync(path, "utf8").match(/Source: hermes-agent@([^\s]+) hermes_cli\/config\.py/)
  return m?.[1] ?? "unknown"
}

const workflows = () => sort(["ci.yml", "release.yml"].flatMap(file => {
  const path = join(import.meta.dir, "..", ".github", "workflows", file)
  if (!existsSync(path)) return []
  return [...readFileSync(path, "utf8").matchAll(/fetch --depth=1 origin ([0-9a-f]{40})/g)].map(m => m[1])
})).filter((v, i, xs) => xs.indexOf(v) === i)

const fields = (a: Entry, b: Entry) => ["type", "default", "doc", "group", "effect"]
  .filter(k => !same(a[k as keyof Entry], b[k as keyof Entry]))

const compare = (base: Record<string, Entry>, next: Record<string, Entry>): Cmp => {
  const bk = Object.keys(base)
  const nk = Object.keys(next)
  const bs = new Set(bk)
  const ns = new Set(nk)
  return {
    added: sort(nk.filter(k => !bs.has(k))),
    removed: sort(bk.filter(k => !ns.has(k))),
    changed: sort(bk.filter(k => ns.has(k)).flatMap(k => {
      const f = fields(base[k], next[k])
      return f.length ? [{ key: k, fields: f }] : []
    }), x => x.key),
  }
}

const mode = (base: readonly string[], next: readonly string[]) => ({
  generated: [...base],
  producer: [...next],
  status: same(base, next) ? "match" : "drift",
})

const raw = (key: string, entry?: Entry) => entry?.group ?? (key.includes(".") ? key.split(".")[0] : "general")

const note = (key: string, entry?: Entry) => {
  const lane = route(key)
  return {
    select_options: key === "display.skin" ? "dynamic" : SELECTS[key] ?? null,
    validation_rule: !!RULES[key],
    lane: lane.via,
    rpc_alias: lane.via === "rpc" ? lane.alias : null,
    raw_group: raw(key, entry),
    group: MERGE[raw(key, entry)] ?? raw(key, entry),
    effect: entry?.effect ?? null,
  }
}

const id = (prov: string, category: string, key: string) =>
  `cfg-${prov}-${category}-${key}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "")

const findings = (prov: "pinned" | "current_upstream", cmp: Cmp, base: Base, next: ReturnType<typeof generate>) => {
  const out: Finding[] = []
  for (const key of cmp.added) {
    out.push({
      id: id(prov, "added-key", key), provenance: prov, category: "added_key", severity: prov === "pinned" ? "blocking" : "info", key,
      producer: next.entries[key], generated: null, classification: note(key, next.entries[key]), evidence: [`${prov}:schema:${key}`],
    })
    out.push({
      id: id(prov, "review-required", key), provenance: prov, category: "review_required", severity: prov === "pinned" ? "warning" : "info", key,
      producer: next.entries[key], generated: null,
      classification: { ...note(key, next.entries[key]), requires_review: true, reason: "new key needs select/rule/lane/effect/group review" },
      evidence: [`${prov}:schema:${key}`],
    })
  }
  for (const key of cmp.removed) out.push({
    id: id(prov, "removed-key", key), provenance: prov, category: "removed_key", severity: prov === "pinned" ? "blocking" : "warning", key,
    producer: null, generated: base.SCHEMA[key], classification: note(key, base.SCHEMA[key]), evidence: [`generated:schema:${key}`],
  })
  for (const ch of cmp.changed) {
    if (ch.fields.includes("default")) out.push({
      id: id(prov, "default-changed", ch.key), provenance: prov, category: "default_changed", severity: prov === "pinned" ? "blocking" : "info", key: ch.key,
      producer: next.entries[ch.key], generated: base.SCHEMA[ch.key], classification: note(ch.key, next.entries[ch.key]), evidence: [`${prov}:schema:${ch.key}`],
    })
    if (ch.fields.some(f => f === "type" || f === "effect" || f === "group")) out.push({
      id: id(prov, "classification-changed", ch.key), provenance: prov, category: "classification_changed", severity: "warning", key: ch.key,
      producer: next.entries[ch.key], generated: base.SCHEMA[ch.key], classification: { ...note(ch.key, next.entries[ch.key]), fields: ch.fields }, evidence: [`${prov}:schema:${ch.key}`],
    })
  }
  const modes = mode(base.APPROVAL_MODES, next.approvalModes)
  if (modes.status === "drift") out.push({
    id: id(prov, "enum-changed", "approval-modes"), provenance: prov, category: "enum_changed", severity: prov === "pinned" ? "blocking" : "warning",
    producer: null, generated: null, classification: { key: "approvals.mode", ...modes }, evidence: [`${prov}:approval_modes`],
  })
  return out
}

const annotations = (schema: Record<string, Entry>, added: string[]) => {
  const keys = new Set(Object.keys(schema))
  const roots = new Set(Object.keys(schema).map(k => raw(k, schema[k])))
  return {
    missing_review: added.map(key => ({ key, reason: "new key needs reviewed select/rule/lane/effect/group classification" })),
    stale_review: sort([
      ...Object.keys(SELECTS).filter(key => key !== "display.skin" && !keys.has(key)).map(key => ({ kind: "select", key })),
      ...Object.keys(RULES).filter(key => !keys.has(key)).map(key => ({ kind: "rule", key })),
      ...Object.keys(RPC_ALIAS).filter(key => !keys.has(key)).map(key => ({ kind: "lane", key })),
      ...Object.keys(MERGE).filter(key => !roots.has(key)).map(key => ({ kind: "group", key })),
    ], x => `${x.kind}:${x.key}`),
  }
}

const status = (cmp: Cmp, modes: ReturnType<typeof mode>) =>
  cmp.added.length || cmp.removed.length || cmp.changed.length || modes.status === "drift" ? "drift" : "clean"

function makeReport(base: Base, pinned: ReturnType<typeof generate>, current?: ReturnType<typeof generate>, baseline = schemaTarget()) {
  const pc = compare(base.SCHEMA, pinned.entries)
  const pm = mode(base.APPROVAL_MODES, pinned.approvalModes)
  const cc = current ? compare(base.SCHEMA, current.entries) : undefined
  const cm = current ? mode(base.APPROVAL_MODES, current.approvalModes) : undefined
  const found = [
    ...findings("pinned", pc, base, pinned),
    ...(current && cc ? findings("current_upstream", cc, base, current) : []),
  ]
  return {
    schema_version: 1,
    generated_at: stamp(),
    tool: { name: "herm-config-drift", herm_sha: hermSha() },
    sources: {
      pinned: { kind: "pinned", root: pinned.root, sha: pinned.sha, remote_url: remote(pinned.root), schema_source_sha: shaOf(baseline), workflow_shas: workflows(), reproducible: true } satisfies Source,
      ...(current ? { current_upstream: { kind: "current_upstream", root: current.root, remote_url: remote(current.root), ref: arg("--current-ref") ?? "refs/heads/main", sha: current.sha, resolved_sha: current.sha, reproducible: false } satisfies Source } : {}),
    },
    summary: {
      pinned: { status: status(pc, pm), keys: pinned.keys.length, added: pc.added.length, removed: pc.removed.length, changed: pc.changed.length, approval_modes: pinned.approvalModes },
      ...(current && cc && cm ? { current_upstream: { status: status(cc, cm), keys: current.keys.length, added: cc.added.length, removed: cc.removed.length, changed: cc.changed.length, approval_modes: current.approvalModes } } : {}),
    },
    findings: sort(found, x => `${x.provenance}:${x.category}:${x.key ?? ""}`),
    comparisons: {
      keys: { added: current && cc ? cc.added : pc.added, removed: current && cc ? cc.removed : pc.removed },
      entries: { changed: current && cc ? cc.changed.filter(x => x.fields.includes("default")) : pc.changed.filter(x => x.fields.includes("default")) },
      approval_modes: { pinned: pm, ...(cm ? { current_upstream: cm } : {}) },
      annotations: annotations(current?.entries ?? pinned.entries, current && cc ? cc.added : pc.added),
    },
  }
}

type Report = ReturnType<typeof makeReport>

const human = (report: Report) => {
  const lines = [
    `Pinned schema: ${report.summary.pinned.status} (${report.sources.pinned.sha})`,
    report.sources.current_upstream
      ? `Current upstream: ${report.summary.current_upstream?.status} (${report.sources.current_upstream.resolved_sha})`
      : "Current upstream: not checked",
  ]
  const cur = report.summary.current_upstream
  if (cur) lines.push(`keys +${cur.added} / -${cur.removed} / Δ${cur.changed}`)
  lines.push(`approval modes: ${report.comparisons.approval_modes.current_upstream?.status ?? report.comparisons.approval_modes.pinned.status}`)
  const review = report.comparisons.annotations.missing_review.map(x => x.key)
  lines.push(`review needed: ${review.length ? `${review.slice(0, 8).join(", ")}${review.length > 8 ? ` +${review.length - 8} more` : ""}` : "none"}`)
  return `${lines.join("\n")}\n`
}

try {
  const baseline = arg("--baseline") ?? schemaTarget()
  const base = await load(baseline)
  const pinned = generate(findRoot(arg("--pinned-root")))
  const cur = arg("--current-root")
  const current = cur ? generate(findRoot(cur)) : undefined
  const out = makeReport(base, pinned, current, baseline)
  if (has("--json")) console.log(JSON.stringify(out, null, 2))
  else console.log(human(out))
  const curStatus = out.summary.current_upstream?.status
  process.exit(out.summary.pinned.status === "clean" && (!curStatus || curStatus === "clean" || has("--warn-current")) ? 0 : 1)
} catch (e) {
  console.error("config-drift:", e instanceof Error ? e.message : String(e))
  process.exit(1)
}
