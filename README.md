# OpenIntercept

**Models trust their tools blindly. This is the control panel for that trust.**

Local interception and inspection for AI agent tool calls and HTTP traffic.
Built for [OpenCode](https://opencode.ai) first, with an adapter contract that
other agents can implement.

OpenIntercept sits between the model and the tools it invokes. A matching call can
pause before it runs or before its result reaches the model, so you can run it,
edit the arguments or result, fabricate a result, or drop it. Everything it
observes stays on this machine.

> **Scope.** OpenIntercept is for systems you are authorized to test. It is passive:
> it never sends payloads, replays requests, scans targets, or decrypts TLS.

## The premise

Models cannot verify their tools. A fetch that "failed," a search that "returned
nothing," a shell command that "passed" — the model believes whatever bytes come
back, then reasons, plans, and acts on them. That channel is an unauthenticated
trust boundary: no signature, no provenance, no second opinion.

Whoever controls that boundary controls the agent. One spoofed result can redirect
research, launder a guess into a confirmed fact, or convince the model to hand over
secrets — no prompt injection required, because the injection *is* the tool result.

That is the jailbreak surface, and it belongs to whoever holds the tool channel.
OpenIntercept puts it under a human's hand: pause any call, read exactly what the
model would have believed, and decide what it actually gets.

## What it does

| Capability | Status |
| --- | --- |
| Hold tool calls at the arguments and result stages | Yes |
| Run / edit arguments / fabricate result / drop | Yes |
| Opt-in model provider HTTP capture | Yes |
| Opt-in plaintext HTTP proxy (CONNECT is tunnel-only) | Yes |
| TLS interception or a local CA | No |
| Active scanning, replay, or fuzzing | No |
| Accounts, cloud sync, or telemetry | No |

## Quick start

Requirements: [Bun](https://bun.sh) 1.1+ and a terminal. No build step, no
external services.

```bash
bun install
bun run start
```

Open <http://127.0.0.1:7474>. The sidecar serves the panel and the API on the
same loopback port.

## Install the adapter

The adapter is a single dependency-free file
(`packages/plugin/src/openintercept.plugin.ts`). Installation is a copy.

From the panel, open the **Plugin** tab and press **Install / refresh**. This
writes the adapter into your global OpenCode plugin folder.

From a terminal:

```bash
bun scripts/install-plugin.ts ./demo    # into ./demo/.opencode/plugins
bun scripts/install-plugin.ts --global  # into the global OpenCode config
```

Restart OpenCode after installing so it loads the plugin. The **Plugin** tab
shows the destination path and any registered agent heartbeats.

## The panel

Five tabs, all driven by live sidecar data over SSE:

- **Calls** — every tool call the adapter reported, with status, arguments,
  session, duration, and a detail pane showing the full decision trail, the
  arguments, and the returned result (including the original when edited).
- **HTTP** — captured model-provider exchanges and plaintext proxy traffic.
  Request/response headers and bodies, with a copy-as-cURL action.
- **Intercept** — the live hold queue. Edit the JSON and release, forward,
  fabricate, or drop. Each card counts down to the configured timeout.
- **Rules** — the interception policy. Rules match on tool name, stage,
  argument regex, and result-content regex; first match wins. The profile also
  sets the no-rule policy and hold timeout.
- **Plugin** — adapter installation, capture toggles, health check, and the
  local data summary.

Keyboard: `/` focuses the filter, `I` toggles interception, `R` reloads, `Esc`
closes the inspector.

## Rules

A rule has an optional name, a tool list (`null` = any tool), optional stages
(`before`, `after`), optional argument and content regexes, an action
(`hold`, `pass`, `drop`), and an enabled flag.

```json
{
  "name": "hold web traffic",
  "tools": ["webfetch", "websearch"],
  "stages": null,
  "action": "hold",
  "enabled": true
}
```

Rules are evaluated top to bottom. With interception on and no rule matching,
the profile's `noRule` setting decides: `pass` fails open, `hold` pauses
everything.

## Capture

Both capture modes are opt-in and off by default.

- **Model provider HTTP** records provider requests and responses seen by the
  adapter. Prompts and code may be included; authorization headers are
  redacted before the record leaves the plugin.
- **Plaintext HTTP proxy** listens on `127.0.0.1:7475` when enabled. It
  inspects absolute `http://` requests and tunnels HTTPS without decrypting it.

Captured history lives in memory and is capped at 1000 records per channel.
The append-only audit log (`data/audit.jsonl`) is the durable record and is
never rewritten by the panel's clear buttons.

## Data on disk

| Path | Contents |
| --- | --- |
| `data/state.json` | Intercept switch, profile/rules, capture settings |
| `data/audit.jsonl` | Append-only event log (calls, decisions, traffic, plugin events) |

`data/` is gitignored. Nothing is uploaded; there is no telemetry.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENINTERCEPT_PORT` | `7474` | Sidecar and panel port |
| `OPENINTERCEPT_HOST` | `127.0.0.1` | Bind address; loopback only by default |
| `OPENINTERCEPT_PROXY_PORT` | `7475` | Plaintext proxy port |
| `OPENINTERCEPT_URL` | `http://127.0.0.1:7474` | Base URL used by `scripts/sim.ts` |

## Development

```bash
bun run start     # sidecar + panel
bun run test      # package tests
bun run check     # typecheck
bun run sim       # act like an adapter and exercise a hold end to end
```

`bun run sim` posts a `webfetch` call to `/api/before`, waits for a decision,
then posts the result. Use it to exercise the panel without OpenCode:

```bash
bun run sim -- --tool bash
bun run sim -- --n 5
bun run sim -- --before-only
```

## Layout

```
panel/                 no-build single-page panel (index.html, app.js, styles.css)
packages/protocol/     zod wire contract shared by adapter and sidecar
packages/plugin/       the OpenCode adapter (single file, no dependencies)
packages/server/       Hono sidecar: hold queue, rules, history, SSE, audit
scripts/               plugin installer and traffic simulator
demo/                  throwaway OpenCode project wired to the adapter
docs/                  notes on the OpenCode tool pipeline
```

## Limits

- The adapter must be loaded by the agent; nothing is intercepted otherwise.
- The plaintext proxy does not decrypt HTTPS.
- History is in memory, so a sidecar restart clears the panel's lists. The
  audit log on disk is unaffected.
- OpenIntercept is a local operator tool, not a scanner. It reports what the agent
  actually did; it does not decide whether a target is vulnerable.

## License

MIT — see [LICENSE](LICENSE).
