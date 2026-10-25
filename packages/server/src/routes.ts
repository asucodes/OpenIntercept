import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { access, mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { CallRequest, Decision, Profile, TrafficExchange, firstMatchingRule } from "@openintercept/protocol"
import type { Decision as DecisionT, RuleAction, ToolCall, ToolResult } from "@openintercept/protocol"
import { HoldQueue } from "./holds"
import type { HoldInfo } from "./holds"
import { Store, serializeEntry } from "./store"
import type { AuditLog } from "./audit"

export interface NetworkProxyControl {
  readonly status: { running: boolean; host: string; port: number }
  start(): Promise<{ running: boolean; host: string; port: number }>
  stop(): Promise<void>
}

const BEFORE_ACTIONS = new Set(["run", "replace", "respond", "drop"])
const AFTER_ACTIONS = new Set(["forward", "replace", "drop"])

export interface AppDeps {
  store: Store
  audit: AuditLog
  /** absolute path to the panel directory; null disables static hosting (tests) */
  panelDir: string | null
  /** absolute path to the plugin source file (the single-file OpenCode adapter) */
  pluginSource: string
  /** default global OpenCode plugins directory used by the one-click installer */
  pluginsDir: () => string
  networkProxy?: NetworkProxyControl
  dataDir?: string
  appVersion?: string
  startedAt?: number
}

export function buildApp({
  store,
  audit,
  panelDir,
  pluginSource,
  pluginsDir,
  networkProxy,
  dataDir,
  appVersion = "1.0.0",
  startedAt = Date.now(),
}: AppDeps) {
  const holds = new HoldQueue(
    {
      onHeld: (info) => {
        store.markHeld(info.callId, info.stage, info.key, info.tool)
        audit.log({ type: "call.held", callId: info.callId, stage: info.stage, tool: info.tool })
      },
      onReleased: (info, decision) => {
        // the human path records via /api/decision; the timeout path lands here
        if (decision.by === "timeout") {
          store.markDecided(info.callId, info.stage, decision, info.ruleName, true)
          applyDecision(store, info, decision)
          audit.log({ type: "call.released", callId: info.callId, stage: info.stage, decision })
        }
      },
    },
    () => ({ holdTimeoutMs: store.defaults().holdTimeoutMs, onTimeout: store.defaults().onTimeout }),
  )

  // --- shared decision pipeline ---------------------------------------------

  function evaluate(
    call: ToolCall,
    result: ToolResult | undefined,
  ): { action: RuleAction | "default"; ruleName: string | null } {
    if (store.enabled) {
      const match = firstMatchingRule(call, result, store.profile.rules)
      if (match) return { action: match.rule.action, ruleName: match.rule.name ?? `#${match.index + 1}` }
      if (store.defaults().noRule === "hold") return { action: "hold", ruleName: null }
    }
    return { action: "default", ruleName: null }
  }

  async function resolveStage(
    call: ToolCall,
    result: ToolResult | undefined,
    action: RuleAction | "default",
    ruleName: string | null,
    stage: "before" | "after",
  ): Promise<DecisionT> {
    if (action === "hold") {
      // recording happens in exactly one place per path:
      // /api/decision (human) or the onReleased hook (timeout)
      return await holds.hold({ callId: call.id, stage, tool: call.tool, payload: { call, result }, ruleName })
    }
    if (action === "pass" || action === "default") {
      const reason =
        action === "pass" ? `rule:${ruleName ?? "unnamed"}` : store.enabled ? "no matching rule" : "intercept off"
      const decision: DecisionT = { action: stage === "before" ? "run" : "forward", by: "auto", reason }
      store.markDecided(call.id, stage, decision, ruleName, false)
      return decision
    }
    // rule-level drop: never held, decided automatically
    const decision: DecisionT = { action: "drop", by: "auto", reason: `rule:${ruleName ?? "unnamed"}` }
    store.markDecided(call.id, stage, decision, ruleName, false)
    if (stage === "after") applyDecision(store, { callId: call.id, stage } as HoldInfo, decision)
    audit.log({ type: "call.released", callId: call.id, stage, decision })
    return decision
  }

  /** Reflect a decision's payload into stored history (edits, drops). */
  function applyDecision(store: Store, info: { callId: string; stage: "before" | "after" }, decision: DecisionT) {
    if (info.stage === "before" && decision.action === "replace" && decision.args !== undefined) {
      store.applyArgsEdit(info.callId, decision.args)
    }
    if (info.stage === "after" && decision.action === "replace" && decision.result) {
      store.applyResultEdit(info.callId, decision.result)
    }
    if (info.stage === "after" && decision.action === "drop") {
      store.applyResultEdit(info.callId, { title: "Dropped", output: "", metadata: {} })
    }
  }

  const app = new Hono()

  // --- adapter endpoints (held open until decision) -------------------------

  app.post("/api/before", async (c) => {
    const parsed = CallRequest.parse(await c.req.json())
    if (parsed.kind !== "before") return c.json({ error: "expected kind=before" }, 400)
    const { call } = parsed
    audit.log({ type: "call.observed", stage: "before", call })
    const entry = store.observeBefore(call)

    // idempotent replay: adapter retried after a dropped connection
    if (entry.before && !entry.pendingStage) return c.json({ decision: entry.before.decision })

    const { action, ruleName } = evaluate(call, undefined)
    const decision = await resolveStage(call, undefined, action, ruleName, "before")
    return c.json({ decision })
  })

  app.post("/api/after", async (c) => {
    const parsed = CallRequest.parse(await c.req.json())
    if (parsed.kind !== "after") return c.json({ error: "expected kind=after" }, 400)
    const { call, result, fabricated } = parsed
    audit.log({ type: "call.observed", stage: "after", call })
    store.observeAfter(call, result)

    if (fabricated) {
      // the human already decided this at the before stage ("respond"):
      // record the fabricated result as an applied replace, no hold.
      // `result` is the honest original (real output / error text); the
      // final stored result is the `spoof` payload when present.
      const finalResult = parsed.spoof ?? result
      const decision: DecisionT = { action: "replace", result: finalResult, by: "human", reason: "fabricated" }
      store.markDecided(call.id, "after", decision, null, false)
      store.applyResultEdit(call.id, finalResult)
      audit.log({ type: "call.released", callId: call.id, stage: "after", decision })
      return c.json({ decision })
    }

    // idempotent replay
    const existing = store.get(call.id)?.after
    if (existing?.decision && !store.get(call.id)?.pendingStage) return c.json({ decision: existing.decision })

    const { action, ruleName } = evaluate(call, result)
    const decision = await resolveStage(call, result, action, ruleName, "after")
    return c.json({ decision })
  })

  // --- panel endpoints -------------------------------------------------------

  app.get("/api/holds", (c) => c.json({ holds: holds.list() }))

  app.get("/api/history", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 500) || 500, 1000)
    return c.json({ entries: store.list(limit).map(serializeEntry) })
  })

  app.get("/api/history/:id", (c) => {
    const entry = store.get(c.req.param("id"))
    return entry ? c.json({ entry: serializeEntry(entry) }) : c.json({ error: "not found" }, 404)
  })

  // --- model/network traffic inspection ------------------------------------

  app.get("/api/traffic", (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 500) || 500, 1000)
    return c.json({ exchanges: store.listTraffic(limit) })
  })

  app.get("/api/traffic/settings", (c) =>
    c.json({
      captureModelTraffic: store.captureModelTraffic,
      networkProxyEnabled: store.networkProxyEnabled,
    }),
  )

  app.get("/api/network-proxy/status", (c) =>
    c.json({
      available: !!networkProxy,
      ...(networkProxy?.status ?? { running: false, host: "127.0.0.1", port: 7475 }),
    }),
  )

  app.get("/api/traffic/:id", (c) => {
    const exchange = store.getTraffic(c.req.param("id"))
    return exchange ? c.json({ exchange }) : c.json({ error: "not found" }, 404)
  })

  app.post("/api/traffic", async (c) => {
    const exchange = TrafficExchange.parse(await c.req.json())
    // The network proxy is opt-in; do not collect anything if it is off.
    if (exchange.channel === "network" && !store.networkProxyEnabled) return c.json({ ok: true, ignored: true })
    if (exchange.channel === "model" && !store.captureModelTraffic) return c.json({ ok: true, ignored: true })
    const saved = store.observeTraffic(exchange)
    audit.log({ type: "traffic.exchange", exchange: saved })
    return c.json({ ok: true, exchange: saved })
  })

  app.post("/api/traffic/clear", (c) => {
    store.clearTraffic()
    return c.json({ ok: true })
  })

  app.post("/api/history/clear", (c) => {
    store.clear()
    return c.json({ ok: true })
  })

  app.post("/api/decision/:key", async (c) => {
    const key = c.req.param("key")
    const decision = Decision.parse(await c.req.json())
    const hold = holds.list().find((h) => h.key === key)
    if (!hold) return c.json({ error: "unknown or already-released hold" }, 404)
    const allowed = hold.stage === "before" ? BEFORE_ACTIONS : AFTER_ACTIONS
    if (!allowed.has(decision.action)) {
      return c.json({ error: `action '${decision.action}' not valid at ${hold.stage} stage` }, 400)
    }
    decision.by = "human"
    if (!holds.decide(key, decision)) return c.json({ error: "hold already released" }, 409)
    store.markDecided(hold.callId, hold.stage, decision, hold.ruleName, true)
    applyDecision(store, hold, decision)
    audit.log({ type: "call.released", callId: hold.callId, stage: hold.stage, decision })
    return c.json({ ok: true })
  })

  app.get("/api/state", (c) =>
    c.json({
      enabled: store.enabled,
      profile: store.profile,
      captureModelTraffic: store.captureModelTraffic,
      networkProxyEnabled: store.networkProxyEnabled,
    }),
  )

  const StatePatch = z.object({
    enabled: z.boolean().optional(),
    captureModelTraffic: z.boolean().optional(),
    networkProxyEnabled: z.boolean().optional(),
  })
  app.put("/api/state", async (c) => {
    const patch = StatePatch.parse(await c.req.json().catch(() => ({})))
    if (patch.enabled !== undefined) store.setEnabled(patch.enabled)
    if (patch.networkProxyEnabled !== undefined && patch.networkProxyEnabled !== store.networkProxyEnabled) {
      if (!networkProxy) return c.json({ error: "network proxy is unavailable" }, 503)
      try {
        if (patch.networkProxyEnabled) await networkProxy.start()
        else await networkProxy.stop()
      } catch (err) {
        return c.json(
          {
            error: `network proxy could not ${patch.networkProxyEnabled ? "start" : "stop"}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          503,
        )
      }
    }
    if (patch.captureModelTraffic !== undefined || patch.networkProxyEnabled !== undefined) {
      store.setTrafficSettings(patch)
    }
    return c.json({
      enabled: store.enabled,
      profile: store.profile,
      captureModelTraffic: store.captureModelTraffic,
      networkProxyEnabled: store.networkProxyEnabled,
    })
  })

  app.put("/api/profile", async (c) => {
    const profile = Profile.parse(await c.req.json())
    store.setProfile(profile)
    return c.json({ ok: true, profile })
  })

  // --- readiness -------------------------------------------------------------

  async function healthChecks() {
    const checks: Array<{
      id: string
      title: string
      status: "pass" | "warn" | "fail" | "info"
      detail: string
      fix?: { label: string; command?: string }
    }> = []

    checks.push({
      id: "sidecar",
      title: "Local sidecar reachable",
      status: "pass",
      detail: `The sidecar is serving this panel (uptime ${Math.round((Date.now() - startedAt) / 1000)}s).`,
    })

    checks.push({
      id: "store",
      title: "Capture store available",
      status: "pass",
      detail: `${store.list(1000).length} tool call(s) and ${store.listTraffic(1000).length} HTTP exchange(s) in memory.`,
    })

    if (dataDir) {
      try {
        await access(dataDir)
        checks.push({ id: "data", title: "Data directory writable", status: "pass", detail: dataDir })
      } catch {
        checks.push({
          id: "data",
          title: "Data directory writable",
          status: "fail",
          detail: `Cannot access ${dataDir}. Audit writes may fail.`,
          fix: { label: "Check the folder permissions and restart the sidecar", command: dataDir },
        })
      }
    } else {
      checks.push({ id: "data", title: "Data directory", status: "info", detail: "No persistent data directory is configured for this instance." })
    }

    const pluginDir = pluginsDir()
    let installed = false
    try {
      installed = (await stat(path.join(pluginDir, "openintercept-v2.ts"))).isFile()
    } catch {
      installed = false
    }
    checks.push(
      installed
        ? { id: "plugin-installed", title: "OpenCode plugin installed", status: "pass", detail: path.join(pluginDir, "openintercept-v2.ts") }
        : {
            id: "plugin-installed",
            title: "OpenCode plugin installed",
            status: "warn",
            detail: `No adapter found in ${pluginDir}. Tool-call interception needs the plugin.`,
            fix: { label: "Install it from the panel's Plugin section" },
          },
    )

    const agents = [...store.agents.values()]
    const latest = agents.sort((a, b) => b.at - a.at)[0]
    checks.push(
      latest
        ? {
            id: "plugin-heartbeat",
            title: "Agent heartbeat",
            status: Date.now() - latest.at < 10 * 60_000 ? "pass" : "warn",
            detail: `Last heartbeat from ${latest.adapter} at ${new Date(latest.at).toLocaleString()}${latest.pid ? ` (PID ${latest.pid})` : ""}.`,
          }
        : {
            id: "plugin-heartbeat",
            title: "Agent heartbeat",
            status: "warn",
            detail: "No adapter has registered yet. OpenCode loads plugins at startup; restart it after installing.",
          },
    )

    checks.push(
      store.profile.rules.length
        ? {
            id: "rules",
            title: "Interception policy configured",
            status: "pass",
            detail: `${store.profile.rules.length} rule(s) in profile "${store.profile.name}". Interception is ${store.enabled ? "on" : "off"}.`,
          }
        : {
            id: "rules",
            title: "Interception policy configured",
            status: "warn",
            detail: "The active profile has no rules. With no-rule policy set to pass, nothing will be held.",
          },
    )

    if (store.networkProxyEnabled) {
      const status = networkProxy?.status
      checks.push(
        status?.running
          ? { id: "proxy", title: "Network proxy listening", status: "pass", detail: `http://${status.host}:${status.port} (plain HTTP inspected; HTTPS is tunnel-only).` }
          : {
              id: "proxy",
              title: "Network proxy",
              status: "fail",
              detail: "The proxy is enabled in settings but is not listening.",
            },
      )
    } else {
      checks.push({
        id: "proxy",
        title: "Network proxy",
        status: "info",
        detail: "Optional and currently off. Tool-call interception works without it.",
      })
    }

    checks.push({
      id: "capture",
      title: "Model HTTP capture",
      status: store.captureModelTraffic ? "pass" : "info",
      detail: store.captureModelTraffic
        ? "Enabled. Prompts and responses may be written to the local audit log."
        : "Off. Enable it only if you need to inspect provider traffic.",
    })

    return checks
  }

  app.get("/api/health", async (c) => {
    const checks = await healthChecks()
    const status = checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "pass"
    return c.json({ status, checks, generatedAt: Date.now() })
  })

  app.get("/api/meta", async (c) => {
    const proxyStatus = networkProxy?.status
    return c.json({
      name: "OpenIntercept",
      version: appVersion,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
      dataDir: dataDir ?? null,
      audit: { path: dataDir ? path.join(dataDir, "audit.jsonl") : null, size: await audit.size() },
      counts: {
        entries: store.list(1000).length,
        traffic: store.listTraffic(1000).length,
        holds: holds.list().length,
        agents: store.agents.size,
      },
      intercept: { enabled: store.enabled, profile: store.profile.name, rules: store.profile.rules.length },
      capture: { model: store.captureModelTraffic, proxy: store.networkProxyEnabled },
      proxy: {
        available: !!networkProxy,
        running: proxyStatus?.running ?? false,
        host: proxyStatus?.host ?? "127.0.0.1",
        port: proxyStatus?.port ?? 7475,
      },
      features: {
        toolInterception: true,
        modelHttpCapture: true,
        plaintextHttpProxy: true,
        tlsInterception: false,
        activeScanning: false,
        requestReplay: false,
        multiUser: false,
        telemetry: false,
      },
    })
  })

  // --- plugin installer (serves the adapter file itself) -----------------------

  app.get("/api/plugin/source", async (c) => {
    const file = Bun.file(pluginSource)
    if (!(await file.exists())) return c.text("plugin source not found", 500)
    return c.text(await file.text(), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" })
  })

  app.get("/api/plugin/status", async (c) => {
    const dir = pluginsDir()
    return c.json({
      defaultDir: dir,
      dest: path.join(dir, "openintercept-v2.ts"),
      installed: await Bun.file(path.join(dir, "openintercept-v2.ts")).exists(),
      agents: [...store.agents.values()],
    })
  })

  /**
   * The source file ships the adapter with `export default OpenIntercept` (a
   * function — what V1 engines call). V2 engines require a plain-object
   * default { id, setup }, so the installer derives a second file,
   * openintercept-v2.ts, by swapping that final export line. Each engine loads
   * the variant it understands and skips the other.
   */
  function v2Variant(source: string): string {
    const marker = "export default OpenIntercept"
    if (!source.includes(marker)) throw new Error("plugin source is missing the V1 default export marker")
    return source.replace(marker, `export default { id: (OpenIntercept as any).id, setup: (OpenIntercept as any).setup }`)
  }

  const InstallBody = z.object({ target: z.string().optional(), v1: z.boolean().optional() })
  app.post("/api/plugin/install", async (c) => {
    const body = InstallBody.parse(await c.req.json().catch(() => ({})))
    const dir = body.target?.trim() ? body.target.trim() : pluginsDir()
    // V1 file default is FALSE: the global folder belongs to the V2 desktop
    // engine, and a V1 file there fails to load on every hot-reload, which
    // poisons the engine's plugin rebuilds. Project installs (CLI is V1)
    // pass v1 explicitly via the script.
    const includeV1 = body.v1 === true
    const source = Bun.file(pluginSource)
    if (!(await source.exists())) return c.json({ error: "plugin source not found on the server" }, 500)
    const text = await source.text()
    let v2: string
    try {
      v2 = v2Variant(text)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
    try {
      await mkdir(dir, { recursive: true })
      if (includeV1) await writeFile(path.join(dir, "openintercept.ts"), text, "utf8")
      await writeFile(path.join(dir, "openintercept-v2.ts"), v2, "utf8")
    } catch (err) {
      return c.json({ error: `could not write to ${dir} — ${err instanceof Error ? err.message : String(err)}` }, 500)
    }
    audit.log({ type: "plugin.installed", dest: dir, v1: includeV1 })
    return c.json({ ok: true, dest: dir })
  })

  // --- plugin heartbeat --------------------------------------------------------

  const BeaconBody = z.object({
    adapter: z.string(),
    pid: z.number().optional(),
    spoof: z.string().optional(),
    location: z.string().optional(),
    instanceID: z.string().optional(),
  })
  app.post("/api/agent", async (c) => {
    const body = BeaconBody.parse(await c.req.json())
    store.noteAgent(body.adapter, body.pid, body.spoof, body.location, body.instanceID)
    audit.log({ type: "agent.beacon", ...body })
    return c.json({ ok: true })
  })
  app.get("/api/agent", (c) => c.json({ agents: [...store.agents.values()] }))

  // --- plugin flight recorder ---------------------------------------------------

  const PluginLogBody = z.object({
    event: z.string(),
    detail: z.string().optional(),
    location: z.string().optional(),
    instanceID: z.string().optional(),
  })
  app.post("/api/plugin-log", async (c) => {
    const body = PluginLogBody.parse(await c.req.json())
    audit.log({ type: "plugin.debug", event: body.event, detail: body.detail ?? "", location: body.location, instanceID: body.instanceID })
    return c.json({ ok: true })
  })

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (ev: string, data: unknown) => stream.writeSSE({ event: ev, data: JSON.stringify(data) })
      await send("init", {
        enabled: store.enabled,
        profile: store.profile,
        captureModelTraffic: store.captureModelTraffic,
        networkProxyEnabled: store.networkProxyEnabled,
        holds: holds.list(),
        entries: store.list(200).map(serializeEntry),
        traffic: store.listTraffic(200),
        agents: [...store.agents.values()],
        startedAt,
      })
      const unsubscribe = store.bus.on((ev) => {
        switch (ev.type) {
          case "state":
            void send("state", {
              enabled: ev.enabled,
              profile: ev.profile,
              captureModelTraffic: store.captureModelTraffic,
              networkProxyEnabled: store.networkProxyEnabled,
            })
            break
          case "entry":
            void send("entry", { entry: serializeEntry(ev.entry) })
            break
          case "held":
            void send("held", ev)
            break
          case "released":
            void send("released", { key: ev.key, decision: ev.decision, entry: serializeEntry(ev.entry) })
            break
          case "cleared":
            void send("cleared", {})
            break
          case "agent":
            void send("agent", { adapter: ev.adapter, at: ev.at, pid: ev.pid, spoof: ev.spoof, location: ev.location, instanceID: ev.instanceID })
            break
          case "traffic":
            void send("traffic", { exchange: ev.exchange })
            break
        }
      })
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }), 15_000)
      stream.onAbort(() => {
        clearInterval(ping)
        unsubscribe()
      })
      // keep the stream open until the client disconnects
      await new Promise<void>(() => {})
    }),
  )

  if (panelDir) {
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".json": "application/json",
      ".woff2": "font/woff2",
    }
    app.get("*", async (c) => {
      let rel = decodeURIComponent(new URL(c.req.url).pathname)
      if (rel.includes("..")) return c.text("forbidden", 403)
      if (rel.startsWith("/api/")) {
        return c.json({ error: "endpoint not found" }, 404)
      }
      if (rel === "/" || rel === "") rel = "/index.html"
      const file = Bun.file(joinPath(panelDir, rel))
      if (!(await file.exists())) {
        // client-side routes share one entry document
        const fallback = Bun.file(joinPath(panelDir, "/index.html"))
        if (await fallback.exists()) {
          return c.body(await fallback.arrayBuffer(), 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" })
        }
        return c.text("not found", 404)
      }
      const ext = rel.slice(rel.lastIndexOf("."))
      return c.body(await file.arrayBuffer(), 200, {
        "content-type": types[ext] ?? "application/octet-stream",
        // panel assets must never go stale during development
        "cache-control": "no-cache",
      })
    })
  }

  return app
}

function joinPath(dir: string, rel: string): string {
  const clean = rel.startsWith("/") ? rel.slice(1) : rel
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + clean : dir + "/" + clean
}
