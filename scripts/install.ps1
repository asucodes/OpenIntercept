# OpenIntercept one-click installer (Windows / PowerShell).
#
#   irm https://raw.githubusercontent.com/asucodes/OpenIntercept/main/scripts/install.ps1 | iex
#
# Custom OpenCode plugins dir:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/asucodes/OpenIntercept/main/scripts/install.ps1))) -PluginsDir "D:\path\to\opencode\plugins"
#
# What it does:
#   1. ensures bun exists (installs it if missing)
#   2. clones / updates the repo into ~/.openintercept
#   3. installs dependencies
#   4. writes the adapter into the OpenCode plugins dir (default ~/.config/opencode/plugins)
#   5. starts the sidecar (skipped if one is already running on :7474)

param(
  [string]$PluginsDir = "",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$Repo = "https://github.com/asucodes/OpenIntercept.git"
$Raw = "https://raw.githubusercontent.com/asucodes/OpenIntercept/main/scripts/install.ps1"
$Root = Join-Path $HOME ".openintercept"
$DefaultPlugins = Join-Path $HOME ".config/opencode/plugins"
$Panel = "http://127.0.0.1:7474"

function Say($msg) { Write-Host "[openintercept] $msg" }

# --- 1. bun -----------------------------------------------------------------

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Say "bun not found - installing..."
  irm bun.sh/install.ps1 | iex
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
  }
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "bun installed but not on PATH yet - open a new terminal and re-run this installer"
  }
}
Say "bun $(bun --version)"

# --- 2. repo ----------------------------------------------------------------

if (Test-Path (Join-Path $Root ".git")) {
  Say "updating $Root"
  git -C $Root fetch --depth 1 origin main
  git -C $Root reset --hard origin/main
} else {
  Say "cloning into $Root"
  git clone --depth 1 $Repo $Root
}

# --- 3. deps ----------------------------------------------------------------

Push-Location $Root
bun install | Out-Null
Pop-Location
Say "dependencies installed"

# --- 4. adapter into the OpenCode plugins dir --------------------------------

$target = if ($PluginsDir.Trim()) { $PluginsDir.Trim() } else { $DefaultPlugins }
New-Item -ItemType Directory -Force -Path $target | Out-Null

$src = Get-Content (Join-Path $Root "packages/plugin/src/openintercept.plugin.ts") -Raw
$marker = "export default OpenIntercept"
if (-not $src.Contains($marker)) { throw "plugin source is missing the V1 default export marker" }
$v2 = $src.Replace($marker, 'export default { id: (OpenIntercept as any).id, setup: (OpenIntercept as any).setup }')
Set-Content -Path (Join-Path $target "openintercept.ts") -Value $src -Encoding UTF8
Set-Content -Path (Join-Path $target "openintercept-v2.ts") -Value $v2 -Encoding UTF8
Say "adapter written: $target\{openintercept.ts, openintercept-v2.ts}"

# --- 5. sidecar ---------------------------------------------------------------

$running = $false
try {
  Invoke-WebRequest "$Panel/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
  $running = $true
} catch {}

if ($running) {
  Say "sidecar already running at $Panel"
} elseif ($NoStart) {
  Say "start it later: bun run packages/server/src/index.ts (in $Root)"
} else {
  Say "starting sidecar in the background..."
  Start-Process -FilePath "bun" -ArgumentList "run", "packages/server/src/index.ts" -WorkingDirectory $Root -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

Write-Host ""
Say "done. open the panel: $Panel"
Say "restart OpenCode so it loads the adapter"
if (-not $PluginsDir) {
  Write-Host ""
  Say "if your OpenCode plugins folder is NOT $DefaultPlugins, re-run with its path:"
  Say "  & ([scriptblock]::Create((irm $Raw))) -PluginsDir `"C:\path\to\opencode\plugins`""
  Say "or copy the adapter manually:"
  Say "  copy $Root\packages\plugin\src\openintercept.plugin.ts <dir>\openintercept.ts"
  Say "  (v2 variant: replace 'export default OpenIntercept' with 'export default { id: (OpenIntercept as any).id, setup: (OpenIntercept as any).setup }')"
}