import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { shouldUseNativeClipboard } from "../src/utils/clipboard"
import { tmpHome } from "./fixture/home"


function tool(root: string, name: string, body: string) {
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
  return bin
}

test("native clipboard failure reports stderr and never shows success", async () => {
  await using h = await tmpHome()
  const bin = tool(h.root, process.platform === "darwin" ? "pbcopy" : "xclip", 'printf "clipboard device denied" >&2; exit 7')
  const file = Bun.resolveSync("../src/utils/clipboard.ts", import.meta.dir)
  const proc = Bun.spawn([process.execPath, "--eval", `
    process.stdout.isTTY = false;
    const c = await import(${JSON.stringify(file)});
    const deadline = setTimeout(() => { console.error("clipboard error callback missing"); process.exit(17) }, 2000);
    let error;
    try { await c.copyText("test") } catch (err) { error = err.message }
    const messages = [], errors = [];
    const done = Promise.withResolvers();
    const toast = { show: o => messages.push(o), clear: () => {}, error: e => { errors.push(e.message); if (errors.length === 2) done.resolve() } };
    await c.copyText("test", toast);
    let cleared = false;
    c.copySelection({ getSelection: () => ({ getSelectedText: () => "test" }), clearSelection: () => { cleared = true } }, toast);
    await done.promise;
    clearTimeout(deadline);
    console.log(JSON.stringify({ error, messages, errors, cleared }));
  `], {
    env: { ...process.env, HOME: h.root, HERMES_HOME: h.path, HERMES_AGENT_ROOT: join(h.root, "agent"), PATH: bin, SSH_CONNECTION: "", WAYLAND_DISPLAY: "" },
    stdout: "pipe", stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  expect(await proc.exited).toBe(0)
  expect(err).toBe("")
  expect(JSON.parse(out)).toEqual({
    error: "clipboard device denied", messages: [],
    errors: ["clipboard device denied", "clipboard device denied"], cleared: true,
  })
})

test("Ghostty writes OSC 52 without racing wl-copy and multiplexers keep native selection", async () => {
  await using h = await tmpHome()
  const marker = join(h.root, "native-called")
  const bin = tool(h.root, "wl-copy", `printf called > '${marker}'`)
  const file = Bun.resolveSync("../src/utils/clipboard.ts", import.meta.dir)
  const proc = Bun.spawn([process.execPath, "--eval", `process.stdout.isTTY = true; const c = await import(${JSON.stringify(file)}); await c.copy("race-free")`], {
    env: {
      ...process.env,
      HOME: h.root,
      HERMES_HOME: h.path,
      HERMES_AGENT_ROOT: join(h.root, "agent"),
      PATH: bin,
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      CURSOR_TRACE_ID: "",
      SSH_CONNECTION: "",
      TMUX: "",
      STY: "",
      WAYLAND_DISPLAY: "test-wayland",
    },
    stdout: "pipe", stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  expect(await proc.exited).toBe(0)
  expect(err).toBe("")
  expect(out).toBe(`\x1b]52;c;${Buffer.from("race-free").toString("base64")}\x07`)
  expect(existsSync(marker)).toBe(false)
  expect(shouldUseNativeClipboard({ TMUX: "tmux" }, "ghostty")).toBe(true)
  expect(shouldUseNativeClipboard({ SSH_CONNECTION: "remote" }, "ghostty")).toBe(false)
})
