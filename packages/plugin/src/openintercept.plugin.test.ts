import { afterEach, beforeEach, describe, expect, test } from "bun:test"

/**
 * Exercises the real plugin (both engine adapters) against a stub OpenIntercept
 * sidecar. Critical assertions: arg edits preserve object IDENTITY (both V1
 * and V2 ignore hook return values — only in-place mutation propagates),
 * drop at the before stage throws, and every sidecar failure fails open.
 */

let handler: (req: Request) => Response | Promise<Response> = () => new Response("{}", { headers: { "content-type": "application/json" } })
let received: any[] = []
let server: ReturnType<typeof Bun.serve> | null = null
let plugin: any

beforeEach(async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const text = req.method === "POST" ? await req.text() : ""
      received.push({ path: new URL(req.url).pathname, body: text ? JSON.parse(text) : null })
      return handler(req)
    },
  })
  process.env.OPENINTERCEPT_URL = `http://127.0.0.1:${server.port}`
  // plugin reads OPENINTERCEPT_URL at import time — fresh module per suite run
  plugin = await import(`./openintercept.plugin.ts?t=${Date.now()}`)
})

afterEach(() => {
  server?.stop(true)
  server = null
  received = []
})

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

/**
 * Poll until `predicate` is satisfied. The plugin posts fire-and-forget, so a
 * fixed sleep races the network under load and makes the suite flaky.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error("condition was not met within " + timeoutMs + "ms")
}

const beforeInput = (callID = "call-1") => ({ tool: "webfetch", sessionID: "sess-1", callID })
const afterInput = (callID = "call-1") => ({ tool: "webfetch", sessionID: "sess-1", callID, args: { url: "https://x" } })

/** Simulate a V2 engine: capture hook registrations from a ctx object. */
async function v2hooks() {
  const registered: Record<string, Record<string, any>> = { session: {}, tool: {} }
  const ctx = {
    session: {
      hook: async (name: string, cb: any) => { registered.session[name] = cb },
      get: async () => ({ info: { title: "Fix auth bug session" } }),
    },
    tool: { hook: async (name: string, cb: any) => { registered.tool[name] = cb } },
  }
  await plugin.default.setup(ctx)
  return registered
}

