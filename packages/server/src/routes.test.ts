import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Profile, type ToolCall, type ToolResult } from "@openintercept/protocol"
import { NullAuditLog } from "./audit"
import { buildApp } from "./routes"
import { Store } from "./store"

const call = (id: string, tool = "webfetch", args: unknown = { url: "https://example.com" }): ToolCall => ({
  id,
  adapter: "opencode-v1",
  tool,
  args,
  session: { id: "s1" },
  startedAt: Date.now(),
})

const result = (output = "# Hello\nWorld"): ToolResult => ({ title: "Fetched", output, metadata: {} })

const json = { "content-type": "application/json" }
const post = (app: ReturnType<typeof buildApp>, url: string, body: unknown) =>
  app.request(url, { method: "POST", headers: json, body: JSON.stringify(body) })
const put = (app: ReturnType<typeof buildApp>, url: string, body: unknown) =>
  app.request(url, { method: "PUT", headers: json, body: JSON.stringify(body) })

/**
 * Wait until a hold is registered instead of sleeping a fixed number of
 * milliseconds. A fixed sleep is a flake under load: the request is handled on
 * a later tick and the assertion runs before the hold exists.
 */
async function waitForHold(app: ReturnType<typeof buildApp>, key: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { holds } = (await (await app.request("/api/holds")).json()) as { holds: Array<{ key: string }> }
    if (holds.some((hold) => hold.key === key)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`hold ${key} was not registered within ${timeoutMs}ms`)
}

function freshApp(rules: unknown[] = [{ tools: ["webfetch"], action: "hold" }], defaults: object = {}, networkProxy?: any) {
  const store = new Store(null, {
    enabled: true,
    profile: Profile.parse({ name: "test", rules, defaults }),
  })
  return buildApp({
    store,
    audit: new NullAuditLog(),
    panelDir: null,
    pluginSource: path.resolve(import.meta.dir, "../../plugin/src/openintercept.plugin.ts"),
    pluginsDir: () => pluginsTmp,
    networkProxy,
  })
}

let pluginsTmp: string
beforeEach(async () => {
  pluginsTmp = await mkdtemp(path.join(os.tmpdir(), "openintercept-plugins-"))
})

describe("intercept off / no rules", () => {
  test("intercept disabled -> immediate run, by auto", async () => {
    const app = freshApp([])
    const store = app // not reachable; assert via response
    await put(app, "/api/state", { enabled: false })
    const res = await post(app, "/api/before", { kind: "before", call: call("c1") })
    const body = await res.json()
    expect(body.decision.action).toBe("run")
    expect(body.decision.by).toBe("auto")
    expect(body.decision.reason).toBe("intercept off")
  })

  test("enabled, no matching rule, noRule=pass -> immediate forward", async () => {
    const app = freshApp([], {})
    const res = await post(app, "/api/after", { kind: "after", call: call("c2", "bash"), result: result() })
    const body = await res.json()
    expect(body.decision.action).toBe("forward")
    expect(body.decision.reason).toBe("no matching rule")
  })
})

describe("model and network traffic capture", () => {
  const exchange = { id: "model-1", channel: "model", startedAt: 1, request: { method: "POST", url: "https://provider.test", headers: {}, body: "prompt" } }

  test("model HTTP payload capture is off by default and opt-in persists through state", async () => {
    const app = freshApp([])
    const hidden = await post(app, "/api/traffic", exchange)
    expect((await hidden.json()).ignored).toBe(true)
    expect((await (await app.request("/api/traffic")).json()).exchanges).toHaveLength(0)

    const enabled = await put(app, "/api/state", { captureModelTraffic: true })
    expect((await enabled.json()).captureModelTraffic).toBe(true)
    expect((await post(app, "/api/traffic", exchange)).status).toBe(200)
    const saved = await (await app.request("/api/traffic")).json()
    expect(saved.exchanges).toHaveLength(1)
    expect(saved.exchanges[0].request.body).toBe("prompt")
  })

  test("network capture is also opt-in and partial updates merge by exchange id", async () => {
    let running = false
    const proxy = {
      get status() { return { running, host: "127.0.0.1", port: 7475 } },
      async start() { running = true; return this.status },
      async stop() { running = false },
    }
    const app = freshApp([], {}, proxy)
    const network = { ...exchange, id: "net-1", channel: "network" }
    expect((await (await post(app, "/api/traffic", network)).json()).ignored).toBe(true)
    await put(app, "/api/state", { networkProxyEnabled: true })
    expect(running).toBe(true)
    await post(app, "/api/traffic", network)
    await post(app, "/api/traffic", { ...network, response: { at: 2, status: 204, headers: {}, body: "" } })
    const saved = await (await app.request("/api/traffic")).json()
    expect(saved.exchanges).toHaveLength(1)
    expect(saved.exchanges[0].response.status).toBe(204)
  })
})

