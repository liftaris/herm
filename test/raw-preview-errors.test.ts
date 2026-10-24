import { expect, test } from "bun:test"
import { join } from "node:path"
import { tmpHome } from "./fixture/home"

for (const name of ["EikonGallery", "EikonStudio"]) {
  test(`${name} reports a malformed runtime instead of a blank preview`, async () => {
    await using h = await tmpHome({ files: {
      "eikons/broken/broken.eikon": JSON.stringify({
        type: "header", eikon: 1, id: "broken", size: { cols: 1, rows: 1 },
        defaultSignal: "state.idle", signals: { "state.idle": { clip: "idle" } },
      }) + "\n" + JSON.stringify({ type: "clip", name: "idle", fps: 1, frameCount: 1 }) + "\n" + JSON.stringify({ type: "frame", clip: "idle", index: 0, rows: ["."] }) + "\n",
    } })
    const harness = Bun.resolveSync("./harness.tsx", import.meta.dir)
    const component = Bun.resolveSync(`../src/tabs/${name}.tsx`, import.meta.dir)
    const avatar = Bun.resolveSync("../src/components/avatar/eikon.ts", import.meta.dir)
    const service = Bun.resolveSync("../src/service/eikon.ts", import.meta.dir)
    const proc = Bun.spawn([process.execPath, "--eval", `
      const { createElement } = await import("react");
      const { spyOn } = await import("bun:test");
      const fs = await import("node:fs");
      const { mountNode } = await import(${JSON.stringify(harness)});
      const mod = await import(${JSON.stringify(component)});
      const target = ${JSON.stringify(join(h.path, "eikons/broken/broken.eikon"))};
      const corrupt = () => fs.writeFileSync(target, fs.readFileSync(target, "utf8").split("\\n")[0] + "\\n{\\n");
      if (${JSON.stringify(name)} === "EikonGallery") {
        const avatar = await import(${JSON.stringify(avatar)});
        const scan = avatar.listEikons;
        spyOn(avatar, "listEikons").mockImplementation(dirs => { const rows = scan(dirs); if (rows.some(r => r.path === target)) corrupt(); return rows });
      } else {
        const { eikon } = await import(${JSON.stringify(service)});
        const baked = eikon.baked;
        spyOn(eikon, "baked").mockImplementation(name => { const path = baked(name); if (path === target) corrupt(); return path });
      }
      try {
        const t = await mountNode(createElement(mod[${JSON.stringify(name)}], { focused: true, name: "broken" }));

        t.destroy();
        process.exit(0);
      } catch (err) { console.error(err.message); process.exit(17) }
    `], {
      env: { ...process.env, HOME: h.root, HERMES_HOME: h.path, HERMES_AGENT_ROOT: join(h.root, "agent"), HERM_CONFIG_DIR: h.cfg, HERM_IO_INLINE: "1" },
      stdout: "pipe", stderr: "pipe",
    })
    await new Response(proc.stdout).text()
    const error = await new Response(proc.stderr).text()
    await proc.exited
    expect(error).toContain("malformed JSON on line 2: JSON Parse error: Expected '}'")
  })
}
