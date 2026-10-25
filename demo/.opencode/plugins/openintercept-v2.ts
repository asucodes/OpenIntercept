/**
 * OpenIntercept — OpenCode adapter, dual V1 + V2 in one file.
 *
 * Single-file, zero-dependency, drop-in. The installer writes two variants:
 *  - openintercept.ts    (V1 engines: default export is the callable plugin fn)
 *  - openintercept-v2.ts (V2 engines: default export is { id, setup })
 *
 * LIFECYCLE (the hard-earned part): OpenCode desktop activates the global
 * plugin PER LOCATION in one process. All mutable state therefore lives in
 * per-registration closures — NEVER in module scope, and there is NO
 * process-global generation counter (an earlier design where a newer
 * registration superseded older ones silently muted every other location's
 * hooks). Same-location reloads are handled by the engine's registration
 * scope: we return a cleanup function that deactivates exactly one
 * registration and clears its interval.
 *
 * Semantics per docs/OPENCODE-MAPPING.md: V1/V2 ignore hook return values —
 * edits propagate only via in-place mutation. Hooks are awaited, so holding
 * the fetch pauses the tool mid-flight. Sidecar down/timeout/error: every
 * path fails open — the agent must never break because OpenIntercept is down.
 */

const BASE = process.env.OPENINTERCEPT_URL ?? "http://127.0.0.1:7474"
const FETCH_BACKSTOP_MS = 600_000
const CAPTURE_BODY_LIMIT = 64 * 1024
const WRAPPED_TOOLS = ["webfetch", "websearch"]

// --- flight recorder (OPENINTERCEPT_DEBUG=off to disable) --------------------------
// Reports key events to the sidecar (plugins may not write files in the
// engine sandbox, but fetch is proven to work). Events land in the audit log
// as plugin.debug entries.
let debugOn: boolean | undefined
interface DebugContext {
  instanceID?: string
  location?: string
}

function debugLog(event: string, detail: unknown = "", context?: DebugContext) {
  if (debugOn === undefined) debugOn = process.env.OPENINTERCEPT_DEBUG !== "off"
  if (!debugOn) return
  try {
    void fetch(`${BASE}/api/plugin-log`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event,
        detail: typeof detail === "string" ? detail : JSON.stringify(detail),
        ...(context?.instanceID ? { instanceID: context.instanceID } : {}),
        ...(context?.location ? { location: context.location } : {}),
      }),
      signal: AbortSignal.timeout(3_000),
    }).catch(() => {})
  } catch {
    // diagnostics must never break the plugin
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

async function postDecision(path: string, body: unknown, context?: DebugContext): Promise<{ decision?: any } | null> {
  try {
    const res = await fetch(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_BACKSTOP_MS),
    })
    if (!res.ok) return null
    return await res.json()
  } catch (err) {
    void debugLog("sidecar-fetch-failed", `${path}: ${err instanceof Error ? err.message : String(err)}`, context)
    return null // sidecar down / aborted: fail open, never break the agent
  }
}

async function beacon(adapter: string, spoof?: string, context?: DebugContext) {
  try {
    await fetch(BASE + "/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter,
        ...(adapter === "opencode-v2" && spoof ? { spoof } : {}),
        ...(context?.instanceID ? { instanceID: context.instanceID } : {}),
        ...(context?.location ? { location: context.location } : {}),
        ...(typeof process !== "undefined" && process.pid ? { pid: process.pid } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // heartbeat is best-effort diagnostics
  }
}

/** Delete-then-assign so the engine keeps the SAME object with new content —
 *  rebinding (target = {...}) is silently ignored by both V1 and V2. */
function replaceInPlace(target: Record<string, unknown>, next: Record<string, unknown>) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, next)
}

function modelRefToContext(model: unknown, agent?: string) {
  if (typeof model === "string") {
    const slash = model.indexOf("/")
    return slash === -1
      ? { model, agent }
      : { provider: model.slice(0, slash), model: model.slice(slash + 1), agent }
  }
  const m = model as Record<string, unknown> | null | undefined
  return {
    model: (m?.modelID ?? m?.id) as string | undefined,
    provider: (m?.providerID ?? m?.provider) as string | undefined,
    agent,
  }
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i
const SECRET_QUERY = /(key|token|secret|auth|password)/i

function safeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].map(([name, value]) => [name, SECRET_HEADER.test(name) ? "[REDACTED]" : value]))
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ""
    url.password = ""
    for (const key of [...url.searchParams.keys()]) if (SECRET_QUERY.test(key)) url.searchParams.set(key, "[REDACTED]")
    return url.toString()
  } catch {
    return raw
  }
}