describe("held calls", () => {
  test("before held, human replaces args, entry reflects edit", async () => {
    const app = freshApp()
    const pending = post(app, "/api/before", { kind: "before", call: call("c10") })
    await waitForHold(app, "c10:before")

    const holdsRes = await app.request("/api/holds")
    const { holds } = await holdsRes.json()
    expect(holds).toHaveLength(1)
    expect(holds[0].key).toBe("c10:before")

    const dec = await post(app, "/api/decision/c10:before", {
      action: "replace",
      by: "human",
      args: { url: "https://evil.example" },
    })
    expect(dec.status).toBe(200)

    const body = await (await pending).json()
    expect(body.decision.action).toBe("replace")
    expect(body.decision.args.url).toBe("https://evil.example")

    const entry = await (await app.request("/api/history/c10")).json()
    expect(entry.entry.args.url).toBe("https://evil.example")
    expect(entry.entry.flags.argsEdited).toBe(true)
  })

  test("after held, human edits output -> status edited, original kept", async () => {
    const app = freshApp()
    await put(app, "/api/state", { enabled: true })
    const pending = post(app, "/api/after", {
      kind: "after",
      call: call("c11"),
      result: result("original content"),
    })
    await waitForHold(app, "c11:after")

    const dec = await post(app, "/api/decision/c11:after", {
      action: "replace",
      by: "human",
      result: { title: "Fetched", output: "TAMPERED", metadata: {} },
    })
    expect(dec.status).toBe(200)

    const body = await (await pending).json()
    expect(body.decision.action).toBe("replace")

    const entry = await (await app.request("/api/history/c11")).json()
    expect(entry.entry.status).toBe("edited")
    expect(entry.entry.after.result.output).toBe("TAMPERED")
    expect(entry.entry.after.originalResult.output).toBe("original content")
  })

  test("stage-action legality enforced", async () => {
    const app = freshApp()
    const pending = post(app, "/api/before", { kind: "before", call: call("c12") })
    await waitForHold(app, "c12:before")
    const bad = await post(app, "/api/decision/c12:before", { action: "forward", by: "human" })
    expect(bad.status).toBe(400)
    // cleanup
    await post(app, "/api/decision/c12:before", { action: "run", by: "human" })
    await pending
  })

  test("rule-level drop skips the hold entirely", async () => {
    const app = freshApp([{ tools: ["bash"], action: "drop" }])
    const res = await post(app, "/api/before", { kind: "before", call: call("c13", "bash", { command: "ls" }) })
    const body = await res.json()
    expect(body.decision.action).toBe("drop")
    expect(body.decision.by).toBe("auto")
    const entry = await (await app.request("/api/history/c13")).json()
    expect(entry.entry.status).toBe("blocked")
  })
})

