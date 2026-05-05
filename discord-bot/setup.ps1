# Loadout Discord bot — one-shot deploy.
#
# Walks the operator (you) through:
#   1. Wrangler login (one-time)
#   2. Creating the KV namespace + binding it in wrangler.toml
#   3. Storing the Discord app's public key in KV
#   4. Deploying the Worker
#   5. Publishing slash commands globally via Discord's REST API
#
# After this finishes you have:
#   • A live Worker at <project>.workers.dev (or your custom domain)
#   • Slash commands published in every server the bot joins
#   • An invite URL printed at the end — paste it into a browser to
#     add the bot to YOUR test server first, then to Loadout's Discord.
#
# Re-running this is safe. Each step short-circuits if it sees existing
# state.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AppId,         # Discord application ID
    [Parameter(Mandatory=$true)] [string]$PublicKey,     # Discord public key (hex, no 0x prefix)
    [Parameter(Mandatory=$true)] [string]$BotToken,      # bot token, used ONLY for command registration
    [string]$WorkerName = "loadout-discord"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

function Step($t)  { Write-Host ""; Write-Host ">> $t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "   + $t" -ForegroundColor Green }
function Warn($t)  { Write-Host "   ! $t" -ForegroundColor Yellow }
function Fail($t)  { Write-Host "   x $t" -ForegroundColor Red }

# --- 1. Prereq: node + wrangler -------------------------------------------
Step "Checking prereqs"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "node not found. Install: winget install OpenJS.NodeJS.LTS"
    exit 1
}
Ok "node on PATH"

# Use the locally-installed wrangler from the package's devDependencies
# rather than relying on a global install.
if (-not (Test-Path "node_modules/wrangler")) {
    Step "Installing wrangler locally"
    npm install --no-audit --no-fund | Out-Null
    Ok "wrangler installed"
} else { Ok "wrangler already installed" }

function Wrangler { npx --no-install wrangler @args }

# --- 2. Wrangler auth -----------------------------------------------------
Step "Verifying Cloudflare auth"
$whoami = Wrangler whoami 2>&1
if ($LASTEXITCODE -ne 0 -or $whoami -notmatch "logged in") {
    Step "Running wrangler login"
    Wrangler login
    if ($LASTEXITCODE -ne 0) { Fail "wrangler login failed"; exit 1 }
}
Ok "Cloudflare authenticated"

# --- 3. KV namespace ------------------------------------------------------
Step "Ensuring KV namespace LOADOUT_BOLTS exists"
$kvList = Wrangler kv namespace list 2>&1 | Out-String
$kvId = $null
if ($kvList -match '"title"\s*:\s*"loadout-discord-LOADOUT_BOLTS"\s*,\s*"id"\s*:\s*"([a-f0-9]+)"') {
    $kvId = $Matches[1]
    Ok "KV namespace already exists: $kvId"
} else {
    Step "Creating new KV namespace"
    $createOut = Wrangler kv namespace create "LOADOUT_BOLTS" 2>&1 | Out-String
    Write-Host $createOut -ForegroundColor DarkGray
    if ($createOut -match 'id\s*=\s*"([a-f0-9]+)"') {
        $kvId = $Matches[1]
        Ok "Created KV: $kvId"
    } else {
        Fail "Couldn't parse KV id from wrangler output. Add it to wrangler.toml manually."
        exit 1
    }
}

# Patch wrangler.toml with the real KV id (replace the REPLACE_WITH_KV_ID placeholder).
$wt = Get-Content "wrangler.toml" -Raw
if ($wt -match "REPLACE_WITH_KV_ID") {
    $wt = $wt -replace "REPLACE_WITH_KV_ID_FROM_WRANGLER_KV_NAMESPACE_CREATE", $kvId
    Set-Content "wrangler.toml" $wt -NoNewline
    Ok "Patched wrangler.toml KV id"
} else {
    Ok "wrangler.toml KV id already set"
}

# --- 4. Seed publickey + DISCORD_APP_ID ------------------------------------
Step "Storing Discord public key in KV"
Wrangler kv key put --binding LOADOUT_BOLTS publickey $PublicKey | Out-Null
Ok "publickey stored ($([Math]::Min(8, $PublicKey.Length)) chars: $($PublicKey.Substring(0, [Math]::Min(8, $PublicKey.Length)))...)"

# DISCORD_APP_ID is a Worker var (referenced by /claim's invite URL).
Step "Setting Worker var DISCORD_APP_ID"
$wt2 = Get-Content "wrangler.toml" -Raw
if ($wt2 -notmatch "DISCORD_APP_ID") {
    # Append under [vars] block.
    $wt2 = $wt2 -replace "(\[vars\][^\[]*)", "`$1DISCORD_APP_ID = `"$AppId`"`r`n"
    Set-Content "wrangler.toml" $wt2 -NoNewline
}
Ok "DISCORD_APP_ID set"

# --- 5. Deploy ------------------------------------------------------------
Step "Deploying Worker"
Wrangler deploy
if ($LASTEXITCODE -ne 0) { Fail "wrangler deploy failed"; exit 1 }
Ok "Worker deployed"

# --- 6. Publish slash commands ---------------------------------------------
Step "Publishing slash commands globally (~1h propagation)"
$env:APP_ID    = $AppId
$env:BOT_TOKEN = $BotToken
node register-commands.js
if ($LASTEXITCODE -ne 0) { Fail "Slash command registration failed"; exit 1 }
Ok "Slash commands published"
Remove-Item Env:\BOT_TOKEN -ErrorAction SilentlyContinue

# --- 7. Print invite URL ---------------------------------------------------
Step "All done"
$invite = "https://discord.com/oauth2/authorize?client_id=$AppId" +
          "&permissions=2147485696&scope=bot+applications.commands"
Write-Host @"

  Invite the bot to a server with this URL:

    $invite

  In the Discord developer portal -> General Information,
  set INTERACTIONS ENDPOINT URL to:

    https://$WorkerName.<your-cf-account>.workers.dev/interactions

  (or your custom domain if you set one up in wrangler.toml)

  Test path:
    1. Invite the bot to a server.
    2. In Loadout, click "Get my code" in Settings -> Discord bot tab.
    3. In Discord, type /loadout-claim <code>
    4. Loadout polls and binds. /balance, /gift etc. now work.
"@ -ForegroundColor White
