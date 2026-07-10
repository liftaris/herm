#!/usr/bin/env bun
// Build the published artifact. Output: dist/ — a self-contained bundle
// plus the tree-sitter worker + wasm grammars. The only runtime deps
// are the platform-native `@opentui/core-<os>-<arch>` packages, which
// ship as optionalDependencies so npm/bun installs the matching one.
//
//   dist/
//     index.js                  — entry, shebang'd
//     parser.worker.js          — tree-sitter worker (bundled, web-tree-sitter inlined)
//     *.wasm / *.scm            — emitted by bun build's `with { type: "file" }` assets
//
// Bun emits `import X with {type:"file"}` assets as the literal string
// "./name-hash.ext". Those end up in emscripten's locateFile (cwd-relative
// fs.readFile) and opentui's resolvePath (path.resolve against cwd) — both
// break when herm is launched from any dir that isn't dist/. Post-build we
// rewrite each of those literals to `import.meta.dirname + "/name-hash.ext"`
// so they're absolute at runtime regardless of cwd.

import { $ } from "bun"
import { rmSync, chmodSync } from "node:fs"
import pkg from "../package.json" with { type: "json" }

rmSync("dist", { recursive: true, force: true })

// react-devtools-core is a lazy peer of @opentui/react (DEV=true only),
// but bun hoists its static import outside the __esm wrapper. Stub it at
// resolve time so the published bundle carries no dep on it.
const noopDevtools: import("bun").BunPlugin = {
  name: "noop-devtools",
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () =>
      ({ path: "rdc-stub", namespace: "stub" }))
    b.onLoad({ filter: /^rdc-stub$/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} }",
      loader: "js",
    }))
  },
}

// @opentui/react's bundle calls jsxDEV from react/jsx-dev-runtime, which
// is `undefined` under NODE_ENV=production. Alias it to prod `jsx`
// (jsx === jsxs in React 19 prod, so isStaticChildren is moot).
const jsxDevShim: import("bun").BunPlugin = {
  name: "jsx-dev-shim",
  setup(b) {
    b.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () =>
      ({ path: "jsx-dev-shim", namespace: "stub" }))
    b.onLoad({ filter: /^jsx-dev-shim$/, namespace: "stub" }, () => ({
      contents: `
        import { jsx, jsxs, Fragment } from "react/jsx-runtime"
        export { jsx, jsxs, Fragment }
        export var jsxDEV = jsx
      `,
      loader: "js",
    }))
  },
}

const external = [
  // Dynamic `@opentui/core-${platform}-${arch}` — resolved at runtime
  // against the installed optionalDependency. Kept out of the bundle.
  "@opentui/core-*",
  // `ws` is only reached by the devtools chunk above; harmless to
  // external (globalThis.WebSocket exists under bun anyway).
  "ws",
]

const result = await Bun.build({
  entrypoints: [
    "src/index.tsx",
    "src/io/db.worker.ts",
    "src/io/kanban.worker.ts",
    "node_modules/@opentui/core/parser.worker.js",
  ],
  outdir: "dist",
  target: "bun",
  naming: { entry: "[name].[ext]" },
  minify: { whitespace: true, syntax: true, identifiers: false },
  sourcemap: "none",
  external,
  plugins: [noopDevtools, jsxDevShim],
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.DEV": '"false"',
  },
})

if (!result.success) {
  for (const m of result.logs) console.error(m)
  process.exit(1)
}

const assets = result.outputs
  .filter(o => o.kind === "asset")
  .map(o => o.path.replace(/^.*\/dist\//, ""))
const assetRe = new RegExp(`"\\.\\/(${assets.map(a =>
  a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})"`, "g")
for (const out of result.outputs.filter(o => o.kind === "entry-point")) {
  const src = await Bun.file(out.path).text()
  await Bun.write(out.path, src.replace(assetRe, 'import.meta.dirname+"/$1"'))
}
chmodSync("dist/index.js", 0o755)

// Node-shebang'd launcher lives beside dist/ so npm's cmd-shim emits a
// node.exe-invoking .ps1; the launcher then finds bun itself.
await $`mkdir -p dist/bin && cp bin/herm.cjs dist/bin/`
chmodSync("dist/bin/herm.cjs", 0o755)

// The published package is dist/ + this manifest. `dependencies` is
// empty — everything is bundled. Platform libs are optionals (bun/npm
// install the one that matches, skip the rest).
const platforms = [
  "darwin-arm64", "darwin-x64",
  "linux-arm64", "linux-x64",
  "win32-arm64", "win32-x64",
]
const ov = (pkg.dependencies as Record<string, string>)["@opentui/core"]
await Bun.write("dist/package.json", JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  engines: pkg.engines,
  publishConfig: { access: "public", provenance: true },
  bin: { herm: "bin/herm.cjs" },
  optionalDependencies: Object.fromEntries(
    platforms.map(p => [`@opentui/core-${p}`, ov]),
  ),
}, null, 2) + "\n")

await $`cp README.md LICENSE dist/`
// Runtime dynamic-import assets. Bun does not include variable imports
// like import(`./themes/${name}.json`) in the bundle, so the published
// package must ship the JSON bodies beside index.js.
await $`cp -r src/theme/themes dist/themes`
// Runtime fs-read assets (eikon avatars). These aren't `with {type:
// "file"}` imports — listEikons() readdirs the directory — so the
// directory has to ship alongside index.js. bundled.ts resolves it
// by walking up from import.meta.dir, which in the bundle is dist/.
await $`cp -r assets dist/`

const sizes = result.outputs
  .map(o => [o.path.replace(/^.*\/dist\//, ""), (o.size / 1024).toFixed(0) + " KB"])
console.table(Object.fromEntries(sizes))
console.log(`\nbuild: dist/ ready (${result.outputs.length} files)`)
