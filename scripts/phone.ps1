# Talk to the phone's Android Remote Control MCP server directly, over HTTP.
#
#     .\scripts\phone.ps1 -List
#     .\scripts\phone.ps1 -Tool android_get_screen_state
#     .\scripts\phone.ps1 -Tool android_tap -Arguments '{"x":360,"y":800}'
#     .\scripts\phone.ps1 -Tool android_take_camera_photo -Arguments '{"camera_id":"0"}' -OutFile hud.jpg
#
# WHY THIS EXISTS
# ---------------
# Claude Code binds its MCP servers ONCE, at session start. A server that is unreachable at
# that instant is unavailable for the WHOLE session, and the only remedy is a restart -- which
# needs a human. That makes unattended work hostage to whoever is around to relaunch the app,
# and it is exactly what happened on 2026-08-07: the phone dropped off adb overnight, the
# android_* tools never loaded, and everything stopped until someone restarted.
#
# But the MCP client is not the only way to reach an MCP server. This one is a plain HTTP
# JSON-RPC endpoint (streamable-HTTP transport, replies in application/json, hands out an
# `mcp-session-id` header on initialize). Any HTTP client can drive it. So this script gives
# the same 55 tools with none of the session-start coupling:
#
#   * works mid-session even when the MCP client failed to connect at startup
#   * survives the phone rebooting and coming back -- just call again, no restart
#   * needs no adb (the server binds 0.0.0.0 since 2026-08-07)
#
# Use the native mcp__android-device__* tools when they happen to be loaded -- they are
# cheaper and return images inline. Fall back to this whenever they are not, which is the
# case this script exists for.
#
# The bearer token is read from ~/.claude.json rather than hardcoded, so it stays out of the
# repo and keeps working if the token is regenerated in the app.

[CmdletBinding()]
param(
  # Tool name, e.g. android_get_screen_state. Omit with -List to enumerate.
  [string]$Tool,
  # Tool arguments as a JSON object string, e.g. '{"camera_id":"0"}'.
  [string]$Arguments = '{}',
  # Where to write returned image data. Any image content in the reply is decoded to here.
  [string]$OutFile,
  # List the available tools and exit.
  [switch]$List,
  # Override the server URL (default: whatever ~/.claude.json has configured).
  [string]$Url
)

$ErrorActionPreference = 'Stop'

# --- config -----------------------------------------------------------------------------
# Both the URL and the token come from the MCP config so there is ONE source of truth. If the
# server moves or the token is regenerated, updating the config fixes this script too.
$cfgPath = Join-Path $env:USERPROFILE '.claude.json'
if (-not (Test-Path $cfgPath)) { throw "no ~/.claude.json at $cfgPath" }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$srv = $cfg.mcpServers.'android-device'
if (-not $srv) { throw "no 'android-device' MCP server in ~/.claude.json" }
if (-not $Url) { $Url = $srv.url }

# PREFER THE USB TUNNEL when one is up.
#
# Measured 2026-08-08: the phone dozed, WiFi went into power-save, and the MCP server *and* adb
# both became unreachable WHILE PING STILL ANSWERED -- which reads as "adb is slow" rather than
# "the device is gone" and cost a long detour. Over USB none of that can happen, and it is also
# ~3x faster (67 ms vs 210 ms to the same endpoint).
#
# Port 18080 is the one `adb-keepalive.ps1` re-asserts on every reconnect, so it is the DURABLE
# local port -- an ad-hoc `adb forward tcp:8080 tcp:8080` works too but silently disappears on the
# next replug, because `adb forward` is per-transport.
#
# ⚠️ USB adb needs the phone's USB mode set to FILE TRANSFER. On "No data transfer" (the MIUI
# default) the ADB interface is not exposed at all, and `adb devices` comes back EMPTY even
# though the phone displays "USB debugging connected" -- which is a genuinely misleading pair of
# signals and cost a long detour on 2026-08-08.
if (-not $PSBoundParameters.ContainsKey('Url')) {
  try {
    $u = [Uri]$Url
    foreach ($p in @(18080, $u.Port)) {
      $local = "$($u.Scheme)://127.0.0.1:$p$($u.AbsolutePath)"
      # Any HTTP status means the server answered (401 = alive, wants the token) => tunnel live.
      $probe = try {
        (Invoke-WebRequest -Uri $local -Method POST -TimeoutSec 2 -SkipHttpErrorCheck -ErrorAction Stop).StatusCode
      } catch { 0 }
      if ($probe -ne 0) { $Url = $local; break }
    }
  } catch { }
}
$token = ($srv.headers.PSObject.Properties | Select-Object -First 1).Value
if (-not $token) { throw "no auth header on the android-device server config" }

