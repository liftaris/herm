const SGR_MOUSE_BLOB_RE = /^(?:\x1b\[|\^\[\[)?<?\d+(?:;\d+){1,2}[Mm]$/
const SGR_MOUSE_RESIDUE_RE = /^\d+(?:;\d+){1,2}[Mm]$/

export function isDegradedMouseInput(key: { name?: string; raw?: string; sequence?: string }): boolean {
  const vals = [key.raw, key.sequence, key.name]
  return vals.some(v => typeof v === "string" && isDegradedMouseBlob(v))
}

function isDegradedMouseBlob(text: string): boolean {
  if (!text || /\s/.test(text)) return false
  return SGR_MOUSE_BLOB_RE.test(text) || SGR_MOUSE_RESIDUE_RE.test(text)
}
