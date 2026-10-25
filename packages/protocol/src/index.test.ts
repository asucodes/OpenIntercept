import { describe, expect, test } from "bun:test"
import {
  argsToText,
  evaluateRules,
  InterceptState,
  Profile,
  ToolCall,
  type Rule,
  type ToolResult,
} from "./index"

const call = (tool: string, args: unknown = {}): ToolCall => ({
  id: "call-1",
  adapter: "opencode-v1",
  tool,
  args,
  session: { id: "s1" },
  startedAt: 0,
})

const result = (output: string): ToolResult => ({ title: "t", output })

const rule = (partial: Partial<Rule>): Rule => ({
  tools: null,
  stages: null,
  action: "hold",
  enabled: true,
  ...partial,
})

describe("evaluateRules", () => {
  test("no rules -> null (pass through untouched)", () => {
    expect(evaluateRules(call("bash"), undefined, [])).toBeNull()
  })

  test("first matching rule wins", () => {
    const rules = [
      rule({ name: "first", tools: ["webfetch"], action: "hold" }),
      rule({ name: "second", tools: ["webfetch"], action: "drop" }),
    ]
    expect(evaluateRules(call("webfetch"), undefined, rules)).toBe("hold")
  })

  test("tool filter: non-matching tool skips rule", () => {
    expect(evaluateRules(call("bash"), undefined, [rule({ tools: ["webfetch"] })])).toBeNull()
  })

  test("disabled rules are skipped", () => {
    expect(evaluateRules(call("bash"), undefined, [rule({ enabled: false })])).toBeNull()
  })

  test("stage filter: before-only rule ignores after-stage call", () => {
    expect(
      evaluateRules(call("bash"), result("hello"), [
        rule({ stages: ["before"], action: "hold" }),
      ]),
    ).toBeNull()
  })

  test("argRegex matches sorted-JSON arg text", () => {
    const rules = [rule({ argRegex: { source: "secret", flags: "i" } })]
    expect(evaluateRules(call("read", { filePath: ".env SECRET" }), undefined, rules)).toBe("hold")
    expect(evaluateRules(call("read", { filePath: "notes.txt" }), undefined, rules)).toBeNull()
  })

  test("argRegex matching is stable across key order", () => {
    expect(argsToText({ b: 1, a: 2 })).toBe(argsToText({ a: 2, b: 1 }))
  })

  test("contentRegex only matches after stage", () => {
    const rules = [rule({ contentRegex: { source: "password" } })]
    expect(evaluateRules(call("webfetch"), result("my password is 123"), rules)).toBe("hold")
    expect(evaluateRules(call("webfetch"), result("nothing here"), rules)).toBeNull()
    // before stage: no result yet, content rule cannot apply
    expect(evaluateRules(call("webfetch"), undefined, rules)).toBeNull()
  })

  test("AND semantics: tool AND contentRegex must both match", () => {
    const rules = [rule({ tools: ["webfetch"], contentRegex: { source: "password" } })]
    expect(evaluateRules(call("read"), result("my password"), rules)).toBeNull()
    expect(evaluateRules(call("webfetch"), result("my password"), rules)).toBe("hold")
  })

  test("invalid regex never matches and never throws", () => {
    const rules = [rule({ argRegex: { source: "([unclosed" } })]
    expect(() => evaluateRules(call("bash"), undefined, rules)).not.toThrow()
    expect(evaluateRules(call("bash"), undefined, rules)).toBeNull()
  })

  test("pass rule short-circuits later hold", () => {
    const rules = [
      rule({ tools: ["grep"], action: "pass" }),
      rule({ action: "hold" }),
    ]
    expect(evaluateRules(call("grep"), undefined, rules)).toBe("pass")
    expect(evaluateRules(call("bash"), undefined, rules)).toBe("hold")
  })
})

describe("profile schema", () => {
  test("parses a minimal hand-written profile with defaults", () => {
    const profile = Profile.parse({
      name: "default",
      rules: [
        { tools: ["webfetch"], action: "hold" },
        { name: "secrets", contentRegex: { source: "api[_-]?key", flags: "i" }, action: "hold" },
      ],
    })
    expect(profile.defaults.holdTimeoutMs).toBe(120_000)
    expect(profile.defaults.onTimeout).toBe("forward")
    expect(profile.defaults.noRule).toBe("pass")
    expect(profile.rules[0]!.tools).toEqual(["webfetch"])
    expect(profile.rules[1]!.contentRegex!.flags).toBe("i")
  })

  test("tool calls carry optional context and session title", () => {
    const call = ToolCall.parse({
      id: "c1",
      adapter: "opencode-v1",
      tool: "webfetch",
      args: {},
      session: { id: "sess-1", title: "Refactor chat" },
      context: { model: "claude-sonnet-4-5", provider: "anthropic", agent: "build" },
      startedAt: 0,
    })
    expect(call.context?.model).toBe("claude-sonnet-4-5")
    expect(call.session.title).toBe("Refactor chat")
    // and stays valid without them (backwards compatible)
    expect(ToolCall.parse({ id: "c2", adapter: "opencode-v1", tool: "bash", args: {}, session: {}, startedAt: 0 }).context).toBeUndefined()
  })

  test("roundtrips state through JSON", () => {
    const state = InterceptState.parse({
      enabled: true,
      profile: Profile.parse({ name: "demo", rules: [] }),
    })
    expect(InterceptState.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  test("rejects unknown rule actions", () => {
    expect(() =>
      Profile.parse({ name: "x", rules: [{ tools: null, action: "nuke" }] }),
    ).toThrow()
  })
})
