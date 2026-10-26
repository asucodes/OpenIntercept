import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Profile, evaluateRules, type ToolCall } from "@openintercept/protocol"
import { Store, statusOf } from "./store"

const call = (id: string): ToolCall => ({
  id,
  adapter: "opencode-v1",
  tool: "webfetch",
  args: { url: "https://x" },
  session: {},
  startedAt: 0,
})

const store = () =>
  new Store(null, { enabled: false, profile: Profile.parse({ name: "t", rules: [] }) })

describe("state persistence", () => {
  test("capture/proxy opt-in flags SURVIVE a restart via load()", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openintercept-state-"))
    const stateFile = path.join(dir, "state.json")
    await writeFile(stateFile, JSON.stringify({
      enabled: true,
      profile: { name: "default", rules: [{ tools: ["webfetch"], action: "hold" }] },
      captureModelTraffic: true,
      networkProxyEnabled: true,
    }), "utf8")
    const loaded = await Store.load(stateFile)
    expect(loaded.enabled).toBe(true)
    expect(loaded.captureModelTraffic).toBe(true) // the bug these assert against reset them to false
    expect(loaded.networkProxyEnabled).toBe(true)
  })

  test("corrupt state file falls back to safe defaults", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openintercept-state-"))
    const stateFile = path.join(dir, "state.json")
    await writeFile(stateFile, "{not json", "utf8")
    const loaded = await Store.load(stateFile)
    expect(loaded.captureModelTraffic).toBe(false)
    expect(loaded.networkProxyEnabled).toBe(false)
  })
})

describe("status derivation", () => {
  test("entry interrupted between after-observation and decision serializes as running", () => {
    const s = store()
    const entry = s.observeBefore(call("c1"))
    s.observeAfter(call("c1"), { title: "t", output: "o" })
    // simulate a crashed /api/after: decision never recorded, no pending flag
    entry.pendingStage = null
    expect(statusOf(entry)).toBe("running")
    expect(() => JSON.stringify(entry)).not.toThrow()
  })

  test("held-after entry (decision null) serializes cleanly for the panel", () => {
    const s = store()
    const entry = s.observeBefore(call("c3"))
    s.observeAfter(call("c3"), { title: "t", output: "o" })
    entry.pendingStage = "after" // what markHeld does
    expect(statusOf(entry)).toBe("held-after")
    const flags = { argsEdited: false, resultEdited: false }
    expect(flags.resultEdited).toBe(false)
    expect(() => JSON.stringify({ ...entry, status: statusOf(entry) })).not.toThrow()
  })

  test("event subscriber throwing must not propagate", () => {
    const s = store()
    let received = false
    s.bus.on(() => {
      throw new Error("aborted stream")
    })
    s.bus.on(() => {
      received = true
    })
    // The store logs the swallowed failure; silence it so the run stays clean.
    const original = console.error
    const logged: unknown[] = []
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    try {
      s.observeBefore(call("c2")) // triggers bus.emit
    } finally {
      console.error = original
    }
    expect(received).toBe(true)
    expect(logged.length).toBeGreaterThan(0)
  })
})

describe("default profile fetch coverage", () => {
  test("default rules hold code-mode and shell fetches, not plain compute", () => {
    const profile = Store.defaultProfile()
    const holdFor = (tool: string, args: unknown) =>
      evaluateRules(
        { id: "x", adapter: "opencode-v2", tool, args, session: {}, startedAt: 0 },
        undefined,
        profile.rules,
      )
    // the exact evasion from the field: fetch() inside execute code
    expect(holdFor("execute", { code: 'const r = await fetch("https://example.org/security/challenge.txt")' })).toBe("hold")
    expect(holdFor("shell", { command: "curl -s https://x/y" })).toBe("hold")
    expect(holdFor("bash", { command: "wget https://x/y" })).toBe("hold")
    // plain computation and local commands are NOT held
    expect(holdFor("execute", { code: "return [1,2,3].map(x => x * 2)" })).toBeNull()
    expect(holdFor("shell", { command: "ls -la" })).toBeNull()
  })
})
