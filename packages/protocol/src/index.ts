/**
 * @openintercept/protocol — the agent-agnostic wire contract.
 *
 * Everything that crosses a process boundary (plugin adapter -> sidecar
 * server -> panel) is validated against the schemas in this file. Adapters
 * translate their host agent's concepts INTO these types and never leak
 * agent internals — that is what makes OpenIntercept generalizable.
 */
import { z } from "zod"

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Unique per tool invocation, stable across the before/after stages. */
export const CallId = z.string().min(1)
export type CallId = z.infer<typeof CallId>

/** Which adapter produced the call. Extend as new agents are supported. */
export const AdapterId = z.enum(["opencode-v1", "opencode-v2"])
export type AdapterId = z.infer<typeof AdapterId>

/** Opaque session coordinates — OpenIntercept never interprets these. */
export const SessionRef = z.object({
  id: z.string().optional(),
  messageId: z.string().optional(),
  /** Human-readable chat/thread title when the adapter knows it. */
  title: z.string().optional(),
})
export type SessionRef = z.infer<typeof SessionRef>

/** Extra call context the adapter can supply when available. */
export const CallContext = z.object({
  /** Agent/subagent name, e.g. "build", "plan" */
  agent: z.string().optional(),
  /** Model that requested the tool call, e.g. "claude-sonnet-4-5" */
  model: z.string().optional(),
  /** Provider of that model, e.g. "anthropic" */
  provider: z.string().optional(),
})
export type CallContext = z.infer<typeof CallContext>

// ---------------------------------------------------------------------------
// Tool calls and results
// ---------------------------------------------------------------------------

export const ToolCall = z.object({
  id: CallId,
  adapter: AdapterId,
  tool: z.string(),
  /** Tool arguments, validated as arbitrary JSON by design: adapters decide
   *  their agent's arg shapes, OpenIntercept only ever displays/edits them. */
  args: z.unknown(),
  session: SessionRef,
  /** Who made this call (model/provider/agent) — optional, shown in the panel. */
  context: CallContext.optional(),
  startedAt: z.number(),
})
export type ToolCall = z.infer<typeof ToolCall>

export const ToolResult = z.object({
  title: z.string().optional(),
  output: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type ToolResult = z.infer<typeof ToolResult>

/** Read-only capture of one outbound HTTP exchange. Bodies are bounded text
 *  previews; credentials are redacted before the adapter sends this record. */
export const TrafficExchange = z.object({
  id: z.string().min(1),
  channel: z.enum(["model", "network"]),
  startedAt: z.number(),
  context: z.object({
    sessionID: z.string().optional(),
    agent: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    kind: z.string().optional(),
  }).optional(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().optional(),
  }),
  response: z.object({
    at: z.number(),
    status: z.number(),
    statusText: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().optional(),
  }).optional(),
})
export type TrafficExchange = z.infer<typeof TrafficExchange>

/** Interception points. "before" = args not yet given to the tool,
 *  "after" = tool finished, result not yet returned to the agent. */
export const Stage = z.enum(["before", "after"])
export type Stage = z.infer<typeof Stage>

// ---------------------------------------------------------------------------
// Wire requests (adapter -> server)
// ---------------------------------------------------------------------------

export const CallRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("before"), call: ToolCall }),
  z.object({
    kind: z.literal("after"),
    call: ToolCall,
    result: ToolResult,
    /** true when the adapter already replaced the real output with a
     *  fabricated "respond" result decided at the before stage */
    fabricated: z.boolean().optional(),
    /** the fabricated replacement — when present, `result` carries the REAL
     *  observed output (or error text) so history keeps an honest original */
    spoof: ToolResult.optional(),
  }),
])
export type CallRequest = z.infer<typeof CallRequest>

/** Allowed actions per stage are enforced by the server:
 *  before -> run | replace | drop ; after -> forward | replace | drop. */
/** Allowed actions per stage are enforced by the server:
 *  before -> run | replace | respond | drop ; after -> forward | replace | drop.
 *  "respond" = fabricate the result: the tool runs, but its output is
 *  discarded and replaced by decision.result before the model sees it. */
export const Decision = z.object({
  action: z.enum(["run", "replace", "respond", "forward", "drop"]),
  args: z.unknown().optional(),
  result: ToolResult.optional(),
  by: z.enum(["human", "timeout", "auto"]),
  reason: z.string().optional(),
})
export type Decision = z.infer<typeof Decision>

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Regexes travel as source+flags so profiles stay plain JSON. */
export const RegexSpec = z.object({
  source: z.string().min(1),
  flags: z.string().default(""),
})
export type RegexSpec = z.infer<typeof RegexSpec>

