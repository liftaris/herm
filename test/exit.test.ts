// Tests for the exit screen.  `banner()` is a pure string builder so we
// test it directly.  `quit()` that calls writeSync on fd 1 is tested via
// its observable behaviour (renderer.destroy, gw.kill, process.exit).

import { describe, expect, test } from "bun:test"
import { banner } from "../src/app/exit"

test("banner includes goodbye message", () => {
  const out = banner("Goodbye! ⚕", "2m", "42", "my session", "test-sid")
  expect(out).toContain("Goodbye! ⚕")
  expect(out).toContain("herm --resume test-sid")
})

test("banner shows stats when provided", () => {
  const out = banner("Goodbye!", "2m", "42", "my session", "sid", undefined, "7", "5.2k", "1.3k")
  expect(out).toContain("2m")
  expect(out).toContain("42")
  expect(out).toContain("my session")
  expect(out).toContain("7")
  expect(out).toContain("5.2k")
  expect(out).toContain("1.3k")
})

test("banner shows model when provided", () => {
  const out = banner("Goodbye!", "2m", "42", "", "sid", "deepseek-chat")
  expect(out).toContain("deepseek-chat")
})

test("banner omits empty stats", () => {
  const out = banner("Bye", "", "", "title only", "sid")
  expect(out).not.toContain("session")
  expect(out).not.toContain("messages")
  expect(out).toContain("title only")
})

test("banner renders bare resume line with no stats", () => {
  const out = banner("Bye", "", "", "", "bare-sid")
  expect(out).toContain("herm --resume bare-sid")
  expect(out).not.toContain("session")
  expect(out).not.toContain("messages")
  expect(out).not.toContain("title")
})

test("banner renders skin-themed farewell", () => {
  expect(banner("Farewell, warrior! ⚔", "", "", "", "s")).toContain("Farewell, warrior! ⚔")
  expect(banner("Flame out! ✦", "", "", "", "s")).toContain("Flame out! ✦")
})

test("banner shows goodbye and resume", () => {
  const out = banner("Bye", "", "", "", "s")
  expect(out).toContain("Bye")
  expect(out).toContain("herm --resume s")
})