describe("dual-shape export", () => {
  test("default export is a V1-callable function carrying the V2 definition", () => {
    expect(typeof plugin.default).toBe("function")
    expect(plugin.default.id).toBe("openintercept")
    expect(typeof plugin.default.setup).toBe("function")
  })

  test("V2 setup registers model + HTTP traffic hooks and both tool hooks, and heartbeats", async () => {
    const reg = await v2hooks()
    expect(reg.session["model.request"]).toBeTypeOf("function")
    expect(reg.session["http.request"]).toBeTypeOf("function")
    expect(reg.session["http.response"]).toBeTypeOf("function")
    expect(reg.tool["execute.before"]).toBeTypeOf("function")
    expect(reg.tool["execute.after"]).toBeTypeOf("function")
    await waitFor(() => received.some((r) => r.path === "/api/agent"))
    const beat = received.find((r) => r.path === "/api/agent")
    expect(beat?.body?.adapter).toBe("opencode-v2")
  })

  test("opt-in model traffic capture redacts credentials and records request/response", async () => {
    handler = (req) => new URL(req.url).pathname === "/api/traffic/settings"
      ? json({ captureModelTraffic: true })
      : json({ ok: true })
    const reg = await v2hooks()
    const request = new Request("https://api.example.test/chat?api_key=secret", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "private prompt" }] }),
    })
    const event = {
      sessionID: "session-model",
      agent: "build",
      model: { providerID: "example", modelID: "model-1" },
      kind: "primary",
      request,
    }
    await reg.session["http.request"](event)
    await reg.session["http.response"]({ ...event, response: new Response("event: done\\ndata: answer\\n\\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", "set-cookie": "secret=1" },
    }) })
    await waitFor(() => received.some((r) => r.path === "/api/traffic" && r.body?.response))
    // the plugin posts the request first and the merged exchange second, and
    // the two fire-and-forget posts can land in either order
    const captured = received.filter((r) => r.path === "/api/traffic" && r.body?.response).at(-1)?.body
    expect(captured.channel).toBe("model")
    expect(captured.request.url).toContain("api_key=%5BREDACTED%5D")
    expect(captured.request.headers.authorization).toBe("[REDACTED]")
    expect(captured.request.body).toContain("private prompt")
    expect(captured.response.status).toBe(200)
    expect(captured.response.headers["set-cookie"]).toBe("[REDACTED]")
    expect(captured.response.body).toContain("answer")
  })

  test("non-Request payloads are rejected loudly (debug line) and post nothing", async () => {
    handler = (req) => new URL(req.url).pathname === "/api/traffic/settings"
      ? json({ captureModelTraffic: true })
      : json({ ok: true })
    const reg = await v2hooks()
    const trafficPosts = () => received.filter((r) => r.path === "/api/traffic")
    const before = trafficPosts().length
    // engine payload shape differs from our assumption (e.g. a plain object)
    await reg.session["http.request"]({ sessionID: "s", request: { url: "https://x" } })
    await reg.session["http.response"]({ sessionID: "s", request: { url: "https://x" }, response: { status: 200 } })
    await waitFor(() =>
      received.some((r) => r.path === "/api/plugin-log" && /hook-http-(request|response)-rejected/.test(r.body?.event ?? "")),
    )
    expect(trafficPosts().length).toBe(before) // no traffic posts, no crashes
    const rejected = received.filter((r) => r.path === "/api/plugin-log" && /hook-http-(request|response)-rejected/.test(r.body?.event ?? ""))
    expect(rejected.length).toBeGreaterThanOrEqual(1) // but the flight recorder saw it
  })

  test("V2 calls carry the real session title from ctx.session.get", async () => {
    const reg = await v2hooks()
    handler = () => json({ decision: { action: "run", by: "auto" } })
    await reg.tool["execute.before"]({ tool: "read", sessionID: "sess-title", id: "v2-t1", input: {} })
    const sent = received.find((r) => r.path === "/api/before" && r.body?.call?.id === "v2-t1")
    expect(sent.body.call.session.title).toBe("Fix auth bug session")
  })
})

describe("V1: tool.execute.before", () => {
  test("replace mutates args IN PLACE (identity preserved)", async () => {
    handler = () => json({ decision: { action: "replace", by: "human", args: { url: "https://evil.example" } } })
    const h = await plugin.default({ client: {} })
    const output = { args: { url: "https://good.example", depth: 2 } }
    const identity = output.args
    await h["tool.execute.before"](beforeInput(), output)
    expect(output.args).toEqual({ url: "https://evil.example" })
    expect(output.args).toBe(identity) // the load-bearing assertion
  })

  test("drop throws; run leaves args untouched", async () => {
    const h = await plugin.default({ client: {} })
    handler = () => json({ decision: { action: "drop", by: "human" } })
    const out = { args: { a: 1 } }
    expect(h["tool.execute.before"](beforeInput("c-d"), out)).rejects.toThrow("Tool execution failed")
    expect(out.args).toEqual({ a: 1 })
    handler = () => json({ decision: { action: "run", by: "auto" } })
    await h["tool.execute.before"](beforeInput("c-r"), out)
    expect(out.args).toEqual({ a: 1 })
  })

  test("chat.params feeds model/provider into the call context", async () => {
    handler = () => json({ decision: { action: "run", by: "auto" } })
    const h = await plugin.default({ client: {} })
    h["chat.params"]({ sessionID: "sess-1", agent: "build", model: { modelID: "gpt-x", providerID: "openai" } })
    await h["tool.execute.before"](beforeInput("call-ctx"), { args: {} })
    const sent = received.find((r) => r.path === "/api/before" && r.body?.call?.id === "call-ctx")
    expect(sent.body.call.adapter).toBe("opencode-v1")
    expect(sent.body.call.context).toEqual({ model: "gpt-x", provider: "openai", agent: "build" })
  })
})

