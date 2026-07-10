#!/usr/bin/env bun
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { act } from "react"
import { Composer } from "../src/components/chat/Composer"
import { LOCAL_COMMANDS } from "../src/app/slashCommands"
import { App } from "../src/app"
import { mount, mountNode, until, MockGateway, type Harness } from "../test/harness"

export type Color = {
  r?: number; g?: number; b?: number; a?: number
  buffer?: Record<string, number> | ArrayLike<number>
}
export type StyledSpan = {
  text: string
  fg?: Color | null
  bg?: Color | null
  attributes?: number
  width?: number
}
export type StyledFrame = {
  cols: number
  rows: number
  cursor?: [number, number]
  lines: Array<{ spans: StyledSpan[] }>
}

export type CaptureContext = {
  act: typeof act
  mount: typeof mount
  mountNode: typeof mountNode
  until: typeof until
  MockGateway: typeof MockGateway
  App: typeof App
  Composer: typeof Composer
  LOCAL_COMMANDS: typeof LOCAL_COMMANDS
}

export type CaptureScenario = (ctx: CaptureContext) => Promise<Harness>

type Options = {
  scenario?: string
  module?: string
  out: string
  width: number
  height: number
  png: boolean
  json: boolean
  txt: boolean
}

const DEFAULT_OUT = ".ignore/screenshots/herm-styled"
const FONT = "DejaVu Sans Mono, Menlo, Consolas, monospace"
const BUILTIN = new Map<string, CaptureScenario>([
  ["composer-attachments", composerAttachments],
  ["clarify-prompt", clarifyPrompt],
  ["approval-prompt", approvalPrompt],
])

function usage(code = 0): never {
  const names = [...BUILTIN.keys()].join("\n  ")
  console.log(`Styled Herm/OpenTUI screenshots\n\nUsage:\n  bun scripts/styled-screenshot.tsx <scenario> [--out path/base] [--width 120] [--height 30]\n  bun scripts/styled-screenshot.tsx --module .ignore/captures/my.tsx [--out path/base]\n  bun scripts/styled-screenshot.tsx --list\n\nBuilt-in scenarios:\n  ${names}\n\nOutputs:\n  <out>.svg              Always written, preserves fg/bg/bold styling.\n  <out>.png              Written when ImageMagick is installed, unless --no-png.\n  <out>.json / <out>.txt Written unless --no-json / --no-txt.\n\nCustom module contract:\n  export default async function capture(ctx) {\n    const gw = new ctx.MockGateway()\n    const t = await ctx.mount({ gw, width: 120, height: 30 })\n    await ctx.until(t, () => t.frame().includes("Ready"))\n    return t\n  }\n`)
  process.exit(code)
}

function parse(argv: string[]): Options {
  const opts: Options = { out: DEFAULT_OUT, width: 120, height: 30, png: true, json: true, txt: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--help" || a === "-h") usage(0)
    if (a === "--list") { console.log([...BUILTIN.keys()].join("\n")); process.exit(0) }
    if (a === "--module") { opts.module = argv[++i]; continue }
    if (a === "--out") { opts.out = argv[++i] ?? opts.out; continue }
    if (a === "--width") { opts.width = Number(argv[++i] ?? opts.width); continue }
    if (a === "--height") { opts.height = Number(argv[++i] ?? opts.height); continue }
    if (a === "--no-png") { opts.png = false; continue }
    if (a === "--no-json") { opts.json = false; continue }
    if (a === "--no-txt") { opts.txt = false; continue }
    if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`)
    if (!opts.scenario) { opts.scenario = a; continue }
    throw new Error(`unexpected arg: ${a}`)
  }
  if (!opts.module && !opts.scenario) usage(1)
  return opts
}

function html(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function rawChannel(c: Color | null | undefined, name: "r" | "g" | "b" | "a", idx: number): number | undefined {
  if (!c) return undefined
  if (c[name] !== undefined) return c[name]
  const b = c.buffer
  if (!b) return undefined
  return (b as Record<string, number>)[String(idx)] ?? (b as ArrayLike<number>)[idx]
}

function channel(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0
  return Math.max(0, Math.min(255, Math.round(v <= 1 ? v * 255 : v)))
}

function alpha(c: Color | null | undefined): number {
  if (!c) return 0
  const a = rawChannel(c, "a", 3)
  if (a === undefined) return 1
  return a <= 1 ? a : a / 255
}

function css(c: Color | null | undefined, fallback: string): string {
  if (!c || alpha(c) <= 0) return fallback
  return `rgb(${channel(rawChannel(c, "r", 0))},${channel(rawChannel(c, "g", 1))},${channel(rawChannel(c, "b", 2))})`
}

function widthOf(span: StyledSpan): number {
  return span.width ?? [...(span.text ?? "")].length
}

export function renderStyledFrameSvg(frame: StyledFrame, opts: {
  title?: string
  fontSize?: number
  lineHeight?: number
  charWidth?: number
  padding?: number
  background?: string
} = {}): string {
  const fontSize = opts.fontSize ?? 18
  const lineHeight = opts.lineHeight ?? 24
  const charWidth = opts.charWidth ?? Math.round(fontSize * 0.6)
  const padding = opts.padding ?? 18
  const bg = opts.background ?? "#1a1b26"
  const w = frame.cols * charWidth + padding * 2
  const h = frame.rows * lineHeight + padding * 2
  const title = opts.title ? `<title>${html(opts.title)}</title>` : ""
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`)
  out.push(title)
  out.push(`<rect width="100%" height="100%" fill="${bg}"/>`)
  for (let y = 0; y < frame.lines.length; y++) {
    const line = frame.lines[y]!
    let x = padding
    for (const span of line.spans) {
      const cells = widthOf(span)
      const px = cells * charWidth
      const a = alpha(span.bg)
      if (a > 0) {
        out.push(`<rect x="${x}" y="${padding + y * lineHeight}" width="${px}" height="${lineHeight}" fill="${css(span.bg, bg)}" fill-opacity="${a.toFixed(3)}"/>`)
      }
      const text = span.text ?? ""
      if (text.length > 0) {
        const attrs = span.attributes ?? 0
        const weight = (attrs & 1) ? "700" : "400"
        const style = (attrs & 2) ? "italic" : "normal"
        out.push(`<text x="${x}" y="${padding + y * lineHeight + fontSize}" xml:space="preserve" font-family="${FONT}" font-size="${fontSize}" font-weight="${weight}" font-style="${style}" fill="${css(span.fg, "#d8dee9")}">${html(text)}</text>`)
      }
      x += px
    }
  }
  out.push("</svg>")
  return out.join("\n")
}