$headers = @{
  Authorization  = $token
  Accept         = 'application/json, text/event-stream'
  'Content-Type' = 'application/json'
}

function Invoke-Rpc {
  param([string]$Method, $Params, [switch]$IsNotification)
  $payload = @{ jsonrpc = '2.0'; method = $Method }
  if ($null -ne $Params) { $payload.params = $Params }
  # Notifications carry no id and expect no reply -- sending one anyway makes strict servers
  # respond with an error object that looks like a failure.
  if (-not $IsNotification) { $payload.id = [guid]::NewGuid().ToString() }
  $body = $payload | ConvertTo-Json -Depth 20 -Compress

  $resp = Invoke-WebRequest -Uri $Url -Method POST -Headers $headers -Body $body `
    -UseBasicParsing -TimeoutSec 60
  # The session id only appears on the initialize response; every later call must echo it back.
  if ($resp.Headers['mcp-session-id']) {
    $script:headers['Mcp-Session-Id'] = [string]$resp.Headers['mcp-session-id']
  }
  if (-not $resp.Content) { return $null }
  # streamable-HTTP may answer as SSE ("event: message\ndata: {...}") even when it usually
  # returns plain JSON. Unwrap that case rather than failing to parse.
  $text = $resp.Content
  if ($text -match '(?m)^data:\s*(.+)$') { $text = $Matches[1] }
  return $text | ConvertFrom-Json
}

# --- MCP handshake ----------------------------------------------------------------------
$null = Invoke-Rpc -Method 'initialize' -Params @{
  protocolVersion = '2024-11-05'
  capabilities    = @{}
  clientInfo      = @{ name = 'ffs-phone-cli'; version = '1.0' }
}
# Required by the spec before tools/* calls; harmless if the server tolerates its absence.
try { $null = Invoke-Rpc -Method 'notifications/initialized' -IsNotification } catch { }

# --- list -------------------------------------------------------------------------------
if ($List) {
  $r = Invoke-Rpc -Method 'tools/list'
  $r.result.tools | ForEach-Object { "{0,-46} {1}" -f $_.name, $_.description.Split("`n")[0] }
  exit 0
}

if (-not $Tool) { throw "specify -Tool <name>, or -List to enumerate" }

# --- call -------------------------------------------------------------------------------
$argObj = $Arguments | ConvertFrom-Json
$r = Invoke-Rpc -Method 'tools/call' -Params @{ name = $Tool; arguments = $argObj }

if ($r.error) {
  Write-Error "MCP error $($r.error.code): $($r.error.message)"
  exit 1
}

# Tool replies are a content array of typed parts. Text parts print; image parts are base64
# and would be megabytes of noise on stdout, so they only ever go to -OutFile.
$wroteImage = $false
foreach ($part in $r.result.content) {
  if ($part.type -eq 'text') {
    $part.text
  } elseif ($part.data) {
    if (-not $OutFile) {
      Write-Warning "reply contains $($part.mimeType) data; pass -OutFile to save it"
      continue
    }
    [IO.File]::WriteAllBytes($OutFile, [Convert]::FromBase64String($part.data))
    Write-Host "wrote $($part.mimeType) -> $OutFile ($((Get-Item $OutFile).Length) bytes)"
    $wroteImage = $true
  }
}
if ($r.result.isError) { Write-Warning "tool reported isError=true" }
if ($OutFile -and -not $wroteImage) { Write-Warning "no image data in the reply" }