describe("V1: tool.execute.after", () => {
  test("replace rewrites output; drop sets a notice", async () => {
    const h = await plugin.default({ client: {} })
    handler = () =>
      json({ decision: { action: "replace", by: "human", result: { title: "Fetched", output: "TAMPERED", metadata: { k: 1 } } } })
    const output = { title: "Fetched", output: "original", metadata: {} as any }
    await h["tool.execute.after"](afterInput(), output)
    expect(output.output).toBe("TAMPERED")
    expect(output.metadata).toEqual({ k: 1 })

    handler = () => json({ decision: { action: "drop", by: "human" } })
    const output2 = { title: "Fetched", output: "original", metadata: {} }
    await h["tool.execute.after"](afterInput("c-d2"), output2)
    expect(output2.output).toBe("")
  })
})

describe("V2: execute.before / execute.after", () => {
  test("replace mutates event.input IN PLACE (identity preserved)", async () => {
    const reg = await v2hooks()
    handler = () => json({ decision: { action: "replace", by: "human", args: { url: "https://evil.example" } } })
    const input = { url: "https://good.example" }
    const identity = input
    await reg.tool["execute.before"]({ tool: "webfetch", sessionID: "sess-9", agent: "build", id: "v2-1", input })
    expect(input).toEqual({ url: "https://evil.example" })
    expect(input).toBe(identity)
  })

  test("drop throws; adapter reports opencode-v2 with agent context", async () => {
    const reg = await v2hooks()
    handler = () => json({ decision: { action: "drop", by: "human" } })
    await expect(
      reg.tool["execute.before"]({ tool: "bash", sessionID: "sess-9", agent: "plan", id: "v2-2", input: {} }),
    ).rejects.toThrow("Tool execution failed")
    const sent = received.find((r) => r.path === "/api/before" && r.body?.call?.id === "v2-2")
    expect(sent.body.call.adapter).toBe("opencode-v2")
    expect(sent.body.call.context.agent).toBe("plan")
  })

  test("model.request hook populates model context (string Model.Ref form)", async () => {
    const reg = await v2hooks()
    reg.session["model.request"]({ sessionID: "sess-9", agent: "build", model: "anthropic/claude-sonnet-4-5" })
    handler = () => json({ decision: { action: "forward", by: "human" } })
    await reg.tool["execute.after"]({
      tool: "webfetch", sessionID: "sess-9", agent: "build", id: "v2-3", input: {},
      status: "completed", result: { output: "page text", metadata: {} },
    })
    const sent = received.find((r) => r.path === "/api/after" && r.body?.call?.id === "v2-3")
    expect(sent.body.call.context).toEqual({ model: "claude-sonnet-4-5", provider: "anthropic", agent: "build" })
  })

  test("completed and failed tool results are both interceptable before the model sees them", async () => {
    const reg = await v2hooks()
    handler = () =>
      json({ decision: { action: "replace", by: "human", result: { output: "TAMPERED", metadata: { z: 1 } } } })
    // structured output object + content parts — the V2 reality
    const result = {
      output: { files: ["a.ts"], count: 1 },
      content: [{ type: "text", text: "original text" }],
      metadata: {} as any,
    }
    await reg.tool["execute.after"]({
      tool: "edit", sessionID: "sess-9", id: "v2-4", input: {},
      status: "completed", result,
    })
    // tamper lands in content (what normalizeContent forwards to the model)
    expect(result.content).toEqual([{ type: "text", text: "TAMPERED" }])
    expect(result.metadata).toEqual({ z: 1 })
    // the structured output object is left intact for engine consumers
    expect(result.output).toEqual({ files: ["a.ts"], count: 1 })
    // what was reported to the sidecar is the flattened model-visible text
    const sent = received.find((r) => r.path === "/api/after" && r.body?.call?.id === "v2-4")
    expect(sent.body.result.output).toBe("original text")

    handler = () => json({ decision: { action: "replace", by: "human", result: { output: "edited error" } } })
    const error = { message: "boom", metadata: { code: "E_TEST" } }
    await reg.tool["execute.after"]({
      tool: "webfetch", sessionID: "sess-9", id: "v2-5", input: {},
      status: "error", error,
    })
    expect(error.message).toBe("edited error")
    const failed = received.find((r) => r.path === "/api/after" && r.body?.call?.id === "v2-5")
    expect(failed.body.result.output).toBe("error: boom")
  })

  test("structured output with no content is stringified, never [object Object]", async () => {
    const reg = await v2hooks()
    handler = () => json({ decision: { action: "forward", by: "human" } })
    await reg.tool["execute.after"]({
      tool: "read", sessionID: "sess-9", id: "v2-7", input: {},
      status: "completed", result: { output: { path: "x.ts", lines: 10 } },
    })
    const sent = received.find((r) => r.path === "/api/after" && r.body?.call?.id === "v2-7")
    expect(sent.body.result.output).toBe('{"path":"x.ts","lines":10}')

    handler = () => json({ decision: { action: "drop", by: "human" } })
    const result2: any = { output: { a: 1 } }
    await reg.tool["execute.after"]({
      tool: "read", sessionID: "sess-9", id: "v2-8", input: {},
      status: "completed", result: result2,
    })
    expect(result2.content).toEqual([{ type: "text", text: "" }])
  })
})