function basePath(raw: string): string {
  const ext = extname(raw)
  const out = ext ? raw.slice(0, -ext.length) : raw
  return isAbsolute(out) ? out : resolve(process.cwd(), out)
}

function writeArtifacts(t: Harness, opts: Options): { svg: string; png?: string; json?: string; txt?: string } {
  const base = basePath(opts.out)
  mkdirSync(dirname(base), { recursive: true })
  const frame = t.spans() as StyledFrame
  const svg = `${base}.svg`
  writeFileSync(svg, renderStyledFrameSvg(frame, { title: opts.scenario ?? opts.module ?? "Herm styled screenshot" }))
  const files: { svg: string; png?: string; json?: string; txt?: string } = { svg }
  if (opts.json) {
    files.json = `${base}.json`
    writeFileSync(files.json, JSON.stringify(frame, null, 2))
  }
  if (opts.txt) {
    files.txt = `${base}.txt`
    writeFileSync(files.txt, t.frame())
  }
  if (opts.png) {
    const png = `${base}.png`
    const r = spawnSync("magick", [svg, png], { encoding: "utf8" })
    if (r.status === 0 && existsSync(png)) files.png = png
    else console.warn("PNG conversion skipped: ImageMagick `magick` failed or is unavailable")
  }
  return files
}

async function loadScenario(opts: Options): Promise<CaptureScenario> {
  if (opts.module) {
    const path = resolve(process.cwd(), opts.module)
    const mod = await import(pathToFileURL(path).href)
    const fn = mod.default ?? mod.capture
    if (typeof fn !== "function") throw new Error(`${opts.module} must export default capture(ctx) or capture(ctx)`)
    return fn as CaptureScenario
  }
  const fn = BUILTIN.get(opts.scenario!)
  if (!fn) throw new Error(`unknown scenario '${opts.scenario}'. Run --list.`)
  return fn
}

function context(): CaptureContext {
  return { act, mount, mountNode, until, MockGateway, App, Composer, LOCAL_COMMANDS }
}

async function composerAttachments(ctx: CaptureContext): Promise<Harness> {
  const attachments = [
    { attached: true, path: "/tmp/mockup.png", name: "mockup.png", width: 640, height: 360, token_estimate: 1200 },
    { attached: true, path: "/tmp/spec.pdf", name: "spec.pdf" },
  ]
  const gw = new ctx.MockGateway()
  const t = await ctx.mountNode(
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1}><text>Composer attachments live inside the input box</text></box>
      <ctx.Composer
        focused canSubmitPrompt={true} ready streaming={true}
        status="Preflight compression: compacting context"
        model="gpt-demo"
        attachments={attachments}
        cmds={ctx.LOCAL_COMMANDS}
        onSend={() => {}} onSlash={() => {}}
      />
    </box>,
    { gw, width: 128, height: 28 },
  )
  await ctx.until(t, () => t.frame().includes("spec.pdf"))
  return t
}

async function clarifyPrompt(ctx: CaptureContext): Promise<Harness> {
  const gw = new ctx.MockGateway()
  const t = await ctx.mount({ gw, width: 120, height: 30 })
  await ctx.until(t, () => t.frame().includes("Ready"))
  ctx.act(() => gw.push({ type: "message.start" }))
  ctx.act(() => gw.push({
    type: "clarify.request",
    payload: { request_id: "c1", question: "Which option should I use?", choices: ["blue", "green"] },
  }))
  await ctx.until(t, () => t.frame().includes("Which option"))
  return t
}

async function approvalPrompt(ctx: CaptureContext): Promise<Harness> {
  const gw = new ctx.MockGateway()
  const t = await ctx.mount({ gw, width: 120, height: 30 })
  await ctx.until(t, () => t.frame().includes("Ready"))
  ctx.act(() => gw.push({ type: "message.start" }))
  ctx.act(() => gw.push({
    type: "approval.request",
    payload: { command: "rm -rf /tmp/demo", description: "delete temp demo files" },
  }))
  await ctx.until(t, () => t.frame().includes("Permission required") && t.frame().includes("rm -rf /tmp/demo"))
  return t
}

async function main() {
  const opts = parse(Bun.argv.slice(2))
  const scenario = await loadScenario(opts)
  const t = await scenario(context())
  try {
    const files = writeArtifacts(t, opts)
    for (const [kind, path] of Object.entries(files)) console.log(`${kind}: ${path}`)
  } finally {
    await act(async () => { t.destroy() })
  }
}

if (import.meta.main) {
  main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1) })
}
