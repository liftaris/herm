import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { filter, matchSub, resolve, sort, LOCAL_COMMANDS, LOCAL_NAMES, type SlashCommand } from "../src/app/slashCommands"
import { replaceSlashToken, slashTokenAt } from "../src/app/useSlashPopover"

const cmd = (over: Partial<SlashCommand>): SlashCommand => ({
  name: "x", description: "", category: "Session", aliases: [], argsHint: "",
  subcommands: [], source: "command", target: "gateway", ...over,
})

describe("slash", () => {
  test("filter matches name and alias by prefix, case-insensitive", () => {
    const list = [cmd({ name: "model" }), cmd({ name: "memory", aliases: ["mem"] })]
    expect(filter(list, "mo").map(c => c.name)).toEqual(["model"])
    expect(filter(list, "MEM").map(c => c.name)).toEqual(["memory"])
    expect(filter(list, "")).toHaveLength(2)
  })

  test("matchSub returns synthetic entries for declared subcommands", () => {
    const list = [cmd({ name: "reasoning", subcommands: ["high", "low", "none"] })]
    const r = matchSub(list, "/reasoning h")
    expect(r?.map(c => c.name)).toEqual(["reasoning high"])
    expect(matchSub(list, "/reasoning ")).toHaveLength(3)
    expect(matchSub(list, "/unknown x")).toBeNull()
    expect(matchSub([cmd({ name: "foo" })], "/foo x")).toBeNull() // no subcommands
  })

  test("sort orders by CATEGORY_ORDER then name", () => {
    const r = sort([
      cmd({ name: "b", category: "Info" }),
      cmd({ name: "a", category: "Client" }),
      cmd({ name: "c", category: "Client" }),
    ])
    expect(r.map(c => c.name)).toEqual(["a", "c", "b"])
  })

  test("LOCAL_COMMANDS includes local fallbacks for queue and quit aliases", () => {
    const queue = LOCAL_COMMANDS.find(c => c.name === "queue")
    const quit = LOCAL_COMMANDS.find(c => c.name === "quit")
    expect(queue?.aliases).toContain("q")
    expect(quit?.aliases).toContain("exit")
    expect(quit?.aliases).not.toContain("q")
    expect(resolve(LOCAL_COMMANDS, "q")).toMatchObject({ hit: { name: "queue" } })
  })

  // Parity guard — every `case "x"` in app/slash.tsx must be in
  // LOCAL_NAMES, otherwise the gateway catalog tags it target:"gateway"
  // and the handler is unreachable.
  test("LOCAL_NAMES ⊇ slash() switch cases", () => {
    const src = readFileSync(new URL("../src/app/slash.tsx", import.meta.url), "utf8")
    const body = src.slice(src.indexOf("const run = useCallback"),
                           src.indexOf('if (c.target !== "gateway"'))
    const cases = [...body.matchAll(/case "([a-z-]+)":/g)].map(m => m[1])
    expect(cases.length).toBeGreaterThan(20)
    const missing = cases.filter(n => !LOCAL_NAMES.has(n))
    expect(missing).toEqual([])
  })

  test("LOCAL_NAMES covers session-mutating commands", () => {
    for (const n of ["resume", "branch", "compress", "undo", "retry", "model",
                     "quit", "copy", "paste", "image", "background", "voice",
                     "mouse", "redraw", "save", "browser"])
      expect(LOCAL_NAMES.has(n)).toBe(true)
  })

  test("slashTokenAt finds command tokens under cursor and rejects paths", () => {
    expect(slashTokenAt("please /cl now", 9)).toEqual({ text: "/cl", query: "cl", start: 7, end: 10, whole: false })
    expect(slashTokenAt("line one\ntry /new later", 16)).toEqual({ text: "/new", query: "new", start: 13, end: 17, whole: false })
    expect(slashTokenAt("/clear")).toEqual({ text: "/clear", query: "clear", start: 0, end: 6, whole: true })
    expect(slashTokenAt("/voice o")).toEqual({ text: "/voice o", query: "voice o", start: 0, end: 8, whole: true })
    expect(slashTokenAt("/tmp/file")).toBeNull()
    expect(slashTokenAt("https://host/path")).toBeNull()
    expect(slashTokenAt("see [label](/clear)")).toBeNull()
    expect(slashTokenAt("see [/clear]")).toBeNull()
  })

  test("replaceSlashToken preserves prefix and suffix", () => {
    const spot = slashTokenAt("please /cl now", 9)!
    expect(replaceSlashToken("please /cl now", spot, cmd({ name: "clear" }))).toBe("please /clear now")
  })

  describe("resolve", () => {
    const list = [
      cmd({ name: "status" }),
      cmd({ name: "statusbar" }),
      cmd({ name: "help", aliases: ["h", "?"] }),
      cmd({ name: "history" }),
      cmd({ name: "new", aliases: ["reset"] }),
    ]
    const hit = (n: string) => {
      const r = resolve(list, n)
      return "hit" in r ? r.hit.name : r
    }

    test("exact name beats longer prefix sibling", () => {
      expect(hit("status")).toBe("status")
      expect(hit("statusbar")).toBe("statusbar")
    })
    test("exact alias wins even when prefix of other names", () => {
      // `h` is an exact alias of help, and a prefix of history — help wins.
      expect(hit("h")).toBe("help")
    })
    test("unique prefix resolves", () => {
      expect(hit("statu")).toEqual({ ambiguous: ["/status", "/statusbar"] })
      expect(hit("statusb")).toBe("statusbar")
      expect(hit("Re")).toBe("new")   // via alias "reset", case-insensitive
    })
    test("ambiguous and miss", () => {
      const r = resolve(list, "hi")
      expect("hit" in r && r.hit.name).toBe("history")
      expect(resolve(list, "zzz")).toEqual({ miss: true })
    })
  })
})