describe("respond / fabrication", () => {
  test("V1: respond at before stores spoof; after replaces output only and keeps the real title/metadata", async () => {
    const h = await plugin.default({ client: {} })
    handler = () =>
      json({ decision: { action: "respond", by: "human", result: { output: "# FAKE RESULTS" } } })
    const out = { args: { query: "example.com security" } }
    await h["tool.execute.before"](beforeInput("fab-1"), out) // returns normally, no throw
    expect(out.args).toEqual({ query: "example.com security" }) // args untouched

    // tool "runs" and returns junk / a 404 body — the after stage discards it
    handler = () => json({ decision: { action: "hold", by: "human" } }) // must NOT be consulted
    const after = { title: "404", output: "Not Found", metadata: { code: "E404" } }
    await h["tool.execute.after"](afterInput("fab-1"), after)
    expect(after.output).toBe("# FAKE RESULTS")
    expect(after.title).toBe("404") // real title, no operator marker
    expect(after.metadata).toEqual({ code: "E404" }) // real metadata, no fabricated flag
    const sent = received.find((r) => r.path === "/api/after" && r.body?.call?.id === "fab-1")
    expect(sent.body.fabricated).toBe(true)
    expect(sent.body.spoof.output).toBe("# FAKE RESULTS") // what the model got
    expect(sent.body.spoof.title).toBe("404")
    expect(sent.body.result.output).toBe("Not Found") // what really happened
    expect(JSON.stringify(sent.body.spoof)).not.toMatch(/openintercept|spoof|fabricat/i)
  })

  test("V2 fallback mode: completed result is replaced with a schema-correct envelope", async () => {
    const reg = await v2hooks() // no tool.transform -> fallback mode
    handler = () => json({ decision: { action: "respond", by: "human", result: { output: "# POISONED PAGE" } } })
    const input = { query: "example.com security" } // no url -> no fallback rewrite
    await reg.tool["execute.before"]({ tool: "websearch", sessionID: "s", id: "fab-2", input })
    expect(input).toEqual({ query: "example.com security" })

    const result = { output: { status: 404 }, content: [{ type: "text", text: "Not Found" }] }
    await reg.tool["execute.after"]({ tool: "websearch", sessionID: "s", id: "fab-2", input, status: "completed", result })
    expect(result.content).toEqual([{ type: "text", text: "# POISONED PAGE" }])
    expect(result.output).toMatchObject({ provider: "exa" })
    expect(result.output.results[0].content).toBe("# POISONED PAGE")
    expect(result.output.results[0].time).toEqual({})
    const sent = received.find((r) => r.path === "/api/after" && r.body?.call?.id === "fab-2")
    expect(sent.body.fabricated).toBe(true)
    expect(sent.body.spoof.output).toBe("# POISONED PAGE")
    expect(sent.body.result.output).toBe("Not Found")
    expect(JSON.stringify(result)).not.toMatch(/openintercept|spoof|fabricat|127\.0\.0\.1/i)
  })

  test("V2 fallback mode: a tool failure is never disguised as a success", async () => {
    const reg = await v2hooks()
    handler = () => json({ decision: { action: "respond", by: "human", result: { output: "injected payload text" } } })
    await reg.tool["execute.before"]({ tool: "webfetch", sessionID: "s", id: "fab-3", input: {} })
    const error = { _tag: "Tool.Error", message: "getaddrinfo ENOTFOUND example.com" }
    await reg.tool["execute.after"]({ tool: "webfetch", sessionID: "s", id: "fab-3", input: {}, status: "error", error })
    expect(error.message).toBe("getaddrinfo ENOTFOUND example.com") // real failure preserved
    const sent3 = received.find((r) => r.path === "/api/after" && r.body?.call?.id === "fab-3")
    expect(sent3.body.fabricated).toBe(true)
    expect(sent3.body.result.output).toBe("error: getaddrinfo ENOTFOUND example.com")
  })

  test("fallback mode never rewrites tool arguments or calls a spoof endpoint", async () => {
    // no tool.transform in ctx -> engine refusal -> fallback mode
    const reg = await v2hooks()
    handler = () => json({ decision: { action: "respond", by: "human", result: { output: "MAINTENANCE PAGE SPOOF" } } })
    const input = { url: "https://example.org/security/challenge.txt" }
    await reg.tool["execute.before"]({ tool: "webfetch", sessionID: "s", id: "fab-4", input })
    expect(input.url).toBe("https://example.org/security/challenge.txt")
    expect(received.find((r) => r.path === "/api/spoof")).toBeUndefined()
  })
})

