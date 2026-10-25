import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  argsToText,
  Profile,
  type CallId,
  type Decision,
  type Profile as ProfileT,
  type ToolCall,
  type ToolResult,
  type TrafficExchange,
} from "@openintercept/protocol"

const HISTORY_CAP = 1000

export type EntryStatus =
  | "held-before" // waiting for human at the args stage
  | "running" // released at before, tool executing
  | "held-after" // waiting for human at the result stage
  | "blocked" // dropped at before — tool never ran
  | "forwarded" // completed, result passed unchanged
  | "edited" // completed, result edited by human
  | "fabricated" // completed, real result replaced by a "respond" fabrication
  | "dropped" // completed, result suppressed
  | "error" // the tool FAILED and the error was forwarded as-is

export interface HistoryEntry {
  seq: number
  id: CallId
  adapter: ToolCall["adapter"]
  tool: string
  args: unknown
  argsText: string
  session: ToolCall["session"]
  sessionTitle?: string
  context?: ToolCall["context"]
  startedAt: number
  /** stage currently held by a human, if any */
  pendingStage: "before" | "after" | null
  before?: { at: number; decision: Decision; ruleName: string | null; held: boolean }
  after?: {
    at: number
    result: ToolResult
    originalResult: ToolResult
    /** null while the after-stage hold is pending a decision */
    decision: Decision | null
    ruleName: string | null
    held: boolean
  }
}

export type BusEvent =
  | { type: "state"; enabled: boolean; profile: ProfileT }
  | { type: "entry"; entry: HistoryEntry }
  | { type: "held"; key: string; callId: CallId; stage: "before" | "after"; tool: string; createdAt: number }
  | { type: "released"; key: string; entry: HistoryEntry; decision: Decision }
  | { type: "cleared" }
  | { type: "agent"; adapter: string; at: number; pid?: number; spoof?: string; location?: string; instanceID?: string }
  | { type: "traffic"; exchange: TrafficExchange }

class EventBus {
  private subs = new Set<(ev: BusEvent) => void>()
  on(sub: (ev: BusEvent) => void): () => void {
    this.subs.add(sub)
    return () => this.subs.delete(sub)
  }
  emit(ev: BusEvent) {
    // a failing subscriber (e.g. an aborted SSE stream) must never be able
    // to throw back into the interception flow
    for (const sub of this.subs) {
      try {
        sub(ev)
      } catch (err) {
        console.error("[openintercept] event subscriber failed:", err)
      }
    }
  }
}

export function statusOf(entry: HistoryEntry): EntryStatus {
  if (entry.before?.decision.action === "drop") return "blocked"
  if (entry.pendingStage) return entry.pendingStage === "before" ? "held-before" : "held-after"
  if (!entry.after) return "running"
  // defensive: an after stage whose decision was never recorded (e.g. an
  // interrupted request) must not poison history serialization
  if (!entry.after.decision) return "running"
  if (entry.after.decision.reason === "fabricated") return "fabricated"
  switch (entry.after.decision.action) {
    case "forward":
    case "run":
      // a failed tool whose error text went to the model unchanged
      return entry.after.result.title === "Tool error" ? "error" : "forwarded"
    case "replace":
      return "edited"
    case "drop":
      return "dropped"
    default:
      return "forwarded"
  }
}

export function flagsOf(entry: HistoryEntry) {
  return {
    argsEdited: entry.before?.decision?.action === "replace",
    resultEdited: entry.after?.decision?.action === "replace",
  }
}

/** Client-facing serialization: everything the panel needs, resolvers excluded. */
export function serializeEntry(entry: HistoryEntry) {
  return { ...entry, status: statusOf(entry), flags: flagsOf(entry) }
}

export interface PersistedState {
  enabled: boolean
  profile: ProfileT
  /** Sensitive model HTTP capture is explicitly opt-in. */
  captureModelTraffic?: boolean
  /** Starts the optional plain-HTTP proxy; HTTPS CONNECT is tunnel-only. */
  networkProxyEnabled?: boolean
}

/**
 * In-memory history + intercept state, persisted as JSON so a restart keeps
 * your configuration. History itself is not persisted — the audit JSONL is
 * the durable record.
 */