describe("timeout policy", () => {
  test("fail-open: hold times out -> forward", async () => {
    const app = freshApp([{ action: "hold" }], { holdTimeoutMs: 40, onTimeout: "forward" })
    const res = await post(app, "/api/after", { kind: "after", call: call("c20"), result: result() })
    const body = await res.json()
    expect(body.decision.action).toBe("forward")
    expect(body.decision.by).toBe("timeout")
  })

  test("fail-closed: hold times out -> drop", async () => {
    const app = freshApp([{ action: "hold" }], { holdTimeoutMs: 40, onTimeout: "drop" })
    const res = await post(app, "/api/after", { kind: "after", call: call("c21"), result: result() })
    const body = await res.json()
    expect(body.decision.action).toBe("drop")
    expect(body.decision.by).toBe("timeout")
    const entry = await (await app.request("/api/history/c21")).json()
    expect(entry.entry.status).toBe("dropped")
    expect(entry.entry.after.result.output).toBe("")
  })

  test("noRule=hold holds unmatched calls while intercept is on", async () => {
    const app = freshApp([], { noRule: "hold", holdTimeoutMs: 300 })
    const pending = post(app, "/api/before", { kind: "before", call: call("c22", "grep") })
    await waitForHold(app, "c22:before")
    const { holds } = await (await app.request("/api/holds")).json()
    expect(holds).toHaveLength(1)
    const body = await (await pending).json()
    expect(body.decision.by).toBe("timeout")
  })
})

describe("idempotent adapter retries", () => {
  test("retrying a decided before-call returns the recorded decision", async () => {
    const app = freshApp([{ tools: ["webfetch"], action: "hold" }])
    const first = post(app, "/api/before", { kind: "before", call: call("c30") })
    await waitForHold(app, "c30:before")
    await post(app, "/api/decision/c30:before", { action: "drop", by: "human" })
    await first
    const retry = await post(app, "/api/before", { kind: "before", call: call("c30") })
    const body = await retry.json()
    expect(body.decision.action).toBe("drop")
    expect(body.decision.by).toBe("human")
  })
})

describe("plugin heartbeat", () => {
  test("beacon is stored and served", async () => {
    const app = freshApp([])
    await post(app, "/api/agent", { adapter: "opencode-v2", pid: 4242 })
    const res = await (await app.request("/api/agent")).json()
    expect(res.agents).toHaveLength(1)
    expect(res.agents[0].adapter).toBe("opencode-v2")
    expect(res.agents[0].pid).toBe(4242)
  })

  test("keeps concurrent desktop plugin activations separate", async () => {
    const app = freshApp([])
    await post(app, "/api/agent", { adapter: "opencode-v2", location: "D:\\bounty", instanceID: "bounty-1" })
    await post(app, "/api/agent", { adapter: "opencode-v2", location: "E:\\gsocAgent", instanceID: "gsoc-1" })
    const res = await (await app.request("/api/agent")).json()
    expect(res.agents).toHaveLength(2)
    expect(res.agents.map((agent: any) => agent.location).sort()).toEqual(["D:\\bounty", "E:\\gsocAgent"])
  })
})

describe("plugin installer", () => {
  test("source endpoint serves the adapter file", async () => {
    const app = freshApp([])
    const res = await app.request("/api/plugin/source")
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("OpenIntercept")
    expect(text).toContain("tool.execute.before")
  })

  test("status reflects install state (v2 file is the marker)", async () => {
    const app = freshApp([])
    const before = await (await app.request("/api/plugin/status")).json()
    expect(before.installed).toBe(false)
    await post(app, "/api/plugin/install", {})
    const after = await (await app.request("/api/plugin/status")).json()
    expect(after.installed).toBe(true)
  })

  test("install default is v2-ONLY (global folder must never get the V1 file); explicit v1:true writes both", async () => {
    const app = freshApp([])
    const res = await post(app, "/api/plugin/install", {})
    expect((await res.json()).ok).toBe(true)

    const v1Path = path.join(pluginsTmp, "openintercept.ts")
    const v2Path = path.join(pluginsTmp, "openintercept-v2.ts")
    expect(await Bun.file(v1Path).exists()).toBe(false) // default: no V1 file
    expect(await Bun.file(v2Path).exists()).toBe(true)

    // the V2 variant's default must be a plain object with id + setup fn
    const v2mod = await import(`${v2Path.replaceAll("\\", "/")}?v2test`)
    expect(typeof v2mod.default).toBe("object")
    expect(v2mod.default.id).toBe("openintercept")
    expect(typeof v2mod.default.setup).toBe("function")

    // explicit v1:true (project installs for the CLI) writes the callable variant.
    // (content assertion — bun test's dynamic import of files created mid-test
    // is unreliable on this Windows/Bun combo even when the file exists)
    const resV1 = await post(app, "/api/plugin/install", { v1: true })
    expect((await resV1.json()).ok).toBe(true)
    expect(await Bun.file(v1Path).exists()).toBe(true)
    const v1Text = await Bun.file(v1Path).text()
    expect(v1Text).toContain("export default OpenIntercept") // callable V1 default
    expect(v1Text).not.toContain("export default { id:") // not the V2 swap
    const v2Text = await Bun.file(v2Path).text()
    expect(v2Text).toContain("export default { id: (OpenIntercept as any).id")

    // custom target honors the caller's path
    const custom = await mkdtemp(path.join(os.tmpdir(), "openintercept-custom-"))
    const res2 = await post(app, "/api/plugin/install", { target: custom })
    expect((await res2.json()).dest.startsWith(custom)).toBe(true)
  })
})

