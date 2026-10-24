import { describe, test, expect } from "bun:test"
import { EventEmitter } from "node:events"
import { openUrl, parseSafeUrl, openCommand } from "../src/utils/open-file"

function makeSpawn(platformId: string, opts: { throws?: boolean } = {}) {
  const calls: { command: string; args: string[] }[] = []
  let child: FakeChild | null = null
  const fn = ((command: string, args: string[]) => {
    calls.push({ command, args })
    if (opts.throws) throw new Error("EINVAL")
    child = new FakeChild()
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>
  }) as typeof import("node:child_process").spawn
  return { spawn: fn, platform: () => platformId, calls, child: () => child }
}

class FakeChild extends EventEmitter {
  unrefed = false
  unref() { this.unrefed = true }
}

describe("parseSafeUrl", () => {
  test("accepts http and https", () => {
    expect(parseSafeUrl("http://example.com")?.href).toBe("http://example.com/")
    expect(parseSafeUrl("https://example.com/path?q=1")?.href).toBe("https://example.com/path?q=1")
  })

  test("rejects dangerous protocols", () => {
    expect(parseSafeUrl("file:///etc/passwd")).toBeNull()
    expect(parseSafeUrl("javascript:alert(1)")).toBeNull()
    expect(parseSafeUrl("data:text/html,<script>")).toBeNull()
    expect(parseSafeUrl("vbscript:msgbox")).toBeNull()
    expect(parseSafeUrl("chrome://settings")).toBeNull()
  })

  test("rejects malformed input", () => {
    expect(parseSafeUrl("")).toBeNull()
    expect(parseSafeUrl("not a url")).toBeNull()
    expect(parseSafeUrl(null as unknown as string)).toBeNull()
  })

  test("preserves query strings with shell metacharacters", () => {
    const url = parseSafeUrl("https://example.com/?a=1&b=2;rm")
    expect(url?.href).toBe("https://example.com/?a=1&b=2;rm")
  })
})

describe("openCommand", () => {
  test("darwin → open", () => {
    expect(openCommand("darwin")).toEqual({ command: "open", args: [] })
  })

  test("win32 → explorer.exe (not cmd /c start)", () => {
    expect(openCommand("win32")).toEqual({ command: "explorer.exe", args: [] })
  })

  test("linux + BSDs → xdg-open", () => {
    for (const p of ["linux", "freebsd", "openbsd", "netbsd", "dragonfly"]) {
      expect(openCommand(p)).toEqual({ command: "xdg-open", args: [] })
    }
  })

  test("unknown platform → null", () => {
    expect(openCommand("aix")).toBeNull()
    expect(openCommand("sunos")).toBeNull()
    expect(openCommand("cygwin")).toBeNull()
  })
})

describe("openUrl", () => {
  test("valid https on linux → spawns xdg-open with argv (no shell)", () => {
    const s = makeSpawn("linux")
    expect(openUrl("https://example.com/path", s)).toBe(true)
    expect(s.calls).toEqual([{ command: "xdg-open", args: ["https://example.com/path"] }])
  })

  test("darwin → open", () => {
    const s = makeSpawn("darwin")
    expect(openUrl("https://example.com", s)).toBe(true)
    expect(s.calls[0].command).toBe("open")
  })

  test("win32 → explorer.exe", () => {
    const s = makeSpawn("win32")
    expect(openUrl("https://example.com", s)).toBe(true)
    expect(s.calls[0].command).toBe("explorer.exe")
  })

  test("rejects file:// without spawning", () => {
    const s = makeSpawn("linux")
    expect(openUrl("file:///etc/passwd", s)).toBe(false)
    expect(s.calls).toEqual([])
  })

  test("rejects javascript: without spawning", () => {
    const s = makeSpawn("linux")
    expect(openUrl("javascript:alert(1)", s)).toBe(false)
    expect(s.calls).toEqual([])
  })

  test("rejects data: without spawning", () => {
    const s = makeSpawn("linux")
    expect(openUrl("data:text/html,<script>alert(1)</script>", s)).toBe(false)
    expect(s.calls).toEqual([])
  })

  test("unknown platform → no spawn, returns false", () => {
    const s = makeSpawn("aix")
    expect(openUrl("https://example.com", s)).toBe(false)
    expect(s.calls).toEqual([])
  })

  test("synchronous opener failure reaches the caller unchanged", () => {
    const s = makeSpawn("linux", { throws: true })
    expect(() => openUrl("https://example.com", s)).toThrow("EINVAL")
  })

  test("shell metacharacters in URL pass through argv unescaped", () => {
    const s = makeSpawn("linux")
    // No spaces — URL normalization percent-encodes them, which is fine
    // but would confuse the assertion. Metacharacters like ;&`$|<> are
    // preserved verbatim by URL parsing in the query string.
    const url = "https://example.com/?a=1&b=;`$|"
    expect(openUrl(url, s)).toBe(true)
    // The URL lands as a single argv entry — the shell never sees it.
    expect(s.calls[0].args).toHaveLength(1)
    expect(s.calls[0].args[0]).toBe(url)
  })

  test("asynchronous opener failure is not hidden", () => {
    const s = makeSpawn("linux")
    openUrl("https://example.com", s)
    const child = s.child()
    expect(child).not.toBeNull()
    expect(child!.unrefed).toBe(true)
    expect(() => child!.emit("error", new Error("opener missing"))).toThrow("opener missing")
  })

})
