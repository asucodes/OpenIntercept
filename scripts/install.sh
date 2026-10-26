#!/usr/bin/env bash
# OpenIntercept one-click installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/asucodes/OpenIntercept/main/scripts/install.sh | bash
#
# Custom OpenCode plugins dir:
#   curl -fsSL https://raw.githubusercontent.com/asucodes/OpenIntercept/main/scripts/install.sh | bash -s -- --plugins-dir /path/to/opencode/plugins
#
# What it does:
#   1. ensures bun exists (installs it if missing)
#   2. clones / updates the repo into ~/.openintercept
#   3. installs dependencies
#   4. writes the adapter into the OpenCode plugins dir (default ~/.config/opencode/plugins)
#   5. starts the sidecar (skipped if one is already running on :7474)

set -euo pipefail

REPO="https://github.com/asucodes/OpenIntercept.git"
RAW="https://raw.githubusercontent.com/asucodes/OpenIntercept/main/scripts/install.sh"
ROOT="$HOME/.openintercept"
DEFAULT_PLUGINS="$HOME/.config/opencode/plugins"
PANEL="http://127.0.0.1:7474"
PLUGINS_DIR=""
NO_START=0

say() { printf '[openintercept] %s\n' "$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugins-dir) PLUGINS_DIR="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    *) say "unknown flag: $1"; exit 1 ;;
  esac
done

# --- 1. bun -----------------------------------------------------------------

if ! command -v bun >/dev/null 2>&1; then
  say "bun not found - installing..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    say "bun installed but not on PATH yet - open a new terminal and re-run"
    exit 1
  fi
fi
say "bun $(bun --version)"

# --- 2. repo ----------------------------------------------------------------

if [ -d "$ROOT/.git" ]; then
  say "updating $ROOT"
  git -C "$ROOT" fetch --depth 1 origin main
  git -C "$ROOT" reset --hard origin/main
else
  say "cloning into $ROOT"
  git clone --depth 1 "$REPO" "$ROOT"
fi

# --- 3. deps ----------------------------------------------------------------

(cd "$ROOT" && bun install >/dev/null)
say "dependencies installed"

# --- 4. adapter into the OpenCode plugins dir --------------------------------

TARGET="${PLUGINS_DIR:-$DEFAULT_PLUGINS}"
mkdir -p "$TARGET"

SRC="$ROOT/packages/plugin/src/openintercept.plugin.ts"
MARKER="export default OpenIntercept"
if ! grep -q "$MARKER" "$SRC"; then
  say "plugin source is missing the V1 default export marker"
  exit 1
fi
cp "$SRC" "$TARGET/openintercept.ts"
sed "s|$MARKER|export default { id: (OpenIntercept as any).id, setup: (OpenIntercept as any).setup }|" "$SRC" > "$TARGET/openintercept-v2.ts"
say "adapter written: $TARGET/{openintercept.ts, openintercept-v2.ts}"

# --- 5. sidecar ---------------------------------------------------------------

if curl -fsS --max-time 2 "$PANEL/api/health" >/dev/null 2>&1; then
  say "sidecar already running at $PANEL"
elif [ "$NO_START" -eq 1 ]; then
  say "start it later: bun run packages/server/src/index.ts (in $ROOT)"
else
  say "starting sidecar in the background..."
  (cd "$ROOT" && nohup bun run packages/server/src/index.ts > "$ROOT/sidecar.log" 2>&1 &)
  sleep 2
fi

echo ""
say "done. open the panel: $PANEL"
say "restart OpenCode so it loads the adapter"
if [ -z "$PLUGINS_DIR" ]; then
  echo ""
  say "if your OpenCode plugins folder is NOT $DEFAULT_PLUGINS, re-run with its path:"
  say "  curl -fsSL $RAW | bash -s -- --plugins-dir /path/to/opencode/plugins"
  say "or copy the adapter manually:"
  say "  cp $SRC /path/to/opencode/plugins/openintercept.ts"
  say "  (v2 variant: replace 'export default OpenIntercept' with 'export default { id: (OpenIntercept as any).id, setup: (OpenIntercept as any).setup }')"
fi