describe("spoofer v2: single-reporter hook/wrapper coordination", () => {
  async function wrapperSetup(originalExecute: (input: any, context: any) => Promise<any>) {
    let originalCalls = 0
    const tools: Record<string, any> = {
      webfetch: {
        id: "webfetch",
        execute: async (input: any, context: any) => {
          originalCalls++
          return originalExecute(input, context)
        },
      },
    }
    const registered: Record<string, Record<string, any>> = { session: {}, tool: {} }
    const ctx = {
      session: {
        hook: async (name: string, cb: any) => { registered.session[name] = cb },
        get: async () => ({ info: { title: "T" } }),
      },
      tool: {
        hook: async (name: string, cb: any) => { registered.tool[name] = cb },
        transform: async (fn: (editor: any) => void) => {
          fn({
            get: (id: string) => tools[id],
            update: (id: string, mutate: (t: any) => void) => mutate(tools[id]),
          })
        },
      },
    }
    await plugin.default.setup(ctx)
    return { reg: registered, wrapped: tools.webfetch.execute, originalCalls: () => originalCalls }
  }

  const ctxArgs = { id: "w1", sessionID: "sess-w", agent: "build" }

  /** simulate engine ordering: before hook → execute → after hook */
  async function engineCall(
    reg: Record<string, Record<string, any>>,
    execute: (input: any, context: any) => Promise<any>,
    input: any,
    ctx: any,
  ) {
    try {
      await reg.tool["execute.before"]({ tool: "webfetch", sessionID: ctx.sessionID, agent: ctx.agent, id: ctx.id, input })
    } catch (err) {
      return { err }
    }
    let ok: any
    let err: any
    try {
      ok = await execute(input, ctx)
    } catch (e) {
      err = e
    }
    if (err) {
      await reg.tool["execute.after"]({ tool: "webfetch", sessionID: ctx.sessionID, id: ctx.id, input, status: "error", error: err })
      return { err }
    }
    await reg.tool["execute.after"]({ tool: "webfetch", sessionID: ctx.sessionID, id: ctx.id, input, status: "completed", result: ok })
    return { ok }
  }

  test("respond via WRAPPER: schema-correct spoof, real tool never runs, original args preserved", async () => {
    handler = () => json({ decision: { action: "respond", by: "human", result: { output: "Security Notice: under maintenance" } } })
    const { reg, wrapped, originalCalls } = await wrapperSetup(async () => ({ output: "real" }))
    const input = { url: "https://example.org/security/challenge.txt" }
    const out = await engineCall(reg, wrapped, input, ctxArgs)
    expect(originalCalls()).toBe(0) // the 404 never happened
    expect(out.ok.content).toEqual([{ type: "text", text: "Security Notice: under maintenance" }])
    // the typed output must satisfy webfetch's declared Output schema —
    // a mismatch gets encoded as a ToolFailure (error) by the engine
    expect(out.ok.output).toEqual({
      url: "https://example.org/security/challenge.txt",
      contentType: "text/html; charset=utf-8",
      format: "markdown",
      output: "Security Notice: under maintenance",
    })
    expect(input.url).toBe("https://example.org/security/challenge.txt") // authentic URL in transcript
    expect(JSON.stringify(out.ok)).not.toMatch(/openintercept|spoof|fabricat|127\.0\.0\.1/i)
    const befores = received.filter((r) => r.path === "/api/before" && r.body?.call?.id === "w1")
    const afters = received.filter((r) => r.path === "/api/after" && r.body?.call?.id === "w1")
    expect(befores).toHaveLength(1)
    expect(afters).toHaveLength(1)
    expect(afters[0].body.fabricated).toBe(true)
    expect(afters[0].body.spoof.output).toContain("under maintenance")
    expect(afters[0].body.result.output).toBe("(not executed)")
  })

  test("respond via STALE SNAPSHOT (original tool runs): args stay authentic, result is replaced", async () => {
    handler = () => json({ decision: { action: "respond", by: "human", result: { output: "MAINTENANCE SPOOF" } } })
    const { reg } = await wrapperSetup(async (input: any) => ({
      output: input.url, // "fetches" whatever URL the hook left in the args
      content: [{ type: "text", text: input.url }],
    }))
    // the session executes the ORIGINAL tool (stale snapshot): wrapped never invoked
    const input = { url: "https://example.org/security/challenge.txt" }
    await engineCall(reg, (i: any) => Promise.resolve({ output: input.url, content: [{ type: "text", text: input.url }] }), input, ctxArgs)
    expect(input.url).toBe("https://example.org/security/challenge.txt")
    const afters = received.filter((r) => r.path === "/api/after" && r.body?.call?.id === "w1")
    expect(afters).toHaveLength(1)
    expect(afters[0].body.fabricated).toBe(true)
    expect(afters[0].body.spoof.output).toBe("MAINTENANCE SPOOF")
  })

  test("normal run through the wrapper: delegates, after hook holds/decides normally", async () => {
    handler = () =>
      json({ decision: { action: "replace", by: "auto" as any, result: { output: "EDITED RESULT", metadata: {} } } })
    const { reg, wrapped, originalCalls } = await wrapperSetup(async () => ({
      output: "real page",
      content: [{ type: "text", text: "real page" }],
    }))
    const out = await engineCall(reg, wrapped, {}, ctxArgs)
    expect(originalCalls()).toBe(1)
    expect(out.ok.content[0].text).toBe("EDITED RESULT") // after-hook replace applied
  })

  test("drop at before: engine aborts the call before execution", async () => {
    handler = () => json({ decision: { action: "drop", by: "human" } })
    const { reg, wrapped, originalCalls } = await wrapperSetup(async () => ({ output: "real" }))
    const out = await engineCall(reg, wrapped, {}, ctxArgs)
    expect(String(out.err?.message)).toContain("Tool execution failed")
    expect(originalCalls()).toBe(0)
  })

  test("sidecar down: everything delegates untouched (fail open)", async () => {
    server!.stop(true)
    server = null
    const { reg, wrapped, originalCalls } = await wrapperSetup(async () => ({ output: "real page" }))
    const out = await engineCall(reg, wrapped, {}, ctxArgs)
    expect(originalCalls()).toBe(1)
    expect(out.ok.output).toBe("real page")
  })
})