export const RuleAction = z.enum(["hold", "pass", "drop"])
export type RuleAction = z.infer<typeof RuleAction>

export const Rule = z.object({
  name: z.string().optional(),
  /** null = any tool. */
  tools: z.array(z.string()).nullable().default(null),
  /** null = both stages. A rule needing contentRegex only makes sense
   *  for the "after" stage and simply never matches "before". */
  stages: z.array(Stage).nullable().default(null),
  /** Tested against a stable string form of the call args. */
  argRegex: RegexSpec.optional(),
  /** Tested against ToolResult.output (after stage only). */
  contentRegex: RegexSpec.optional(),
  action: RuleAction,
  enabled: z.boolean().default(true),
})
export type Rule = z.infer<typeof Rule>

export const Profile = z.object({
  name: z.string(),
  rules: z.array(Rule),
  defaults: z
    .object({
      holdTimeoutMs: z.number().int().positive().default(120_000),
      onTimeout: z.enum(["forward", "drop"]).default("forward"),
      /** What happens to a call that matches no rule while intercept is on.
       *  "pass" (fail-open, default) or "hold" (Burp-style hold-everything). */
      noRule: z.enum(["pass", "hold"]).default("pass"),
    })
    // prefault: the fallback {} is parsed through the schema so inner
    // defaults (120s / forward) are applied — .default({}) in zod 4 would
    // return the empty object literally.
    .prefault({}),
})
export type Profile = z.infer<typeof Profile>

export const InterceptState = z.object({
  enabled: z.boolean(),
  profile: Profile,
})
export type InterceptState = z.infer<typeof InterceptState>

// ---------------------------------------------------------------------------
// Rule evaluation (pure — shared by server and adapters)
// ---------------------------------------------------------------------------

const regexCache = new Map<string, RegExp>()

function compile(spec: RegexSpec): RegExp | null {
  const key = spec.flags + "\u0000" + spec.source
  let re = regexCache.get(key)
  if (re) return re
  try {
    re = new RegExp(spec.source, spec.flags)
  } catch {
    return null // invalid pattern: rule can never match
  }
  regexCache.set(key, re)
  return re
}

function matches(spec: RegexSpec, text: string): boolean {
  const re = compile(spec)
  return re !== null && re.test(text)
}

/** Stable string form of args for regex testing: JSON with sorted keys so
 *  equal arguments always produce equal text regardless of insertion order. */
export function argsToText(args: unknown): string {
  try {
    return stableStringify(args)
  } catch {
    return String(args)
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v)).join(",") + "}"
}

/**
 * First-match-wins rule chain. Returns null when no rule matches, which the
 * caller translates into the default action (pass through untouched).
 */
export function evaluateRules(call: ToolCall, result: ToolResult | undefined, rules: Rule[]): RuleAction | null {
  const match = firstMatchingRule(call, result, rules)
  return match ? match.rule.action : null
}

/** Same chain, but also identifies the winning rule (name/index). */
export function firstMatchingRule(
  call: ToolCall,
  result: ToolResult | undefined,
  rules: Rule[],
): { rule: Rule; index: number } | null {
  const stage: Stage = result === undefined ? "before" : "after"
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!
    if (!rule.enabled) continue
    if (rule.tools && !rule.tools.includes(call.tool)) continue
    if (rule.stages && !rule.stages.includes(stage)) continue
    if (rule.argRegex && !matches(rule.argRegex, argsToText(call.args))) continue
    if (rule.contentRegex) {
      if (stage !== "after" || !result) continue
      if (!matches(rule.contentRegex, result.output)) continue
    }
    return { rule, index: i }
  }
  return null
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export const AuditEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call.observed"), at: z.number(), stage: Stage, call: ToolCall }),
  z.object({ type: z.literal("call.held"), at: z.number(), callId: CallId, stage: Stage }),
  z.object({ type: z.literal("call.released"), at: z.number(), callId: CallId, stage: Stage, decision: Decision }),
  z.object({
    type: z.literal("rule.decision"),
    at: z.number(),
    callId: CallId,
    stage: Stage,
    action: RuleAction,
    ruleName: z.string().nullable(),
  }),
])
export type AuditEvent = z.infer<typeof AuditEvent>