describe("model/network traffic capture", () => {
  const modelExchange = (id: string) => ({
    id,
    channel: "model" as const,
    startedAt: 1,
    context: { provider: "opencode", model: "deepseek-v4.1-flash-free", kind: "primary" },
    request: { method: "POST", url: "https://api.example/v1/chat?key=SECRET", headers: { authorization: "Bearer sk-123" }, body: "{\"prompt\":\"hi\"}" },
  })

  test("model exchanges are stored, listed, merged with responses, and clearable", async () => {
    const app = freshApp([])
    await put(app, "/api/state", { captureModelTraffic: true })
    await post(app, "/api/traffic", modelExchange("t1"))
    const listed = await (await app.request("/api/traffic")).json()
    expect(listed.exchanges).toHaveLength(1)
    // the server stores what the adapter sends verbatim — redaction is the
    // plugin's job before it ever leaves the engine (covered in plugin tests)
    expect(listed.exchanges[0].request.url).toContain("key=SECRET")

    // response merge on the same id
    await post(app, "/api/traffic", {
      ...modelExchange("t1"),
      response: { at: 2, status: 200, statusText: "OK", headers: {}, body: "ok" },
    })
    const merged = await (await app.request("/api/traffic/t1")).json()
    expect(merged.exchange.response.status).toBe(200)
    expect(merged.exchange.request.method).toBe("POST")

    await post(app, "/api/traffic/clear", {})
    expect((await (await app.request("/api/traffic")).json()).exchanges).toHaveLength(0)
  })

  test("model channel is ignored while capture is off; network channel ignored while proxy is off", async () => {
    const app = freshApp([])
    await put(app, "/api/state", { captureModelTraffic: false, networkProxyEnabled: false })
    await post(app, "/api/traffic", modelExchange("t2"))
    await post(app, "/api/traffic", { ...modelExchange("t3"), channel: "network" })
    expect((await (await app.request("/api/traffic")).json()).exchanges).toHaveLength(0)
  })

  test("state PATCH drives the network proxy start/stop", async () => {
    const calls: string[] = []
    const stub = {
      status: { running: false, host: "127.0.0.1", port: 7475 },
      start: async () => { calls.push("start"); stub.status = { running: true, host: "127.0.0.1", port: 7475 }; return stub.status },
      stop: async () => { calls.push("stop"); stub.status = { running: false, host: "127.0.0.1", port: 7475 } },
    }
    const app = freshApp([], {}, stub)
    await put(app, "/api/state", { networkProxyEnabled: true })
    await put(app, "/api/state", { networkProxyEnabled: false })
    expect(calls).toEqual(["start", "stop"])
    const settings = await (await app.request("/api/traffic/settings")).json()
    expect(settings.networkProxyEnabled).toBe(false)
    expect(settings.captureModelTraffic).toBe(false)
  })

  test("failed tool results surface as error status when forwarded", async () => {
    const app = freshApp([])
    await post(app, "/api/before", { kind: "before", call: call("c-err") })
    await post(app, "/api/after", {
      kind: "after",
      call: call("c-err"),
      result: { title: "Tool error", output: "error: non 2xx status code (404)", metadata: {} },
    })
    const entry = await (await app.request("/api/history/c-err")).json()
    expect(entry.entry.status).toBe("error")

    // but a REPLACED error is still an edit
    await post(app, "/api/before", { kind: "before", call: call("c-err2") })
    await post(app, "/api/after", { kind: "after", call: call("c-err2"), result: { title: "Tool error", output: "error: boom", metadata: {} }, fabricated: true, spoof: { title: "spoofed", output: "fine now", metadata: {} } })
    const entry2 = await (await app.request("/api/history/c-err2")).json()
    expect(entry2.entry.status).toBe("fabricated")
  })
})

