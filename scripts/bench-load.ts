import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { loadavg } from "node:os"

const root = await mkdtemp("/home/kaio/.cache/herm-test-tmp/load-")
const env = { ...process.env, HOME: root, HERMES_HOME: join(root, "hermes"), HERMES_AGENT_ROOT: join(root, "backend"), HERM_CONFIG_DIR: join(root, "config"), TMPDIR: root }
await Promise.all(["hermes", "backend", "config"].map(dir => mkdir(join(root, dir))))
const build = Bun.spawn([process.execPath, "run", "build"], { env, stdout: "ignore", stderr: "inherit" })
if (await build.exited) throw new Error("build failed")
const port = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const controlPort = port.port
const control = `http://127.0.0.1:${controlPort}`
port.stop(true)
const fake = Bun.spawn([process.execPath, "scripts/owner-attach-fake.ts"], { env: { ...env, FAKEGW_PORT: "0", FAKEGW_TURNS: "100" }, stdout: "pipe", stderr: "inherit" })
const reader = fake.stdout.getReader()
const line = new TextDecoder().decode((await reader.read()).value)
const url = line.match(/http:\/\/[^\s]+/)?.[0]?.replace("http:", "ws:")
if (!url) { fake.kill(); throw new Error(`fake did not start: ${line}`) }
const start = performance.now()
let paint: number | undefined
let bytes = 0
let output = ""
const painted = new Set<number>()
const terminal = new Bun.Terminal({
  cols: 200, rows: 50,
  data(term, data) {
    bytes += data.byteLength
    output = (output + new TextDecoder().decode(data)).slice(-100_000)
    if (paint === undefined && output.includes("Chat") && output.includes("Sessions")) paint = performance.now() - start
    for (const match of output.matchAll(/LOAD_DONE_(\d+)_END/g)) painted.add(Number(match[1]))
    const text = new TextDecoder().decode(data)
    if (text.includes("\x1b[6n")) term.write("\x1b[1;1R")
    if (text.includes("\x1b[c") || text.includes("\x1b[0c")) term.write("\x1b[?1;2c")
    if (text.includes("\x1b[>q")) term.write("\x1bP>|bench-terminal\x1b\\")
    if (text.includes("\x1b[?u")) term.write("\x1b[?0u")
    if (text.includes("\x1b]10;?")) term.write("\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
    if (text.includes("\x1b]11;?")) term.write("\x1b]11;rgb:0000/0000/0000\x1b\\")
  },
})
const app = Bun.spawn([process.execPath, "dist/index.js", "--no-splash", "--gateway-url", url], { terminal, env: { ...env, CONTROL: "1", CONTROL_PORT: String(controlPort), TERM: "xterm-256color", COLORTERM: "truecolor" } })
const ticks = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim())
const stat = async () => {
  const text = await Bun.file(`/proc/${app.pid}/stat`).text()
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
  const status = await Bun.file(`/proc/${app.pid}/status`).text()
  return { cpu: Number(fields[11]) + Number(fields[12]), rss: Number(status.match(/VmRSS:\s+(\d+)/)?.[1]) / 1024 }
}
const request = async (path: string, body?: object) => {
  const res = await fetch(control + path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(500) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 400)}`)
  return res
}
const status = async () => await (await request("/status")).json() as { ready: boolean; streaming: boolean; messages: number; heap: number }
const wait = async (fn: () => Promise<boolean>, timeout = 10_000) => {
  const end = performance.now() + timeout
  while (!await fn()) {
    if (performance.now() > end) throw new Error(`load wait timed out: ${JSON.stringify(await status())}\n${await (await request("/frame")).text()}`)
    await Bun.sleep(2)
  }
}
const idle = async () => {
  const before = await stat()
  const time = performance.now()
  await Bun.sleep(10_000)
  const after = await stat()
  return { rss_mb: after.rss, cpu_percent: (after.cpu - before.cpu) / ticks / ((performance.now() - time) / 1000) * 100 }
}
try {
  await wait(async () => {
    if (app.exitCode !== null) throw new Error(`Herm exited ${app.exitCode}\n${output}`)
    try {
      const res = await fetch(control + "/status", { signal: AbortSignal.timeout(500) })
      if (res.status === 503) return false
      if (!res.ok) throw new Error(`startup status: ${res.status}`)
      return (await res.json() as { ready: boolean }).ready && paint !== undefined
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ECONNREFUSED") return false
      throw err
    }
  })
  const before = await idle()
  const initial = (await status()).messages
  const times: number[] = []
  for (let n = 1; n <= 100; n++) {
    const time = performance.now()
    await request("/send", { message: `load-user-${n}` })
    await wait(async () => {
      const s = await status()
      return !s.streaming && s.messages === initial + n * 2 && painted.has(n)
    })
    times.push(performance.now() - time)
  }
  const loaded = await stat()
  const state = await status()
  const nodes = await (await request("/focus")).json() as { counts: { total: number } }
  const after = await idle()
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
  console.log(JSON.stringify({ first_paint_ms: paint, before, loaded_rss_mb: loaded.rss, heap_mb: state.heap, messages: state.messages, injected_messages: 200, mounted_nodes: nodes.counts.total, first_10_turn_ms: mean(times.slice(0, 10)), last_10_turn_ms: mean(times.slice(-10)), after, load_average: loadavg(), terminal_bytes: bytes, painted_turns: painted.size, errors: 0 }))
} finally {
  app.kill("SIGKILL")
  fake.kill("SIGKILL")
  await Promise.all([app.exited, fake.exited])
  terminal.close()
  await rm(root, { recursive: true, force: true })
}
