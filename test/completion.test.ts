import { describe, expect, test } from "bun:test"
import { acceptCompletion, completionRequest } from "../src/app/useCompletion"

describe("composer completion request", () => {
  test("whole-buffer slash popover owns slash-like input", () => {
    expect(completionRequest("/help")).toBeNull()
  })

  test("does not treat absolute paths as slash commands", () => {
    expect(completionRequest("/home/kaio/Dev/herm/src/app.tsx")).toEqual({
      method: "complete.path",
      params: { word: "/home/kaio/Dev/herm/src/app.tsx" },
      replaceFrom: 0,
      replaceTo: 31,
    })
  })

  test("routes trailing path tokens through complete.path", () => {
    expect(completionRequest("read src/app")).toEqual({
      method: "complete.path",
      params: { word: "src/app" },
      replaceFrom: 5,
      replaceTo: 12,
    })
  })

  test("leaves plain prose alone", () => {
    expect(completionRequest("read the source")).toBeNull()
  })

  test("acceptance replaces only the completion token", () => {
    expect(acceptCompletion("read src/app", { text: "src/app.tsx", display: "app.tsx", meta: "file" }, 5))
      .toBe("read src/app.tsx ")
  })

  test("acceptance preserves suffix", () => {
    expect(acceptCompletion("read src/app now", { text: "src/app.tsx", display: "app.tsx", meta: "file" }, 5, 12))
      .toBe("read src/app.tsx now")
  })

  test("acceptance avoids duplicating slash command prefixes", () => {
    expect(acceptCompletion("/det", { text: "/details", display: "/details", meta: "command" }, 1))
      .toBe("/details ")
    expect(acceptCompletion("please /det now", { text: "/details", display: "/details", meta: "command" }, 8, 11))
      .toBe("please /details now")
  })

  test("acceptance preserves prompt toolkit slash command items", () => {
    expect(acceptCompletion("/go", { text: "goal", display: "goal", meta: "command" }, 1))
      .toBe("/goal ")
  })
})
