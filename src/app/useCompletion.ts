import { useEffect, useRef, useState } from "react"
import type { Gateway } from "../context/gateway"
import { frecency } from "./frecency"

export type CompletionItem = {
  readonly text: string
  readonly display: string
  readonly meta: string
}

export type CompletionRequest =
  | { method: "complete.path"; params: { word: string }; replaceFrom: number; replaceTo: number }
  | { method: "complete.slash"; params: { text: string }; replaceFrom: number; replaceTo: number }

const TAB_PATH_RE = /((?:["']?(?:[A-Za-z]:[\\/]|\.{1,2}\/|~\/|\/|@|[^"'`\s]+\/))[^\s]*)$/

function clear(setItems: (items: CompletionItem[]) => void, setCursor: (idx: number) => void, setReplace: (idx: number) => void, setEnd: (idx: number) => void) {
  setItems([])
  setCursor(0)
  setReplace(0)
  setEnd(0)
}

export function completionRequest(input: string): CompletionRequest | null {
  if (/^\/[A-Za-z0-9_-]+$/.test(input)) return null
  const word = input.match(TAB_PATH_RE)?.[1] ?? null
  if (!word) return null
  return { method: "complete.path", params: { word }, replaceFrom: input.length - word.length, replaceTo: input.length }
}

export function acceptCompletion(input: string, item: CompletionItem, replaceFrom: number, replaceTo = input.length) {
  const replace = item.text.startsWith("/") && input[replaceFrom - 1] === "/"
    ? replaceFrom - 1
    : item.text.startsWith("/") && input.startsWith("/") ? 0 : replaceFrom
  const left = input.slice(0, replace)
  const right = input.slice(replaceTo)
  if (item.text.includes(":")) frecency.bump(item.text)
  const space = item.text.endsWith("/") || /\s$/.test(item.text) || /^\s/.test(right) ? "" : " "
  return left + item.text + space + right
}

export function useCompletion(input: string, blocked: boolean, gw: Gateway, req?: CompletionRequest | null) {
  const [items, setItems] = useState<CompletionItem[]>([])
  const [cursor, setCursor] = useState(0)
  const [replaceFrom, setReplace] = useState(0)
  const [replaceTo, setEnd] = useState(0)
  const seq = useRef(0)
  const dismissed = useRef<string | null>(null)
  const reqKey = req ? JSON.stringify(req) : ""

  useEffect(() => {
    if (blocked) {
      seq.current++
      dismissed.current = null
      clear(setItems, setCursor, setReplace, setEnd)
      return
    }
    const next = req ?? completionRequest(input)
    if (!next) {
      seq.current++
      dismissed.current = null
      clear(setItems, setCursor, setReplace, setEnd)
      return
    }
    if (dismissed.current === input) return
    dismissed.current = null
    const me = ++seq.current
    const t = setTimeout(() => {
      gw.request<{ items?: CompletionItem[]; replace_from?: number }>(next.method, next.params)
        .then(r => {
          if (seq.current !== me) return
          const ranked = (r.items ?? [])
            .map(i => ({ i, s: frecency.score(i.text) }))
            .sort((a, b) => b.s - a.s)
            .map(x => x.i)
          setItems(ranked)
          setCursor(0)
          setReplace(next.method === "complete.slash" ? next.replaceFrom + ((r.replace_from ?? 1) - 1) : next.replaceFrom)
          setEnd(next.replaceTo)
        })
        .catch(e => {
          if (seq.current !== me) return
          setItems([{ text: "", display: "completion unavailable", meta: e instanceof Error && e.message ? e.message : "unavailable" }])
          setCursor(0)
          setReplace(next.replaceFrom)
          setEnd(next.replaceTo)
        })
    }, 60)
    return () => clearTimeout(t)
  }, [blocked, gw, input, reqKey])

  const open = items.length > 0
  const dismiss = () => {
    seq.current++
    dismissed.current = input
    clear(setItems, setCursor, setReplace, setEnd)
  }

  return { open, items, cursor, setCursor, replaceFrom, replaceTo, dismiss }
}
