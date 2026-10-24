import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { App } from "../src/app"
import { GatewayClient } from "../src/context/gateway-client"
import { mountNode, until } from "./harness"
import { tmpHome } from "./fixture/home"
import { owner } from "./fixture/owner"

test("an ensure refusal is visible in the disconnected transcript without hiding its state or reason", async () => {
  await using home = await tmpHome()
  const previous = process.env.HERM_HERMES_BIN
  const url = process.env.HERM_GATEWAY_URL
  const bin = join(home.path, "hermes")
  writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"incompatible\",\"reason_code\":\"runtime_protocol\",\"detail\":\"update required\"}'\nexit 3\n", { mode: 0o700 })
  process.env.HERM_HERMES_BIN = bin
  delete process.env.HERM_GATEWAY_URL
  const client = new GatewayClient()
  try {
    await using t = await mountNode(<App gateway={client} launch={{ mode: "new", splash: false }} />)
    await until(t, () => t.frame().includes("gateway incompatible: runtime_protocol: update required"))
    expect(client.ready).toBe(false)
    expect(t.frame()).not.toContain("Connected to Hermes")
  } finally {
    client.kill()
    if (previous === undefined) delete process.env.HERM_HERMES_BIN
    else process.env.HERM_HERMES_BIN = previous
    if (url === undefined) delete process.env.HERM_GATEWAY_URL
    else process.env.HERM_GATEWAY_URL = url
  }
})

test("the shell paints before owner readiness and accepts nullable snapshot metadata", async () => {
  await using home = await tmpHome()
  await using backend = await owner({ ready: false })
  const previous = process.env.HERMES_HOME
  process.env.HERMES_HOME = backend.home
  const client = new GatewayClient()
  try {
    await using t = await mountNode(<App gateway={client} launch={{ mode: "new", splash: false }} />)
    await until(t, () => backend.dials.length === 1 && t.frame().includes("Message Hermes"))
    expect(client.ready).toBe(false)
    backend.send({ method: "event", params: { type: "gateway.ready" } })
    await until(t, () => t.frame().includes("Ready"))
    expect(t.frame()).toContain("fake/model")
    expect(t.frame()).not.toContain("TypeError")
  } finally {
    client.kill()
    if (previous === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = previous
  }
})