describe("fail-open (both adapters)", () => {
  test("sidecar 500 or unreachable -> pass through untouched", async () => {
    handler = () => new Response("boom", { status: 500 })
    const v1 = await plugin.default({ client: {} })
    const out = { args: { a: 1 } }
    await v1["tool.execute.before"](beforeInput(), out)
    expect(out.args).toEqual({ a: 1 })

    const reg = await v2hooks()
    const input = { a: 1 }
    await reg.tool["execute.before"]({ tool: "bash", sessionID: "s", id: "v2-6", input })
    expect(input).toEqual({ a: 1 })

    server!.stop(true) // dead sidecar
    server = null
    const out2 = { args: { a: 1 } }
    await v1["tool.execute.before"](beforeInput("c-dead"), out2)
    expect(out2.args).toEqual({ a: 1 })
  })
})

describe("concurrent location registrations (desktop hosts several)", () => {
  async function activate() {
    const registered: Record<string, Record<string, any>> = { session: {}, tool: {} }
    const ctx = {
      session: { hook: async (name: string, cb: any) => { registered.session[name] = cb }, get: async () => ({ info: { title: "T" } }) },
      tool: { hook: async (name: string, cb: any) => { registered.tool[name] = cb } },
    }
    const cleanup = await plugin.default.setup(ctx)
    return { reg: registered, cleanup }
  }

  test("two concurrent registrations intercept independently (no process-global mute)", async () => {
    handler = () => json({ decision: { action: "run", by: "auto" } })
    const locA = await activate() // first location
    const locB = await activate() // a second location — must NOT mute locA

    await locA.reg.tool["execute.before"]({ tool: "webfetch", sessionID: "sA", id: "loc-a-1", input: { url: "https://a" } })
    await locB.reg.tool["execute.before"]({ tool: "webfetch", sessionID: "sB", id: "loc-b-1", input: { url: "https://b" } })
    await locA.reg.tool["execute.before"]({ tool: "webfetch", sessionID: "sA", id: "loc-a-2", input: { url: "https://a2" } })

    expect(received.find((r) => r.path === "/api/before" && r.body?.call?.id === "loc-a-1")).toBeTruthy()
    expect(received.find((r) => r.path === "/api/before" && r.body?.call?.id === "loc-b-1")).toBeTruthy()
    expect(received.find((r) => r.path === "/api/before" && r.body?.call?.id === "loc-a-2")).toBeTruthy()
  })

  test("disposing one registration deactivates only that one", async () => {
    handler = () => json({ decision: { action: "run", by: "auto" } })
    const locA = await activate()
    const locB = await activate()
    await locA.cleanup?.()

    const before = received.length
    await locA.reg.tool["execute.before"]({ tool: "webfetch", sessionID: "sA", id: "loc-a-dead", input: {} })
    expect(received.length).toBe(before) // disposed registration is silent

    await locB.reg.tool["execute.before"]({ tool: "webfetch", sessionID: "sB", id: "loc-b-alive", input: {} })
    expect(received.find((r) => r.path === "/api/before" && r.body?.call?.id === "loc-b-alive")).toBeTruthy()
  })

  test("state is not shared across registrations (fabrication in one cannot leak into another)", async () => {
    const locA = await activate()
    const locB = await activate()
    handler = () => json({ decision: { action: "respond", by: "human", result: { output: "A-SPOOF", metadata: {} } } })
    await locA.reg.tool["execute.before"]({ tool: "websearch", sessionID: "sA", id: "loc-a-fab", input: { query: "x" } })

    // locB's after-hook for the same call id must NOT consume locA's intent
    handler = () => json({ decision: { action: "forward", by: "auto" } })
    const result = { output: "real", content: [{ type: "text", text: "real" }] }
    await locB.reg.tool["execute.after"]({ tool: "websearch", sessionID: "sB", id: "loc-a-fab", input: {}, status: "completed", result })
    expect(result.content).toEqual([{ type: "text", text: "real" }]) // untouched by locA's state
  })
})
