/**
 * Install the OpenIntercept plugin into a project (or the global config dir).
 *
 *   bun scripts/install-plugin.ts ./your-project   → that project
 *   bun scripts/install-plugin.ts --global          → ~/.config/opencode
 *
 * The plugin is a single dependency-free file — installation is a copy.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const arg = process.argv[2]
if (!arg) {
  console.error("usage: bun scripts/install-plugin.ts <project-path> | --global")
  process.exit(1)
}
const source = path.resolve(import.meta.dir, "../packages/plugin/src/openintercept.plugin.ts")

let targetDir: string
if (arg === "--global") {
  targetDir = path.join(process.env.APPDATA ?? path.join(process.env.USERHOME ?? "~", ".config"), "opencode", "plugins")
} else {
  targetDir = path.join(path.resolve(arg), ".opencode", "plugins")
}

await mkdir(targetDir, { recursive: true })

// The global folder serves the V2 desktop engine — the V1 variant's failed
// loads there poison the engine's plugin rebuilds, so --global installs the
// V2 variant only. Project installs get both (the CLI is V1).
const text = await Bun.file(source).text()
const marker = "export default OpenIntercept"
if (!text.includes(marker)) throw new Error("plugin source is missing the V1 default export marker")
const v2 = text.replace(marker, `export default { id: (OpenIntercept as any).id, setup: (OpenIntercept as any).setup }`)
await writeFile(path.join(targetDir, "openintercept-v2.ts"), v2, "utf8")
if (arg !== "--global") {
  await writeFile(path.join(targetDir, "openintercept.ts"), text, "utf8")
}
console.log(`[openintercept] plugin installed → ${targetDir}${arg === "--global" ? " (openintercept-v2.ts — desktop engine)" : "{openintercept.ts,openintercept-v2.ts}"}`)
console.log(`[openintercept] make sure the sidecar is running: bun run server  (panel http://127.0.0.1:7474)`)
