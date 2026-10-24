import { describe, test, expect } from "bun:test"
import { count, formatTokens } from "../src/utils/tokens"

describe("tokens.count", () => {
  test.each([
    ["", 0],
    ["a", 1],
    ["abcd", 1],
    ["abcde", 2],
    ["The quick brown fox jumps over the lazy dog", 11],
    ["你好世界", 4],
    ["漢字とかな交じり文です。", 12],
    ["압축 테스트 " + "가".repeat(1000), 1006],
    ["hello 안녕 world", 5],
    ["ｱｲｳｴｵ ﾃｽﾄ", 9],
    ["русский текст", 7],
    ["Καλημέρα", 4],
    ["café résumé naïve", 6],
    ["🙂", 1],
    ["🙂🙂🙂🙂🙂", 5],
    ["a🙂b", 2],
    ["abc\ud800def", 2],
    ["漢字\udfff", 3],
    ["\ud800".repeat(5), 2],
    ["\udfff".repeat(5), 2],
  ])("matches Hermes' rough token budget for %j", (text, expected) => {
    expect(count(text)).toBe(expected)
  })

  test.each([
    [0x10ff, 3], [0x1100, 4], [0x11ff, 4], [0x1200, 3],
    [0x2e7f, 3], [0x2e80, 4], [0x9fff, 4], [0xa000, 3],
    [0xa95f, 3], [0xa960, 4], [0xa97f, 4], [0xa980, 3],
    [0xabff, 3], [0xac00, 4], [0xd7af, 4], [0xd7b0, 3],
    [0xf8ff, 3], [0xf900, 4], [0xfaff, 4], [0xfb00, 3],
    [0xfeff, 3], [0xff00, 4], [0xffef, 4], [0xfff0, 3],
  ])("preserves Hermes' dense-range boundary at U+%i", (code, expected) => {
    expect(count(String.fromCodePoint(code).repeat(4))).toBe(expected)
  })
})

describe("tokens.formatTokens", () => {
  test("under 1000 → bare number", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(42)).toBe("42")
    expect(formatTokens(999)).toBe("999")
  })

  test("1k–10k → 1-decimal K", () => {
    expect(formatTokens(1_000)).toBe("1.0K")
    expect(formatTokens(1_500)).toBe("1.5K")
    expect(formatTokens(9_999)).toBe("10.0K")
  })

  test("10k–1M → integer K", () => {
    expect(formatTokens(10_000)).toBe("10K")
    expect(formatTokens(258_000)).toBe("258K")
    expect(formatTokens(999_499)).toBe("999K")
  })

  test("≥1M → M, one decimal unless whole", () => {
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(1_200_000)).toBe("1.2M")
    expect(formatTokens(2_000_000)).toBe("2M")
    expect(formatTokens(1_234_567)).toMatch(/^1\.2M$/)
  })

  test("negative / NaN / Infinity → '0'", () => {
    expect(formatTokens(-1)).toBe("0")
    expect(formatTokens(NaN)).toBe("0")
    expect(formatTokens(Infinity)).toBe("0")
  })
})
