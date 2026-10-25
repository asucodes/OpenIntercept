import path from "node:path"
import os from "node:os"
import { AuditLog } from "./audit"
import { NetworkProxy } from "./network-proxy"
import { buildApp } from "./routes"
import { Store } from "./store"

const root = path.resolve(import.meta.dir, "../../..")
const dataDir = path.join(root, "data")
const port = Number(process.env.OPENINTERCEPT_PORT ?? 7474)
const hostname = process.env.OPENINTERCEPT_HOST ?? "127.0.0.1" // local only, never 0.0.0.0
const proxyPort = Number(process.env.OPENINTERCEPT_PROXY_PORT ?? 7475)

const store = await Store.load(path.join(dataDir, "state.json"))
const audit = await AuditLog.open(dataDir)

const networkProxy = new NetworkProxy((exchange) => {
  if (!store.networkProxyEnabled) return
  const saved = store.observeTraffic(exchange)
  audit.log({ type: "traffic.exchange", exchange: saved })
}, proxyPort)

if (store.networkProxyEnabled) {
  try {
    await networkProxy.start()
  } catch (error) {
    store.networkProxyEnabled = false
    console.error("[openintercept] persisted network proxy could not start:", error)
  }
}

const app = buildApp({
  store,
  audit,
  dataDir,
  appVersion: "0.1.0",
  panelDir: path.join(root, "panel"),
  pluginSource: path.join(root, "packages", "plugin", "src", "openintercept.plugin.ts"),
  // OpenCode reads its global config from ~/.config/opencode even on Windows
  // (verified in the v1.19.4 boot log), so this is the "all projects" folder.
  pluginsDir: () => path.join(os.homedir(), ".config", "opencode", "plugins"),
  networkProxy,
})

const server = Bun.serve({
  port,
  hostname,
  // held requests sit idle while waiting for a human; 255s is Bun's max
  idleTimeout: 255,
  fetch: app.fetch,
})

console.log(`[openintercept] panel  → http://${server.hostname}:${server.port}`)
console.log(`[openintercept] audit  → ${path.join(dataDir, "audit.jsonl")}`)
console.log(
  `[openintercept] network proxy ${networkProxy.status.running ? "ON" : "off"} → http://${networkProxy.status.host}:${networkProxy.status.port}`,
)
console.log(`[openintercept] intercept ${store.enabled ? "ON" : "OFF"} · ${store.profile.rules.length} rule(s) · profile "${store.profile.name}"`)
console.log(`[openintercept] local only · no telemetry · v0.1.0`)

async function shutdown() {
  try {
    await networkProxy.stop()
  } catch {
    // already stopped
  }
  process.exit(0)
}

process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
