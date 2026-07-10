// Extmark-backed parts model for the composer. Offsets are display-width
// (what extmarks consume), not JS string indices. virtual:true marks give
// cursor-atomic + delete-atomic behavior; there is no custom backspace code.

import type { TextareaRenderable, ExtmarksController, SyntaxStyle, ColorInput } from "@opentui/core"

type PartKind = "file" | "agent" | "text"

export type FilePart = {
  type: "file"
  mime: string
  filename?: string
  url?: string
  source?: {
    type: "file"
    path: string
    text: { start: number; end: number; value: string }
  }
}

export type AgentPart = {
  type: "agent"
  name: string
  source?: { start: number; end: number; value: string }
}

export type TextPart = {
  type: "text"
  text: string
  synthetic?: boolean
  source?: { text: { start: number; end: number; value: string } }
}

export type Part = FilePart | AgentPart | TextPart

export type PartsSnapshot = {
  v: 1
  input: string
  parts: Part[]
}

const TYPE = "prompt-part"
const STYLE = {
  file: "extmark.file",
  agent: "extmark.agent",
  paste: "extmark.paste",
} as const

// Idempotent style registration on a shared SyntaxStyle.
export function styles(syntax: SyntaxStyle, theme: { accent: ColorInput; primary: ColorInput; textMuted: ColorInput }) {
  const ensure = (name: string, def: { fg?: ColorInput; italic?: boolean }) => {
    const id = syntax.getStyleId(name)
    if (id !== null) return id
    return syntax.registerStyle(name, def)
  }
  return {
    file: ensure(STYLE.file, { fg: theme.accent }),
    agent: ensure(STYLE.agent, { fg: theme.primary, italic: true }),
    paste: ensure(STYLE.paste, { fg: theme.textMuted }),
  }
}

type StyleIds = { file: number; agent: number; paste: number }

// Bridges a TextareaRenderable (source of truth) and a parallel parts[].
// The id→index map drops parts whose mark was deleted and rewrites ranges
// when marks shift.
export class PartsBuffer {
  private ta: TextareaRenderable
  private ex: ExtmarksController
  private typeId: number
  private style: StyleIds
  private list: Part[] = []
  private map = new Map<number, number>()

  constructor(ta: TextareaRenderable, style: StyleIds) {
    this.ta = ta
    this.ex = ta.extmarks
    this.style = style
    this.typeId = this.ex.registerType(TYPE)
  }

  text() { return this.ta.plainText }

  // The textarea can be destroyed mid-session (tab switch, hot reload).
  private alive() { return !this.ta.isDestroyed }

  insertText(str: string) {
    if (!this.alive()) return
    this.ta.insertText(str)
  }

  // Trailing space keeps the caret outside the chip so the next keystroke
  // doesn't extend the range. Offsets are visualCursor.offset, not cursorOffset.
  insertPart(part: Part, virtualText: string) {
    if (!this.alive()) return
    const start = this.ta.visualCursor.offset
    const end = start + visualLen(virtualText)
    this.ta.insertText(virtualText + " ")
    const id = this.ex.create({
      start,
      end,
      virtual: true,
      styleId: styleFor(part.type, this.style),
      typeId: this.typeId,
    })
    const idx = this.list.length
    this.list.push(withSource(part, start, end, virtualText))
    this.map.set(id, idx)
  }

  // Rebuild parts[] from the marks that still exist.
  sync() {
    if (!this.alive()) return
    const alive = this.ex.getAllForTypeId(this.typeId)
    const next: Part[] = []
    const nextMap = new Map<number, number>()
    for (const m of alive) {
      const idx = this.map.get(m.id)
      if (idx === undefined) continue
      const p = this.list[idx]
      if (!p) continue
      nextMap.set(m.id, next.length)
      next.push(rangeTo(p, m.start, m.end))
    }
    this.list = next
    this.map = nextMap
  }

  parts(): readonly Part[] {
    this.sync()
    return this.list
  }

  toSnapshot(): PartsSnapshot {
    return { v: 1, input: this.text(), parts: [...this.parts()] }
  }

  fromSnapshot(snap: PartsSnapshot) {
    if (!this.alive()) return
    this.ta.setText(snap.input)
    this.ex.clear()
    this.list = []
    this.map = new Map()
    for (const p of snap.parts) {
      const r = rangeOf(p)
      if (!r) continue
      const id = this.ex.create({
        start: r.start,
        end: r.end,
        virtual: true,
        styleId: styleFor(p.type, this.style),
        typeId: this.typeId,
      })
      this.map.set(id, this.list.length)
      this.list.push(p)
    }
    this.ta.gotoBufferEnd()
  }

  clear() {
    this.list = []
    this.map = new Map()
    if (!this.alive()) return
    this.ta.setText("")
    this.ex.clear()
  }

  // Inline text parts (paste bodies) back into the string; only file/agent
  // parts ride to the gateway.
  expand(): { text: string; parts: Part[] } {
    if (!this.alive()) return { text: "", parts: [] }
    this.sync()
    let text = this.text()
    const marks = this.ex.getAllForTypeId(this.typeId).sort((a, b) => b.start - a.start)
    for (const m of marks) {
      const idx = this.map.get(m.id)
      if (idx === undefined) continue
      const p = this.list[idx]
      if (p?.type !== "text") continue
      text = text.slice(0, m.start) + p.text + text.slice(m.end)
    }
    return { text, parts: this.list.filter(p => p.type !== "text") }
  }
}

function visualLen(s: string): number {

  const B = (globalThis as { Bun?: { stringWidth?: (s: string) => number } }).Bun
  return B?.stringWidth ? B.stringWidth(s) : s.length
}

function styleFor(k: PartKind, s: StyleIds) {
  if (k === "file") return s.file
  if (k === "agent") return s.agent
  return s.paste
}

function withSource(p: Part, start: number, end: number, value: string): Part {
  if (p.type === "file") return { ...p, source: p.source ?? { type: "file", path: "", text: { start, end, value } } }
  if (p.type === "agent") return { ...p, source: { start, end, value } }
  return { ...p, source: { text: { start, end, value } } }
}

function rangeTo(p: Part, start: number, end: number): Part {
  if (p.type === "file") {
    const src = p.source ?? { type: "file" as const, path: "", text: { start, end, value: "" } }
    return { ...p, source: { ...src, text: { ...src.text, start, end } } }
  }
  if (p.type === "agent") {
    const src = p.source ?? { start, end, value: "" }
    return { ...p, source: { ...src, start, end } }
  }
  const src = p.source ?? { text: { start, end, value: "" } }
  return { ...p, source: { text: { ...src.text, start, end } } }
}

function rangeOf(p: Part) {
  if (p.type === "file") return p.source?.text
  if (p.type === "agent") return p.source
  return p.source?.text
}

export * as parts from "./parts"
