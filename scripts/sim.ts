/**
 * OpenIntercept traffic simulator — acts like an adapter (what the OpenCode
 * plugin will become) so the panel can be exercised without OpenCode.
 *
 *   bun scripts/sim.ts                      # one webfetch-style call, both stages
 *   bun scripts/sim.ts --tool bash          # different tool
 *   bun scripts/sim.ts --before-only        # hold only at the args stage
 *   bun scripts/sim.ts --n 5                # five calls
 */
const BASE = process.env.OPENINTERCEPT_URL ?? "http://127.0.0.1:7474"

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : true
}
const tool = (flag("--tool") as string) ?? "webfetch"
const n = Number(flag("--n") ?? 1)
const beforeOnly = !!flag("--before-only")

// one chat thread per sim run, with realistic call context
const chat = `chat-${crypto.randomUUID().slice(0, 6)}`
const session = { id: chat, title: `Refactor session ${chat.slice(-4)}` }
const context = { agent: "build", model: "claude-sonnet-4-5", provider: "anthropic" }

const SAMPLE_ARGS: Record<string, unknown> = {
  webfetch: { url: "https://example.com/docs", method: "GET" },
  websearch: { query: "opencode plugin hooks" },
  bash: { command: "git status --short", description: "check working tree" },
  read: { filePath: "packages/server/src/index.ts" },
  grep: { pattern: "tool.execute", path: "src" },
}

const SAMPLE_OUTPUT: Record<string, string> = {
  webfetch: "# Example Docs\n\nWelcome to the documentation.\n\n## Sections\n\n- Getting started\n- Hooks\n- Tools\n\n<!-- footer: generated 2026-10-25 -->",
  websearch: "1. OpenCode Plugins (https://opencode.ai/docs/plugins)\n2. Tool hooks reference\n3. MCP gateways overview",
  bash: " M packages/server/src/routes.ts\n A panel/app.js\n",
  read: "const server = Bun.serve({ port: 7474, hostname: \"127.0.0.1\" })\n// ... 214 more lines",
  grep: "src/routes.ts:42:  \"tool.execute.before\"\nsrc/plugin/v1.ts:18:  \"tool.execute.after\"",
}

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`)
  return res.json()
}

// adapter contract: a "respond" decision at the before stage means the tool's
// real output is discarded and replaced by the fabricated result
const fabrications = new Map<string, any>()

for (let i = 0; i < n; i++) {
  const id = crypto.randomUUID()
  const args = SAMPLE_ARGS[tool] ?? { note: "simulated call" }
  console.log(`[${tool}] before → holding for decision…`)
  const before = (await post("/api/before", {
    kind: "before",
    call: { id, adapter: "opencode-v1", tool, args, session, context, startedAt: Date.now() },
  })) as { decision: { action: string; by: string; result?: any; reason?: string } }
  console.log(`  decision: ${before.decision.action} (by ${before.decision.by}${before.decision.reason ? ` — ${before.decision.reason}` : ""})`)
  if (before.decision.action === "drop" || beforeOnly) continue
  if (before.decision.action === "respond" && before.decision.result) {
    fabrications.set(id, before.decision.result)
  }

  await new Promise((r) => setTimeout(r, 400)) // let the panel show "running"
  const fab = fabrications.get(id)
  const after = (await post("/api/after", {
    kind: "after",
    call: { id, adapter: "opencode-v1", tool, args, session, context, startedAt: Date.now() },
    result: fab ?? { title: `${tool} result`, output: SAMPLE_OUTPUT[tool] ?? "simulated output", metadata: {} },
    ...(fab ? { fabricated: true } : {}),
  })) as { decision: { action: string; by: string; reason?: string } }
  console.log(`[${tool}] after  → decision: ${after.decision.action} (by ${after.decision.by})${fab ? " [SPOOFED]" : ""}`)
}
