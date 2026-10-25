# OpenIntercept demo project

A throwaway project for end-to-end testing: OpenCode runs here with the
OpenIntercept adapter installed in `.opencode/plugins/openintercept.ts`.

## The end-to-end test

1. Start the sidecar from the repo root: `bun run start`
2. Open the panel: http://127.0.0.1:7474 — switch **Intercept on**
3. Run OpenCode in this directory:
   ```bash
   cd demo
   opencode run "Fetch https://example.com and tell me what the page says"
   ```
4. The `webfetch` call appears in the panel and **OpenCode pauses mid-call**.
5. Choose **Replace result**, rewrite the page content to something absurd, apply.
6. Watch OpenCode's answer: the model describes the replaced page, not the real
   one. That is interception working end to end.

## Reset

```bash
bun scripts/install-plugin.ts ./demo   # refresh the adapter copy after edits
```