describe("respond / fabrication", () => {
  test("before-stage decision may be respond (with the fabricated result)", async () => {
    const app = freshApp([{ tools: ["webfetch"], action: "hold" }])
    const pending = post(app, "/api/before", { kind: "before", call: call("c50") })
    await waitForHold(app, "c50:before")
    const dec = await post(app, "/api/decision/c50:before", {
      action: "respond",
      by: "human",
      result: { title: "search results", output: "# Totally real results\n- example.com/security advisory", metadata: {} },
    })
    expect(dec.status).toBe(200)
    const body = await (await pending).json()
    expect(body.decision.action).toBe("respond")
    expect(body.decision.result.output).toContain("example.com/security")
  })

  test("after with fabricated flag auto-applies, no hold, status fabricated, original kept", async () => {
    // holds the after stage (60s) — the fabricated path must bypass it
    const app = freshApp([{ stages: ["after"], action: "hold" }], { holdTimeoutMs: 60_000 })
    await post(app, "/api/before", { kind: "before", call: call("c51") }) // no before rule -> passes
    const res = await post(app, "/api/after", {
      kind: "after",
      call: call("c51"),
      result: { title: "observed", output: "error: 404 Not Found", metadata: {} },
      fabricated: true,
    })
    const body = await res.json()
    expect(body.decision.action).toBe("replace")
    expect(body.decision.reason).toBe("fabricated")
    const entry = await (await app.request("/api/history/c51")).json()
    expect(entry.entry.status).toBe("fabricated")
    expect(entry.entry.after.result.output).toBe("error: 404 Not Found")
    expect(entry.entry.after.originalResult.output).toBe("error: 404 Not Found")
  })

  test("after with spoof payload: model got the spoof, history keeps the real 404", async () => {
    const app = freshApp([])
    await post(app, "/api/before", { kind: "before", call: call("c52") })
    await post(app, "/api/after", {
      kind: "after",
      call: call("c52"),
      result: { title: "observed", output: "error: non 2xx status code (404 GET https://iitk.ac.in/x)", metadata: {} },
      spoof: { output: "# SECURITY NOTICE — researchers welcome" },
      fabricated: true,
    })
    const entry = await (await app.request("/api/history/c52")).json()
    expect(entry.entry.status).toBe("fabricated")
    expect(entry.entry.after.result.output).toContain("SECURITY NOTICE")
    expect(entry.entry.after.originalResult.output).toContain("404 GET https://iitk.ac.in")
    expect(JSON.stringify(entry.entry.after.result)).not.toMatch(/openintercept|spoof|fabricat/i)
  })

  test("the spoof page route is gone", async () => {
    const app = freshApp([])
    const page = await app.request("/spoof/sp1")
    expect(page.status).not.toBe(200)
  })
})

describe("history clear", () => {
  test("clear empties history; context fields survive on new calls", async () => {
    const app = freshApp([])
    await put(app, "/api/state", { enabled: false })
    await post(app, "/api/before", {
      kind: "before",
      call: { ...call("c40"), session: { id: "s9", title: "Titled chat" }, context: { model: "gpt-x", provider: "openai", agent: "plan" } },
    })
    const before = await (await app.request("/api/history")).json()
    expect(before.entries).toHaveLength(1)
    expect(before.entries[0].context.model).toBe("gpt-x")
    expect(before.entries[0].sessionTitle).toBe("Titled chat")

    const cleared = await post(app, "/api/history/clear", {})
    expect((await cleared.json()).ok).toBe(true)
    const after = await (await app.request("/api/history")).json()
    expect(after.entries).toHaveLength(0)
  })
})
