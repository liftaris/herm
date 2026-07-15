import { describe, expect, it, spyOn } from "bun:test"
import * as exit from "../src/app/exit"

describe("quit()", () => {
  it("kills gateway, resets title, destroys renderer in order before exit", () => {
    const steps: string[] = []
    const gw = { kill: () => steps.push("kill") }
    const renderer = {
      destroy: () => steps.push("destroy"),
      setTerminalTitle: (t: string) => {
        expect(t).toBe("")
        steps.push("title")
      },
    }

    const stop = spyOn(process, "exit").mockImplementation((() => {
      steps.push("exit")
      throw new Error("process.exit")
    }) as typeof process.exit)

    try {
      expect(() => exit.quit(renderer, undefined, undefined, gw)).toThrow("process.exit")
      expect(steps).toEqual(["kill", "title", "destroy", "exit"])
    } finally {
      stop.mockRestore()
    }
  })
})
