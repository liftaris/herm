// Match Hermes' estimate_tokens_rough so displayed budgets agree with preflight.
// Lone surrogates use Python's one-byte UTF-8 replacement, not U+FFFD.
export function count(s: string): number {
  let dense = 0
  let bytes = 0
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xa960 && code <= 0xa97f) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      dense++
      continue
    }
    bytes += ch.length === 2 ? 4
      : code <= 0x7f || (code >= 0xd800 && code <= 0xdfff) ? 1
      : code <= 0x7ff ? 2 : 3
  }
  return dense + Math.ceil(bytes / 4)
}

/**
 * Human-format a token count for compact display:
 *   999 → "999"   1_000 → "1.0K"   10_000 → "10K"
 *   258_000 → "258K"   1_000_000 → "1M"   1_250_000 → "1.2M"
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`
  return String(Math.round(n))
}