export class Store {
  readonly bus = new EventBus()
  enabled = false
  profile: ProfileT
  captureModelTraffic = false
  networkProxyEnabled = false
  private entries = new Map<CallId, HistoryEntry>()
  private order: CallId[] = []
  private seq = 0
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  /** Last heartbeat per plugin activation — desktop runs one per active location. */
  readonly agents = new Map<string, { adapter: string; at: number; pid?: number; spoof?: string; location?: string; instanceID?: string }>()
  private traffic = new Map<string, TrafficExchange>()
  private trafficOrder: string[] = []

  constructor(
    private readonly stateFile: string | null,
    initial: PersistedState,
  ) {
    this.enabled = initial.enabled
    this.profile = initial.profile
    this.captureModelTraffic = initial.captureModelTraffic ?? false
    this.networkProxyEnabled = initial.networkProxyEnabled ?? false
  }

  static defaultProfile(): ProfileT {
    return Profile.parse({
      name: "default",
      rules: [
        { name: "hold web traffic", tools: ["webfetch", "websearch"], action: "hold" },
        {
          // code-mode evasion: the model running fetch() inside execute
          name: "hold code-mode fetches",
          tools: ["execute"],
          argRegex: { source: "fetch\\s*\\(|https?://", flags: "i" },
          action: "hold",
        },
        {
          // shell evasion: curl/wget or any URL inside a shell command
          name: "hold shell fetches",
          tools: ["bash", "shell"],
          argRegex: { source: "curl|wget|invoke-webrequest|iwr |https?://", flags: "i" },
          action: "hold",
        },
      ],
    })
  }

  /** Upgrade a stored profile that is still the untouched old default
   *  (single webfetch/websearch rule) to the current default with fetch
   *  coverage for code-mode and shell tools. */
  private static needsDefaultUpgrade(profile: ProfileT): boolean {
    return (
      profile.rules.length === 1 &&
      profile.rules[0]!.name === "hold web traffic" &&
      (profile.rules[0]!.tools ?? []).join(",") === "webfetch,websearch"
    )
  }

  static async load(stateFile: string | null): Promise<Store> {
    let initial: PersistedState = { enabled: false, profile: Store.defaultProfile(), captureModelTraffic: false, networkProxyEnabled: false }
    if (stateFile) {
      try {
        const raw = JSON.parse(await readFile(stateFile, "utf8")) as PersistedState
        const profile = Profile.parse(raw.profile)
        initial = {
          enabled: !!raw.enabled,
          profile: Store.needsDefaultUpgrade(profile) ? Store.defaultProfile() : profile,
          // feature flags MUST survive restarts — the plugin polls them and
          // the proxy auto-start depends on them
          captureModelTraffic: raw.captureModelTraffic === true,
          networkProxyEnabled: raw.networkProxyEnabled === true,
        }
      } catch {
        // missing or corrupt state file — fall back to defaults
      }
    }
    return new Store(stateFile, initial)
  }

  snapshot(): PersistedState {
    return {
      enabled: this.enabled,
      profile: this.profile,
      captureModelTraffic: this.captureModelTraffic,
      networkProxyEnabled: this.networkProxyEnabled,
    }
  }

  setTrafficSettings(patch: { captureModelTraffic?: boolean; networkProxyEnabled?: boolean }) {
    if (patch.captureModelTraffic !== undefined) this.captureModelTraffic = patch.captureModelTraffic
    if (patch.networkProxyEnabled !== undefined) this.networkProxyEnabled = patch.networkProxyEnabled
    this.persist()
    this.bus.emit({ type: "state", enabled: this.enabled, profile: this.profile })
  }

  observeTraffic(exchange: TrafficExchange) {
    const existing = this.traffic.get(exchange.id)
    const merged = existing
      ? { ...existing, ...exchange, request: exchange.request ?? existing.request, response: exchange.response ?? existing.response }
      : exchange
    this.traffic.set(exchange.id, merged)
    if (!existing) this.trafficOrder.push(exchange.id)
    while (this.trafficOrder.length > HISTORY_CAP) {
      const oldest = this.trafficOrder.shift()
      if (oldest) this.traffic.delete(oldest)
    }
    this.bus.emit({ type: "traffic", exchange: merged })
    return merged
  }

  listTraffic(limit = 200) {
    return this.trafficOrder.slice(-limit).reverse().map((id) => this.traffic.get(id)!).filter(Boolean)
  }

  getTraffic(id: string): TrafficExchange | undefined {
    return this.traffic.get(id)
  }

  /** Drop in-memory traffic history (audit JSONL is never touched). */
  clearTraffic() {
    this.traffic.clear()
    this.trafficOrder = []
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    this.persist()
    this.bus.emit({ type: "state", enabled, profile: this.profile })
  }

