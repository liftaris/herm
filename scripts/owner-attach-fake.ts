const info = { model: "fake/model", version: "0.0-fake", cwd: "/tmp", usage: { input: 0, output: 0, total: 0 } }
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.FAKEGW_PORT || 18765),
  fetch(req, server) { return server.upgrade(req) ? undefined : new Response(null, { status: 400 }) },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } })) },
    message(ws, data) {
      const frame = JSON.parse(String(data))
      if (!frame.method || frame.id === undefined) return
      const session = ["session.create", "session.resume", "session.activate"].includes(frame.method)
      const result = session ? { session_id: "fake-sid", info } : frame.method === "commands.catalog" ? { pairs: [], commands: [] } : {}
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }))
      if (session) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "session.info", session_id: "fake-sid", payload: info } }))
    },
  },
})
console.log(`Fake dashboard WebSocket listening on ${server.url}`)
