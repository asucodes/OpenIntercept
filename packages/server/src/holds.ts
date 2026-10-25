import type { Decision, Stage, ToolCall, ToolResult } from "@openintercept/protocol"

export interface HoldPayload {
  call: ToolCall
  result?: ToolResult
}

export interface HoldInfo {
  /** `${callId}:${stage}` — the key the panel addresses decisions to. */
  key: string
  callId: string
  stage: Stage
  tool: string
  payload: HoldPayload
  createdAt: number
  /** Rule that requested the hold, if any (null = default noRule hold). */
  ruleName: string | null
}

export interface HoldQueueHooks {
  onHeld: (info: HoldInfo) => void
  /** Fires exactly once per hold: by explicit decision or by timeout. */
  onReleased: (info: HoldInfo, decision: Decision) => void
}

/**
 * Pending-interception queue. Each hold is a promise the adapter's HTTP
 * request is waiting on; it resolves on a human decision or on timeout.
 *
 * Dedupes by key: an adapter retrying a dropped connection (e.g. Bun
 * idle-disconnect) reattaches to the same hold — every waiter for the key
 * receives the same decision.
 */
export class HoldQueue {
  private holds = new Map<
    string,
    { info: HoldInfo; resolvers: Array<(d: Decision) => void>; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(
    private readonly hooks: HoldQueueHooks,
    private readonly config: () => { holdTimeoutMs: number; onTimeout: "forward" | "drop" },
  ) {}

  hold(info: Omit<HoldInfo, "key" | "createdAt">): Promise<Decision> {
    const key = `${info.callId}:${info.stage}`
    const existing = this.holds.get(key)
    if (existing) {
      return new Promise<Decision>((resolve) => existing.resolvers.push(resolve))
    }

    const full: HoldInfo = { ...info, key, createdAt: Date.now() }
    return new Promise<Decision>((resolve) => {
      const { holdTimeoutMs, onTimeout } = this.config()
      const timer = setTimeout(() => {
        const action =
          info.stage === "before" ? (onTimeout === "forward" ? "run" : "drop") : onTimeout === "forward" ? "forward" : "drop"
        this.settle(key, { action, by: "timeout", reason: `hold timed out after ${holdTimeoutMs}ms` })
      }, holdTimeoutMs)
      this.holds.set(key, { info: full, resolvers: [resolve], timer })
      this.hooks.onHeld(full)
    })
  }

  /** Resolve a hold from the panel. Returns false if unknown/already released. */
  decide(key: string, decision: Decision): boolean {
    if (!this.holds.has(key)) return false
    this.settle(key, { ...decision, by: decision.by ?? "human" })
    return true
  }

  list(): HoldInfo[] {
    return [...this.holds.values()].map((h) => h.info)
  }

  size(): number {
    return this.holds.size
  }

  private settle(key: string, decision: Decision) {
    const entry = this.holds.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.holds.delete(key)
    for (const resolve of entry.resolvers) resolve(decision)
    this.hooks.onReleased(entry.info, decision)
  }
}