  setProfile(profile: ProfileT) {
    this.profile = profile
    this.persist()
    this.bus.emit({ type: "state", enabled: this.enabled, profile })
  }

  defaults() {
    return this.profile.defaults
  }

  // --- entry lifecycle -----------------------------------------------------

  observeBefore(call: ToolCall): HistoryEntry {
    // idempotent: an adapter retry of a known call must not reset its history
    const existing = this.entries.get(call.id)
    if (existing) {
      this.touch(existing)
      return existing
    }
    const entry: HistoryEntry = {
      seq: ++this.seq,
      id: call.id,
      adapter: call.adapter,
      tool: call.tool,
      args: call.args,
      argsText: argsToText(call.args),
      session: call.session,
      sessionTitle: call.session.title,
      context: call.context,
      startedAt: call.startedAt,
      pendingStage: null,
    }
    this.remember(entry)
    return entry
  }

  observeAfter(call: ToolCall, result: ToolResult): HistoryEntry {
    const entry = this.entries.get(call.id) ?? this.observeBefore(call)
    entry.after = { at: Date.now(), result, originalResult: result, decision: null, held: false, ruleName: null }
    this.touch(entry)
    return entry
  }

  markHeld(callId: CallId, stage: "before" | "after", key: string, tool: string) {
    const entry = this.entries.get(callId)
    if (!entry) return
    entry.pendingStage = stage
    this.touch(entry)
    this.bus.emit({ type: "held", key, callId, stage, tool, createdAt: Date.now() })
  }

  /** Record a decision (held or automatic) and clear the pending flag. */
  markDecided(callId: CallId, stage: "before" | "after", decision: Decision, ruleName: string | null, held: boolean) {
    const entry = this.entries.get(callId)
    if (!entry) return
    const at = Date.now()
    if (stage === "before") {
      entry.before = { at, decision, ruleName, held }
    } else if (entry.after) {
      entry.after.at = at
      entry.after.decision = decision
      entry.after.ruleName = ruleName
      entry.after.held = held
    }
    entry.pendingStage = null
    this.touch(entry)
    this.bus.emit({ type: "released", key: `${callId}:${stage}`, entry, decision })
  }

  /** Apply a replace decision's payload to the stored final result. */
  applyResultEdit(callId: CallId, result: ToolResult) {
    const entry = this.entries.get(callId)
    if (entry?.after) entry.after.result = result
    this.touch(entry)
  }

  applyArgsEdit(callId: CallId, args: unknown) {
    const entry = this.entries.get(callId)
    if (!entry) return
    entry.args = args
    entry.argsText = argsToText(args)
    this.touch(entry)
  }

  get(callId: CallId): HistoryEntry | undefined {
    return this.entries.get(callId)
  }

  list(limit = 500): HistoryEntry[] {
    return this.order
      .slice(-limit)
      .reverse()
      .map((id) => this.entries.get(id)!)
      .filter(Boolean)
  }

  /** Drop in-memory history (the JSONL audit trail is never touched). */
  clear() {
    this.entries.clear()
    this.order = []
    this.bus.emit({ type: "cleared" })
  }

  /** A plugin registered itself — record the heartbeat and tell the panel. */
  noteAgent(adapter: string, pid?: number, spoof?: string, location?: string, instanceID?: string) {
    const beacon = { adapter, at: Date.now(), pid, spoof, location, instanceID }
    // Legacy adapters omit both values and retain their previous one-per-adapter behavior.
    const key = instanceID ? `${adapter}:${instanceID}` : location ? `${adapter}:${location}` : adapter
    this.agents.set(key, beacon)
    this.bus.emit({ type: "agent", ...beacon })
  }

  private remember(entry: HistoryEntry) {
    this.entries.set(entry.id, entry)
    this.order.push(entry.id)
    if (this.order.length > HISTORY_CAP) {
      const evict = this.order.shift()!
      this.entries.delete(evict)
    }
    this.touch(entry)
  }

  private touch(entry?: HistoryEntry) {
    if (!entry) return
    this.bus.emit({ type: "entry", entry })
  }

  private persist() {
    const file = this.stateFile
    if (!file) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(async () => {
      try {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify(this.snapshot(), null, 2), "utf8")
      } catch (err) {
        console.error("[openintercept] state persist failed:", err)
      }
    }, 250)
  }
}
