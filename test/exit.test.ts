import { describe, expect, it } from "bun:test"
import { quit } from "../src/app/exit"

describe("quit()", () => {
  it("waits for terminal restoration before exiting, even on repeated quit", async () => {
    const steps: string[] = []
    const closed = Promise.withResolvers<void>()
    const gw = { kill: () => { steps.push("kill") } }
    const renderer = {
      closed: closed.promise,
      destroy: () => { steps.push("destroy") },
      setTerminalTitle: (title: string) => {
        expect(title).toBe("")
        steps.push("title")
      },
    }
    const exit = (code: number) => {
      expect(code).toBe(0)
      steps.push("exit")
    }

    const pending = quit(renderer, undefined, undefined, gw, exit)
    await quit(renderer, undefined, undefined, gw, exit)
    expect(steps).toEqual(["kill", "title", "destroy"])
    closed.resolve()
    await pending
    expect(steps).toEqual(["kill", "title", "destroy", "exit"])
  })
})
