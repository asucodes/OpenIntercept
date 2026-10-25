import { appendFile, mkdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

export interface AuditQuery {
  limit?: number
  offset?: number
  q?: string
  type?: string
  stage?: string
  since?: number
  until?: number
  order?: "asc" | "desc"
}

export interface AuditRecord {
  ts: string
  type: string
  [key: string]: unknown
}

/**
 * Append-only JSONL audit trail: one line per event, never rewritten.
 * The security record of every interception decision, suitable for
 * post-hoc review and replay analysis.
 */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve()
  private cache: { mtimeMs: number; size: number; records: AuditRecord[] } | null = null

  constructor(private readonly file: string) {}

  static async open(dir: string): Promise<AuditLog> {
    await mkdir(dir, { recursive: true })
    return new AuditLog(path.join(dir, "audit.jsonl"))
  }

  get path(): string {
    return this.file
  }

  log(event: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n"
    // serialize appends; a rejected append is logged, never thrown — the
    // audit trail must not be able to kill a tool call
    this.queue = this.queue
      .then(() => appendFile(this.file, line, "utf8"))
      .catch((err) => console.error("[openintercept] audit append failed:", err))
  }

  async size(): Promise<number> {
    try {
      return (await stat(this.file)).size
    } catch {
      return 0
    }
  }

  async query(query: AuditQuery = {}): Promise<{
    events: AuditRecord[]
    total: number
    offset: number
    limit: number
    counts: Record<string, number>
    fileSize: number
  }> {
    const records = await this.load()
    const q = query.q?.trim().toLowerCase() ?? ""
    const filtered = records.filter((record) => {
      if (query.type && record.type !== query.type) return false
      if (query.stage && record.stage !== query.stage) return false
      const at = Date.parse(record.ts)
      if (query.since && Number.isFinite(at) && at < query.since) return false
      if (query.until && Number.isFinite(at) && at > query.until) return false
      if (q && !JSON.stringify(record).toLowerCase().includes(q)) return false
      return true
    })
    const counts: Record<string, number> = {}
    for (const record of filtered) counts[record.type] = (counts[record.type] ?? 0) + 1
    const order = query.order ?? "desc"
    const ordered = order === "asc" ? filtered : [...filtered].reverse()
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
    const offset = Math.max(query.offset ?? 0, 0)
    return {
      events: ordered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      counts,
      fileSize: await this.size(),
    }
  }

  private async load(): Promise<AuditRecord[]> {
    let info
    try {
      info = await stat(this.file)
    } catch {
      this.cache = null
      return []
    }
    if (this.cache && this.cache.mtimeMs === info.mtimeMs && this.cache.size === info.size) return this.cache.records
    let text = ""
    try {
      text = await readFile(this.file, "utf8")
    } catch {
      return []
    }
    const lines = text.split("\n")
    const records: AuditRecord[] = []
    // Bound memory on very large logs while retaining the most recent events.
    const start = Math.max(0, lines.length - 200_000)
    for (let index = start; index < lines.length; index++) {
      const line = lines[index]!.trim()
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as AuditRecord
        if (parsed && typeof parsed.ts === "string" && typeof parsed.type === "string") records.push(parsed)
      } catch {
        // a partially-flushed final line is ignored, never fatal
      }
    }
    this.cache = { mtimeMs: info.mtimeMs, size: info.size, records }
    return records
  }
}

/** No-op log for tests. */
export class NullAuditLog extends AuditLog {
  constructor() {
    super("")
  }
  log(_event: Record<string, unknown>): void {}
  override async size(): Promise<number> {
    return 0
  }
  override async query() {
    return { events: [], total: 0, offset: 0, limit: 100, counts: {}, fileSize: 0 }
  }
}
