import type { GatewayEvent } from "../src/context/wire"

const info = { model: "fake/model", version: "0.0-fake", cwd: "/tmp", usage: { input: 0, output: 0, total: 0 } }
const turns = Number(process.env.FAKEGW_TURNS ?? 0)
const size = Number(process.env.FAKEGW_REPLY_SIZE ?? 730)
const paragraph = "A bounded transcript keeps the current reply visible while older messages remain available on scroll. **Markdown** and `inline code` exercise the text renderer.\n\n"
const reply = (n: number) => {
  const head = `## Reply ${n}\n\n`
  const tail = `\n\n\`\`\`ts\nconst turn = ${n}\nconsole.log(turn)\n\`\`\`\n\nLOAD_DONE_${n}`
  return head + paragraph.repeat(Math.ceil(size / paragraph.length)).slice(0, Math.max(0, size - head.length - tail.length)) + tail
}
let sent = 0
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.FAKEGW_PORT ?? 18765),
  fetch(req, server) { return server.upgrade(req) ? undefined : new Response(null, { status: 400 }) },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } })) },
    message(ws, data) {
      const frame = JSON.parse(String(data))
      if (!frame.method || frame.id === undefined) return
      const event = (params: GatewayEvent) => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { session_id: "fake-sid", ...params } }))
      const session = ["session.create", "session.resume", "session.activate"].includes(frame.method)
      const result = session ? { session_id: "fake-sid", info } : frame.method === "commands.catalog" ? { pairs: [], commands: [] } : {}
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }))
      if (session) event({ type: "session.info", payload: info })
      if (turns > sent && frame.method === "prompt.submit") {
        const text = reply(++sent)
        setTimeout(() => {
          event({ type: "message.start" })
          event({ type: "message.delta", payload: { text } })
          event({ type: "message.complete", payload: { text } })
        }, 5)
      }
    },
  },
})
console.log(`Fake dashboard WebSocket listening on ${server.url}`)
