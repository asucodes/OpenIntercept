# How OpenCode executes tools — pipeline map (OpenIntercept)

Ground truth from source, verified by reading `anomalyco/opencode`:
- **stable**: tag `v1.19.4` (what `npm i -g opencode-ai` ships today) — local worktree `reference/opencode-v1.19.4`
- **dev**: branch `dev` (the V2-era engine, headed for future releases) — local worktree `reference/opencode`

All paths below are repo-relative `file:line` references into those worktrees.

## 1. The pipeline for one tool call (stable v1.19.4)

Every standard tool the model invokes goes through a wrapper built in
`packages/opencode/src/session/tools.ts:99-134`:

```
model responds with tool_use(args, callID)
  │
  ├─ ① plugin.trigger("tool.execute.before",
  │        { tool, sessionID, callID },        ← input
  │        { args })                            ← output object (MUTABLE)
  │
  ├─ ② result = item.execute(args, ctx)         the tool actually runs
  │
  ├─ ③ output = { ...result, attachments }      shallow copy
  │
  ├─ ④ plugin.trigger("tool.execute.after",
  │        { tool, sessionID, callID, args },   ← input (note: args included)
  │        output)                              ← output object (MUTABLE)
  │
  └─ ⑤ return output  →  processor.completeToolCall()
         (packages/opencode/src/session/processor.ts:160-184)
         persists state: { status: "completed", input, title,
                           metadata, output } into the session's ToolPart,
         which is what the next LLM request carries as the tool result.
```

**This is OpenIntercept's interception point.** ① is "edit the request" (args),
④ is "edit the response" (result) — both fire before the engine persists
anything, and both are awaited, so a hook that doesn't resolve pauses the
tool mid-flight. OpenCode's TUI just shows the tool as running while we hold.

## 2. The mutation contract (the most important fact)

`Plugin.trigger` (`packages/opencode/src/plugin/index.ts:284-297`):

```ts
const trigger = ... (name, input, output) => {
  for (const hook of hooks) {
    const fn = hook[name]
    if (!fn) continue
    yield* Effect.promise(async () => fn(input, output))   // awaited, in order
  }
  return output                                            // same object
}
```

- Hooks run **sequentially, each fully awaited**. Return values are **ignored**.
- Callers (①–⑤ above) keep using their own local variables — so **reassigning
  `output.args = {...}` or `output = ...` inside a hook does nothing**.
- Edits propagate **only via in-place property mutation**:
  - before: mutate properties of `output.args` (the hook receives a wrapper
    whose `.args` references the very object passed to the tool at ②).
  - after: assign `output.output = "…"`, `output.title = "…"`,
    `output.metadata = …` on the object received at ④ (it IS the object
    returned at ⑤ and persisted at ⑤'s `completeToolCall`).
- Consequence for the adapter core: applying a decision means writing
  properties back into the received object (delete-then-assign for args maps,
  plain assignment for result fields). Never rebind.

## 3. A throwing hook blocks the tool

`Effect.promise` propagates a hook's rejection, which fails the tool
execution — the model receives a tool-part with `status: "error"`. This is a
documented pattern (the ".env protection" example in the official docs) and is
our fallback for a before-stage **drop**: throw instead of return.

## 4. Exact hook signatures (public types)

`packages/plugin/src/index.ts:266-281` (package `@opencode-ai/plugin`):

```ts
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>

"tool.execute.after"?: (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title: string; output: string; metadata: any },
) => Promise<void>
```

`callID` is identical in both stages and equals the tool part's ID
(`options.toolCallId`) — stable correlation key for OpenIntercept.

## 5. Coverage: every tool family funnels through the same hooks

- Standard built-ins: `session/tools.ts:106,121` (bash, read, edit, write,
  grep, glob, apply_patch, webfetch, websearch, question, skill, todowrite…).
- MCP tools: separate wrapper builders in the same `session/tools.ts`
  (`:176,209`, `:259,292`, `:339,374`, `:403,421`) — same hook pair.
- Code-mode tool calls: `packages/opencode/src/tool/code-mode.ts:142,181`.
- Subagent/Task launches: `packages/opencode/src/session/prompt.ts:307,389`
  (same semantics; the Task path keys on `part.id`).

So one V1 adapter intercepts **everything**, including future tools we've
never heard of.

## 6. Result shape and size

Tools return `{ title: string, output: string, metadata }`. Examples:
- `webfetch` (`packages/opencode/src/tool/webfetch.ts:114-145`): output is
  page content as markdown or extracted text; metadata `{}`.
- Truncation is per-tool and happens *before* the after-hook (read caps line
  length/count, glob caps result count and appends a "truncated" notice).
  Output strings can still be large (bash, webfetch) — the panel and
  server must stream/cap rendering but keep full text for editing.

## 7. Plugin discovery (how the adapter gets loaded)

- Auto-discovery: `.opencode/plugin/` **and** `.opencode/plugins/` in the
  project, plus the global config dir equivalent
  (`packages/opencode/src/config/config.ts:476`).
- npm plugins via the `plugin` array in `opencode.json`; Bun installs and
  imports them at startup (`packages/opencode/src/plugin/loader.ts`).
- Both spellings accepted; V2-era docs recommend `.opencode/plugins/`.

## 8. The dev branch (V2 engine) — what changes and what doesn't

`packages/core/src/tool.ts:103-156` (dev):

- Single **mutable event object** replaces the (input, output) pair:
  `execute.before` event = `{ tool, sessionID, agent, messageID, id, input }`
  (`input` = the args).
  `execute.after` event = same base + `status: "completed" | "error"` and
  either `result: { output?, content, metadata? }` or `error`.
- The engine **rebuilds the return value from `afterEvent.result.*` after the
  trigger** (`tool.ts:149-155`) — so both property mutation *and* wholesale
  `event.result = {...}` replacement work in V2. `title` no longer travels in
  the event; `content` (structured blocks) is the new field, `output` the
  legacy string.
- Registration moves from a hooks map to `ctx.tool.hook("execute.before" |
  "execute.after", cb)` inside `Plugin.define({ id, setup })`; plugin files
  still auto-load from `.opencode/plugins/`.

Adapter consequence: `plugin/core.ts` speaks only the OpenIntercept protocol;
`v1.ts` and `v2.ts` each translate their engine's shape (v1: property
mutation; v2: assign into `event.result`).

