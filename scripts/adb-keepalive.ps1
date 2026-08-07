# Keep the phone's adb link AND the device-MCP tunnel alive, continuously.
#
#     powershell -ExecutionPolicy Bypass -File scripts\adb-keepalive.ps1
#
# WHY THIS EXISTS
# ---------------
# Claude Code connects its MCP servers ONCE, at session start. The on-device MCP server
# (Android Remote Control, v1.7.0) is bound to 127.0.0.1:8080 ON THE PHONE -- verified from
# /proc/net/tcp, local_address 0100007F -- so `adb forward tcp:18080 tcp:8080` is the only
# route to it from this machine. If that forward is missing at session start, the MCP client
# gets connection-refused, the android_* tools never load, and the ONLY fix is another
# restart. That cost a whole session on 2026-08-07.
#
# The failure is not adb dying dramatically. It is quieter than that:
#   * `adb forward` is PER-TRANSPORT. Every reconnect silently drops it, and adb's own mDNS
#     auto-reconnect brings the device back WITHOUT it -- so `adb devices` looks healthy while
#     the tunnel is gone. That is the state that looks fine and isn't.
#   * WiFi hiccups, the phone sleeping, or MIUI reaping a background process all reconnect.
#
# So this loop does not try to be clever. It asserts one invariant -- device present AND
# forward present -- every few seconds, and re-establishes whatever is missing.
#
# WHAT IT CANNOT FIX, and there is no workaround without root:
# A phone REBOOT clears `adb_wifi_enabled`. Wireless debugging switches itself off, adb has no
# way in, and nothing on this machine can turn it back on -- the switch is behind the very
# channel that just closed. After a reboot a human must re-enable Wireless debugging once
# (Settings -> Developer options), and if the pairing was lost, re-pair. Everything after that
# is automatic again. `adb tcpip 5555` would give a fixed port that needs no pairing, but it
# also drops the pairing requirement for ANYONE on the WiFi, so it is deliberately not used
# here.

$ErrorActionPreference = 'Continue'

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$adb = "$sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) { Write-Error "adb not found at $adb"; exit 1 }

# Last known address. Only used as a fallback: a PAIRED device with wireless debugging on is
# normally rediscovered by adb's own mDNS, which survives the port changing.
$FallbackHost = '192.168.1.174'

# The tunnel that matters. 18080 (this PC) -> 8080 (the phone's localhost MCP server).
$McpLocalPort = 18080
$McpDevicePort = 8080
# Metro, so a debug JS bundle can load. Same per-transport fragility.
$MetroPort = 8081

$IntervalSeconds = 10

function Get-DeviceCount {
  # Count only lines in the "device" state; "offline"/"unauthorized" are not usable.
  $out = & $adb devices 2>$null
  return @($out | Select-String -Pattern "\sdevice$").Count
}

function Test-Forward {
  $out = & $adb forward --list 2>$null
  return [bool]($out | Select-String -Pattern "tcp:$McpLocalPort")
}

Write-Host "adb-keepalive: asserting device + tcp:$McpLocalPort every ${IntervalSeconds}s. Ctrl+C to stop."
$lastState = ''

while ($true) {
  $devices = Get-DeviceCount

  if ($devices -eq 0) {
    if ($lastState -ne 'disconnected') {
      Write-Host "[$(Get-Date -Format HH:mm:ss)] no device - attempting reconnect"
      $lastState = 'disconnected'
    }
    # mDNS usually beats this to it; the explicit connect covers a stale mDNS cache.
    & $adb reconnect offline 2>&1 | Out-Null
    foreach ($p in 5555, 37000) { & $adb connect "${FallbackHost}:$p" 2>&1 | Out-Null }
    Start-Sleep -Seconds $IntervalSeconds
    continue
  }

  if ($devices -gt 1) {
    # Two transports to one phone (mDNS + explicit IP) make every adb command fail with
    # "more than one device/emulator". Drop the explicit one; mDNS is the self-healing half.
    Write-Host "[$(Get-Date -Format HH:mm:ss)] $devices transports - dropping explicit IP duplicates"
    & $adb disconnect "${FallbackHost}:5555" 2>&1 | Out-Null
    & $adb disconnect "${FallbackHost}:37000" 2>&1 | Out-Null
  }

  if (-not (Test-Forward)) {
    # The interesting case: device present, tunnel silently absent after a reconnect.
    & $adb forward "tcp:$McpLocalPort" "tcp:$McpDevicePort" 2>&1 | Out-Null
    & $adb reverse "tcp:$MetroPort" "tcp:$MetroPort" 2>&1 | Out-Null
    Write-Host "[$(Get-Date -Format HH:mm:ss)] re-established tunnels (mcp $McpLocalPort, metro $MetroPort)"
    $lastState = 'up'
  } elseif ($lastState -ne 'up') {
    Write-Host "[$(Get-Date -Format HH:mm:ss)] device + tunnels up"
    $lastState = 'up'
  }

  Start-Sleep -Seconds $IntervalSeconds
}