async function bodyPreview(message: Request | Response): Promise<string | undefined> {
  const contentType = message.headers.get("content-type") ?? ""
  if (contentType && !/(json|text|xml|javascript|x-www-form-urlencoded|event-stream)/i.test(contentType)) {
    return `[non-text body omitted: ${contentType}]`
  }
  try {
    const reader = message.clone().body?.getReader()
    if (!reader) return undefined
    const chunks: Uint8Array[] = []
    let length = 0
    let truncated = false
    while (length < CAPTURE_BODY_LIMIT) {
      const { value, done } = await reader.read()
      if (done) break
      const take = value.subarray(0, CAPTURE_BODY_LIMIT - length)
      chunks.push(take)
      length += take.length
      if (take.length < value.length) { truncated = true; break }
    }
    if (!truncated && length >= CAPTURE_BODY_LIMIT) truncated = true
    if (truncated) void reader.cancel().catch(() => {})
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const text = new TextDecoder().decode(bytes)
    return truncated ? `${text}\n[OpenIntercept capture truncated at ${CAPTURE_BODY_LIMIT} bytes]` : text
  } catch {
    return "[body unavailable]"
  }
}

let captureSettingUntil = 0
let captureModelTraffic = false
async function modelCaptureEnabled(): Promise<boolean> {
  if (Date.now() < captureSettingUntil) return captureModelTraffic
  try {
    const res = await fetch(`${BASE}/api/traffic/settings`, { signal: AbortSignal.timeout(2_000) })
    if (res.ok) {
      const settings = await res.json()
      captureModelTraffic = settings.captureModelTraffic === true
    }
  } catch {
    captureModelTraffic = false
  }
  captureSettingUntil = Date.now() + 2_000
  return captureModelTraffic
}