## 9. Design consequences

1. Plugin POSTs `{tool, args}` at ① and `{tool, args, result}` at ④ to the
   sidecar and **awaits a Decision**; the open HTTP request is the hold.
2. Applying decisions:
   - before/run → return; before/replace → delete-then-assign into
     `output.args`; before/drop → throw (tool fails, model sees error).
   - after/forward → return; after/replace → assign `output.output/.title/.
     metadata`; after/drop → set `output.output = "[dropped by interceptor]"`.
3. Failure isolation: if the sidecar is unreachable, pass through untouched
   (fast local fetch error). Never break the agent.
4. Correlate stages by `callID`; same key names the audit-log entries.
5. Overhead when disabled: one localhost POST per stage (~<1ms). Acceptable;
   future optimization = plugin caches a pushed "off" flag.
6. Hold timeout lives in the plugin too (slightly longer than the server's)
   so a dead panel can never wedge a tool call.

## 10. Generalization outlook (docs/ADAPTERS.md material)

The shape we exploit — *agent executes tool locally, then hands a mutable
result object to extension hooks before persisting it* — is common:
- Claude Code: `PreToolUse` / `PostToolUse` hooks (JSON out can deny/override).
- MCP: tool-call middleware / elicitation / approval flows in gateways.
- Others: OpenAI Agents SDK handoffs, LangGraph interrupt points.

Each adapter's job is identical: translate its agent's call/result shapes
into `@openintercept/protocol`, hold on the wire, apply the Decision. The server
and panel never learn which agent is talking.

## 11. Model-provider HTTP inspection (OpenCode 2.1.4)

The V2 plugin API exposes `session.hook("http.request")` and
`session.hook("http.response")` (`packages/plugin/src/promise/session.ts`,
`SessionHttpRequest` / `SessionHttpResponse`). OpenCode wraps its provider
HTTP client at `packages/core/src/session/model-request.ts:315-336`, passing a
mutable Web `Request` before sending and a `Response` after receiving it.
OpenIntercept uses these hooks for read-only request/response capture; this is
provider traffic inspection, not interception of arbitrary HTTP initiated by
tools. Capture is opt-in because request bodies include prompts and context.
Bodies are previewed up to 64 KiB, and authentication headers plus
secret-looking URL parameters are redacted.

## 12. Optional network proxy boundary

The sidecar can start a loopback forward proxy on port 7475. It records
plaintext HTTP requests and responses up to 64 KiB. HTTPS `CONNECT` is only
tunneled and logged as encrypted metadata: this implementation does not
decrypt TLS, issue or install a CA, or edit proxied HTTP messages. A client
must be configured to use the proxy; this does not automatically redirect all
OpenCode or tool traffic.