function postTraffic(exchange: unknown) {
  void fetch(`${BASE}/api/traffic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(exchange),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

// --- per-registration state -----------------------------------------------------

/** Everything mutable a registration needs. One per plugin activation —
 *  desktop OpenCode runs several concurrent location activations of the same
 *  global plugin in one process, so none of this may be module-scoped. */
interface RegState {
  modelInfo: Map<string, { model?: string; provider?: string; agent?: string }>
  sessionTitles: Map<string, string>
  callStarts: Map<string, number>
  fabrications: Map<string, { output: string; title?: string; metadata?: any }>
  beforeDecisions: Map<string, any>
  spoofIntent: Map<string, { fab: { output: string; title?: string; metadata?: any } }>
  wrapperHandled: Set<string>
  /** Last provider id reported by a real websearch, used to keep spoofed
   *  websearch results plausible. */
  webSearchProvider?: string
  requestCaptures: WeakMap<Request, any>
  sessionDomain: any
  /** false once this registration's cleanup has run (engine disposal) */
  active: boolean
}

function createState(): RegState {
  return {
    modelInfo: new Map(),
    sessionTitles: new Map(),
    callStarts: new Map(),
    fabrications: new Map(),
    beforeDecisions: new Map(),
    spoofIntent: new Map(),
    wrapperHandled: new Set(),
    requestCaptures: new WeakMap(),
    sessionDomain: null,
    active: true,
  }
}

interface CallCoords {
  callID: string
  tool: string
  sessionID: string
  agent?: string
}

function makeCall(S: RegState, coords: CallCoords, args: unknown, adapter: "opencode-v1" | "opencode-v2", title?: string) {
  const tracked = S.modelInfo.get(coords.sessionID)
  const agent = coords.agent ?? tracked?.agent
  return {
    id: coords.callID,
    adapter,
    tool: coords.tool,
    args,
    session: { id: coords.sessionID, ...(title ? { title } : {}) },
    context: {
      model: tracked?.model,
      provider: tracked?.provider,
      ...(agent ? { agent } : {}),
    },
    startedAt: S.callStarts.get(coords.callID) ?? Date.now(),
  }
}

async function titleFor(S: RegState, sessionID: string): Promise<string | undefined> {
  if (S.sessionTitles.has(sessionID)) return S.sessionTitles.get(sessionID)
  try {
    const res = await S.sessionDomain?.get?.({ path: { id: sessionID } })
    const title = res?.info?.title ?? res?.title ?? res?.data?.title
    if (typeof title === "string" && title.trim()) S.sessionTitles.set(sessionID, title)
  } catch {
    // titles are cosmetic
  }
  return S.sessionTitles.get(sessionID)
}

/** Provider used when a spoofed websearch has no real provider to copy. */
function spoofWebSearchProvider(S: RegState): string {
  return S.webSearchProvider ?? process.env.OPENINTERCEPT_SPOOF_PROVIDER ?? "exa"
}

/** A V2 result the engine accepts without looking manufactured.
 *
 *  The envelope must match the tool's declared Output schema:
 *    webfetch  -> { url, contentType, format, output }
 *    websearch -> { provider, results: [{ url, title?, content?, time }] }
 *  The original URL is preserved and metadata is left to the engine. */
function spoofResultV2(name: string, input: any, text: string, provider: string) {
  const content = [{ type: "text", text }]
  if (name === "webfetch") {
    const url = typeof input?.url === "string" ? input.url : ""
    const format = input?.format === "text" || input?.format === "html" ? input.format : "markdown"
    return {
      output: {
        url,
        contentType: format === "text" ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
        format,
        output: text,
      },
      content,
    }
  }
  if (name === "websearch") {
    return {
      output: {
        provider,
        results: [{ url: "https://example.com/", content: text, time: {} }],
      },
      content,
    }
  }
  return { output: text, content }
}

/** Replace a completed V2 result's model-visible text while keeping the
 *  envelope schema-valid and the engine's own fields intact. */
function applySpoofToV2Result(name: string, result: any, text: string, provider: string) {
  if (!isPlainObject(result)) return
  result.content = [{ type: "text", text }]
  const out = result.output
  if (name === "webfetch" && isPlainObject(out)) {
    result.output = { ...out, output: text }
    return
  }
  if (name === "websearch" && isPlainObject(out)) {
    const realProvider = typeof out.provider === "string" ? out.provider : provider
    const results = Array.isArray(out.results) ? out.results : []
    const first = isPlainObject(results[0]) ? results[0] : null
    result.output = {
      provider: realProvider,
      results: [
        first ? { ...first, content: text } : { url: "https://example.com/", content: text, time: {} },
      ],
    }
    return
  }
  if (typeof out === "string") {
    result.output = text
    return
  }
  if (isPlainObject(out) && typeof out.output === "string") {
    result.output = { ...out, output: text }
  }
  // Unknown structured output: leave the envelope alone; content carries the text.
}

/** Report a spoofed after-stage: `result` is the HONEST original (real
 *  output or error text) for local history; `spoof` is what the model saw.
 *  Neither value carries an operator marker. */
async function reportFabricated(
  path: string,
  call: unknown,
  fab: { output: string; title?: string; metadata?: any },
  realText: string,
  context?: DebugContext,
) {
  await postDecision(path, {
    kind: "after",
    call,
    result: { title: "observed", output: realText, metadata: {} },
    spoof: {
      output: String(fab.output),
      ...(typeof fab.title === "string" ? { title: fab.title } : {}),
      ...(isPlainObject(fab.metadata) ? { metadata: fab.metadata } : {}),
    },
    fabricated: true,
  }, context)
}

/** V2 tools carry a structured `output` object plus `content` parts; the model
 *  sees `content` when non-empty, else stringified `output`. This reproduces
 *  exactly what the model will read. */
function resultTextV2(result: any): string {
  const content = result?.content
  if (typeof content === "string") return content
  if (Array.isArray(content) && content.length > 0) {
    return content
      .map((part: any) =>
        typeof part === "string" ? part : part?.type === "text" ? String(part.text ?? "") : stringify(part),
      )
      .join("\n")
  }
  const output = result?.output
  return typeof output === "string" ? output : stringify(output)
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// The one export: a V1 plugin function that also carries the V2 definition.
// ---------------------------------------------------------------------------

const OpenIntercept = async ({ client }: { client?: any } = {}) => {
  const S = createState()
  S.sessionDomain = client // V1 SDK client, same shape best-effort
  beacon("opencode-v1").catch(() => {})

  // ---- V1 hooks (opencode-ai 1.x CLI) --------------------------------------
  return {
    "chat.params": (input: any) => {
      S.modelInfo.set(input.sessionID, modelRefToContext(input.model, input.agent))
    },

    "tool.execute.before": async (input: any, output: { args: any }) => {
      S.callStarts.set(input.callID, Date.now())
      const res = await postDecision("/api/before", {
        kind: "before",
        call: makeCall(S, input, output.args, "opencode-v1"),
      })
      const decision = res?.decision
      if (!decision) return // fail open
      if (decision.action === "drop") {
        throw new Error("Tool execution failed")
      }
      if (decision.action === "respond" && decision.result) {
        // V1 cannot inject a result before execution. The real tool runs with
        // its ORIGINAL arguments and the after hook replaces the output; the
        // transcript keeps the authentic input and no operator marker.
        S.fabrications.set(input.callID, decision.result)
        return
      }
      if (decision.action === "replace" && isPlainObject(output.args) && isPlainObject(decision.args)) {
        replaceInPlace(output.args, decision.args)
      }
    },

    "tool.execute.after": async (input: any, output: { title: string; output: string; metadata: any }) => {
      const fab = S.fabrications.get(input.callID)
      if (fab) {
        S.fabrications.delete(input.callID)
        const real = String(output.output)
        const realTitle = output.title
        const realMetadata = output.metadata
        output.output = String(fab.output)
        // title and metadata stay exactly what the real tool produced
        await reportFabricated(
          "/api/after",
          makeCall(S, input, input.args, "opencode-v1"),
          { output: String(fab.output), title: realTitle, metadata: realMetadata },
          real,
        )
        S.callStarts.delete(input.callID)
        return
      }
      const res = await postDecision("/api/after", {
        kind: "after",
        call: makeCall(S, input, input.args, "opencode-v1"),
        result: { title: output.title, output: output.output, metadata: output.metadata },
      })
      const decision = res?.decision
      if (!decision) return // fail open
      if (decision.action === "replace" && decision.result) {
        output.output = String(decision.result.output)
        if (typeof decision.result.title === "string") output.title = decision.result.title
        if (isPlainObject(decision.result.metadata)) output.metadata = decision.result.metadata
      } else if (decision.action === "drop") {
        // a dropped result looks like an empty tool result, not interception
        output.output = ""
      }
      S.callStarts.delete(input.callID)
    },
  }
}

// ---- V2 definition (OpenCode desktop / 2.x) ---------------------------------

;(OpenIntercept as any).id = "openintercept"
;(OpenIntercept as any).setup = async (ctx: any) => {
  const S = createState()
  S.sessionDomain = ctx?.session
  const context: DebugContext = {
    instanceID: crypto.randomUUID(),
    ...(typeof ctx?.location?.directory === "string" ? { location: ctx.location.directory } : {}),
  }
  const debug = (event: string, detail: unknown = "") => debugLog(event, detail, context)
  const sendBeacon = () => beacon("opencode-v2", spoofMode, context)
  let spoofMode = "hooks"
  void debug("setup-start")

  // model/provider per session — SessionModelRequest { sessionID, agent, model }
  await ctx.session.hook("model.request", (ev: any) => {
    if (!S.active || !ev?.sessionID) return
    S.modelInfo.set(ev.sessionID, modelRefToContext(ev.model, ev.agent))
  })

  // OpenCode 2.1.4 exposes the actual provider fetch boundary. Capturing is
  // explicitly opt-in because request bodies contain prompts and source code.
  await ctx.session.hook("http.request", async (ev: any) => {
    if (!S.active) return
    if (!(await modelCaptureEnabled())) return
    if (!(ev?.request instanceof Request)) {
      // distinguish "hook fires but payload shape differs" from "hook never
      // fires" — the difference decides the capture strategy
      void debug("hook-http-request-rejected", `payload: ${stringify(ev).slice(0, 200)}`)
      return
    }
    void debug("hook-http-request", `kind=${ev.kind ?? "?"} url=${safeUrl((ev.request as Request).url).slice(0, 120)}`)
    const id = crypto.randomUUID()
    const request = ev.request as Request
    const refContext = modelRefToContext(ev.model)
    const exchange = {
      id,
      channel: "model",
      startedAt: Date.now(),
      context: {
        sessionID: ev.sessionID,
        agent: ev.agent,
        provider: refContext.provider,
        model: refContext.model,
        kind: ev.kind,
      },
      request: {
        method: request.method,
        url: safeUrl(request.url),
        headers: safeHeaders(request.headers),
        body: await bodyPreview(request),
      },
    }
    S.requestCaptures.set(request, exchange)
    postTraffic(exchange)
  })

  await ctx.session.hook("http.response", async (ev: any) => {
    if (!S.active) return
    if (!(await modelCaptureEnabled())) return
    if (!(ev?.request instanceof Request) || !(ev?.response instanceof Response)) {
      if (ev) void debug("hook-http-response-rejected", `payload: ${stringify(ev).slice(0, 200)}`)
      return
    }
    void debug("hook-http-response", `status=${(ev.response as Response).status}`)
    const request = ev.request as Request
    const previous = S.requestCaptures.get(request)
    const response = ev.response as Response
    const refContext = modelRefToContext(ev.model)
    const exchange = {
      ...(previous ?? {
        id: crypto.randomUUID(),
        channel: "model",
        startedAt: Date.now(),
        context: {
          sessionID: ev.sessionID,
          agent: ev.agent,
          provider: refContext.provider,
          model: refContext.model,
          kind: ev.kind,
        },
        request: { method: request.method, url: safeUrl(request.url), headers: safeHeaders(request.headers) },
      }),
      response: {
        at: Date.now(),
        status: response.status,
        statusText: response.statusText,
        headers: safeHeaders(response.headers),
        body: await bodyPreview(response),
      },
    }
    postTraffic(exchange)
  })

  // ToolExecuteBefore { tool, sessionID, agent, messageID, id, input }
  await ctx.tool.hook("execute.before", async (event: any) => {
    // Log before checking lifecycle state. An absent entry now means the engine
    // never invoked this callback, rather than an inactive registration hiding it.
    void debug("hook-before-enter", { tool: event.tool, id: event.id, active: S.active })
    if (!S.active) return
    void debug("hook-before", `${event.tool} id=${event.id}`)
    const title = await titleFor(S, event.sessionID)
    S.callStarts.set(event.id, Date.now())
    const res = await postDecision("/api/before", {
      kind: "before",
      call: makeCall(
        S,
        { callID: event.id, tool: event.tool, sessionID: event.sessionID, agent: event.agent },
        event.input,
        "opencode-v2",
        title,
      ),
    }, context)
    const decision = res?.decision
    if (!decision) {
      S.callStarts.delete(event.id)
      return // fail open
    }
    S.beforeDecisions.set(event.id, decision)
    if (decision.action === "drop") {
      throw new Error("Tool execution failed")
    }
    if (decision.action === "respond" && decision.result) {
      // The wrapper returns a schema-correct result without running the tool.
      // If the wrapper never runs, the after hook replaces the real output.
      S.spoofIntent.set(event.id, { fab: decision.result })
      return
    }
    if (decision.action === "replace" && isPlainObject(event.input) && isPlainObject(decision.args)) {
      replaceInPlace(event.input, decision.args)
    }
  })

  // ToolExecuteAfter { ..., status: "completed", result } | { status: "error", error }
  await ctx.tool.hook("execute.after", async (event: any) => {
    void debug("hook-after-enter", { tool: event.tool, id: event.id, active: S.active, status: event.status })
    if (!S.active) return
    void debug("hook-after", `${event.tool} id=${event.id} status=${event.status}`)
    const intent = S.spoofIntent.get(event.id)
    if (intent) {
      S.spoofIntent.delete(event.id)
      const handledByWrapper = S.wrapperHandled.delete(event.id)
      if (event.tool === "websearch" && event.status === "completed") {
        const provider = event.result?.output?.provider
        if (typeof provider === "string") S.webSearchProvider = provider
      }
      const real = handledByWrapper
        ? "(not executed)"
        : event.status === "completed"
          ? resultTextV2(event.result ?? {})
          : `error: ${event.error?.message ?? String(event.error)}`
      if (event.status === "completed") {
        if (!handledByWrapper) {
          applySpoofToV2Result(event.tool, event.result ?? {}, String(intent.fab.output), spoofWebSearchProvider(S))
        }
      }
      // A tool failure cannot be turned into a success here. Leave the real
      // error intact; the local record still shows that a spoof was intended.
      await reportFabricated(
        "/api/after",
        makeCall(
          S,
          { callID: event.id, tool: event.tool, sessionID: event.sessionID, agent: event.agent },
          event.input,
          "opencode-v2",
          await titleFor(S, event.sessionID),
        ),
        intent.fab,
        real,
        context,
      )
      S.callStarts.delete(event.id)
      return
    }
    S.wrapperHandled.delete(event.id)
    const failed = event.status !== "completed"
    const result = event.result ?? {}
    if (event.tool === "websearch" && !failed && isPlainObject(result.output) && typeof result.output.provider === "string") {
      S.webSearchProvider = result.output.provider
    }
    const failureText = failed ? `error: ${event.error?.message ?? String(event.error)}` : undefined
    const title = await titleFor(S, event.sessionID)
    const res = await postDecision("/api/after", {
      kind: "after",
      call: makeCall(
        S,
        { callID: event.id, tool: event.tool, sessionID: event.sessionID, agent: event.agent },
        event.input,
        "opencode-v2",
        title,
      ),
      result: {
        title: failed ? "Tool error" : undefined,
        output: failed ? failureText : resultTextV2(result),
        ...(isPlainObject(failed ? event.error?.metadata : result.metadata) ? { metadata: failed ? event.error.metadata : result.metadata } : {}),
      },
    }, context)
    const decision = res?.decision
    if (!decision) {
      S.callStarts.delete(event.id)
      return // fail open
    }
    if (decision.action === "replace" && decision.result) {
      if (failed) {
        try {
          event.error.message = String(decision.result.output)
          if (isPlainObject(decision.result.metadata)) event.error.metadata = decision.result.metadata
        } catch { /* preserve the original engine failure if it is immutable */ }
      } else {
        applySpoofToV2Result(event.tool, result, String(decision.result.output), spoofWebSearchProvider(S))
        if (isPlainObject(decision.result.metadata)) result.metadata = decision.result.metadata
      }
    } else if (decision.action === "drop") {
      if (failed) {
        try { event.error.message = "Tool execution failed" } catch { /* best effort */ }
      } else {
        applySpoofToV2Result(event.tool, result, "", spoofWebSearchProvider(S))
      }
    }
    S.callStarts.delete(event.id)
  })

  // ---- spoofer v2: wrap the fetch tools' execute (optimization) --------------
  // NOT load-bearing for interception: the hooks above handle hold/replace/
  // respond/drop on their own. When the engine flushes this transform, a
  // respond-decision returns a green spoof WITHOUT running the real tool and
  // restores the authentic URL in the transcript. If the callback never runs
  // (observed on 2.1.4), the hook path above still delivers via the sidecar.
  if (process.env.OPENINTERCEPT_NO_WRAPPER !== "1") {
    let wrapReason = ""
    try {
      await ctx.tool.transform((editor: any) => {
        for (const name of WRAPPED_TOOLS) {
          const original = editor.get?.(name)
          if (!original || typeof original.execute !== "function") continue
          const originalExecute = original.execute
          editor.update?.(name, (t: any) => {
            t.execute = async (input: any, context: any) => {
              const callID = context?.id ?? context?.callID
              if (!S.active || !callID || !context?.sessionID) return originalExecute(input, context)
              S.wrapperHandled.add(callID)
              void debug("wrapper-execute", `${name} id=${callID}`)
              const decision = S.beforeDecisions.get(callID)
              S.beforeDecisions.delete(callID)
              if (!decision) return originalExecute(input, context) // hook failed open
              if (decision.action === "drop") {
                throw new Error("Tool execution failed")
              }
              if (decision.action === "respond" && decision.result) {
                // The real tool never runs; arguments stay exactly as the
                // model emitted them and the envelope matches the tool schema.
                return spoofResultV2(name, input, String(decision.result.output), spoofWebSearchProvider(S))
              }
              return originalExecute(input, context)
            }
          })
        }
      })
    } catch (err) {
      wrapReason = String((err as any)?.message ?? err).slice(0, 60)
    }
    spoofMode = wrapReason ? `fallback (${wrapReason})` : "fallback (callback-never-ran)"
  } else {
    spoofMode = "fallback (env)"
  }
  void debug("setup-end", `spoofMode=${spoofMode}`)

  // periodic heartbeat: proves liveness across sidecar restarts; cleared on
  // this registration's disposal
  const interval = setInterval(() => {
    if (!S.active) return
    sendBeacon().catch(() => {})
    // leak guard: coordination maps self-heal if an engine path ever skips
    // the after hook that consumes them
    if (S.beforeDecisions.size > 256) S.beforeDecisions.clear()
    if (S.spoofIntent.size > 256) S.spoofIntent.clear()
    if (S.wrapperHandled.size > 256) S.wrapperHandled.clear()
  }, 60_000)
  sendBeacon().catch(() => {})

  // registration-scope cleanup: deactivates ONLY this registration (the
  // engine calls it when this location unloads/reloads the plugin)
  return async () => {
    S.active = false
    clearInterval(interval)
    void debug("registration-disposed")
  }
}

export default { id: (OpenIntercept as any).id, setup: (OpenIntercept as any).setup }
