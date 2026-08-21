<#
.SYNOPSIS
  Serve firmware images to the phone over the adb tunnel, for the duration of a flash.

.DESCRIPTION
  The firmware is Even's copyrighted image plus our patch, so it is not in this repo and no
  longer sits on a public host. It used to: a Cloudflare R2 bucket answered HTTP 200 with a
  4.4 MB image to anyone, and App.tsx published the full URL list. That was closed on
  2026-08-09.

  Nothing about flashing actually needed a public URL. The flasher never trusted the URL --
  G2Flasher runs the same gate chain on whatever it downloads (SHA match, EVENOTA container
  parse, MRAM brick-guard, known-golden lookup), and refuses anything that misses. The SHA pin
  is the control; the URL is just transport. So the transport can be the adb link.

  This starts a read-only HTTP server on this machine and points the phone's localhost at it
  with `adb reverse`, so http://127.0.0.1:8799/fw/<name>.bin resolves ON THE PHONE to a file
  HERE. Nothing is exposed to the network: adb reverse rides the adb transport, and the
  listener is bound to loopback on this end too.

  WHICH ADB, WHICH SERVER. Both used to be hard-coded, and both were wrong on this box:
    * adb lives wherever it lives -- Android Studio's SDK is not installed here. Resolution
      mirrors tools/adb_path.py (-Adb, FFS_ADB, ANDROID_HOME/ANDROID_SDK_ROOT, LOCALAPPDATA,
      PATH, scrcpy fallback), and falls back to calling that module itself.
    * the project's default device lane is Wi-Fi on adb server :5038, NOT adb's own :5037
      (see tools/phone_link.py and memory `phone-link-manager`). A reverse placed on the
      wrong server is invisible in effect -- the command succeeds against a server that has
      no phone, and the flash then simply cannot fetch. -AdbPort picks the server;
      -PhoneLink asks phone_link.py which lane is live and takes its server + serial.

  WARNING: `adb reverse` is per-transport -- it vanishes on every replug or adb server restart.
  Re-run this if a flash cannot fetch.

.EXAMPLE
  # Default Wi-Fi lane (adb server :5038) -- the combination proven by hand on 2026-08-20:
  .\scripts\fw-serve.ps1 -Dir C:\Users\Yoni\Desktop\fw-staging -AdbPort 5038
  # then flash, e.g.:
  #   adb -P 5038 shell am broadcast -a com.futurefounders.ffs.FLASH -p com.futurefounders.glassesos `
  #     --es url http://127.0.0.1:8799/fw/g2_2.2.7.14_loader.bin --es sha <sha256> --ez dry true

.EXAMPLE
  # Let phone_link.py heal the lanes and say which one to use.
  # Run this shell with the sandbox DISABLED, or phone_link cannot see the USB lane.
  .\scripts\fw-serve.ps1 -Dir C:\Users\Yoni\Desktop\fw-staging -PhoneLink
#>
param(
  # Directory holding the .bin images. Served as /fw/<filename>.
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$Port = 8799,

  # adb server to place the reverse on. Default: $env:ANDROID_ADB_SERVER_PORT (what
  # `eval "$(python tools/phone_link.py env)"` sets), else adb's own default 5037.
  [int]$AdbPort = $(if ($env:ANDROID_ADB_SERVER_PORT) { [int]$env:ANDROID_ADB_SERVER_PORT } else { 5037 }),

  # Explicit adb.exe. Default: discovered the way tools/adb_path.py does.
  [string]$Adb,

  # Device serial, for a server carrying more than one transport. Default: $env:ANDROID_SERIAL.
  [string]$Serial = $env:ANDROID_SERIAL,

  # Ask tools/phone_link.py which lane is live (it heals all three first) and take its adb
  # path + server port + serial. Explicitly passed -AdbPort/-Serial/-Adb still win.
  [switch]$PhoneLink
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Dir)) { throw "no such directory: $Dir" }
$Dir = (Resolve-Path $Dir).Path

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # ffs_os/scripts -> workspace root
$toolsDir = Join-Path $repoRoot "tools"

# -- adb discovery: mirrors tools/adb_path.py, same order, same last-resort fallback ----------
function Resolve-Adb {
  param([string]$Explicit)

  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Explicit)    { $candidates.Add($Explicit) }
  if ($env:FFS_ADB) { $candidates.Add($env:FFS_ADB) }
  foreach ($v in "ANDROID_HOME", "ANDROID_SDK_ROOT") {
    $sdk = [Environment]::GetEnvironmentVariable($v)
    if ($sdk) { $candidates.Add((Join-Path $sdk "platform-tools\adb.exe")) }
  }
  if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe")) }
  $onPath = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { $candidates.Add($onPath.Source) }
  # scrcpy ships an official platform-tools build; kept last so a configured SDK still wins.
  $candidates.Add((Join-Path $HOME "Desktop\backup\Downloads\scrcpy-win64-v3.3.4\scrcpy-win64-v3.3.4\adb.exe"))

  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c -PathType Leaf)) { return (Resolve-Path $c).Path }
  }

  # Last resort: let the Python module answer, so the two stay in step if it grows a candidate.
  $viaPython = & python -c "import sys; sys.path.insert(0, sys.argv[1]); from adb_path import find_adb; print(find_adb())" $toolsDir 2>$null
  if ($LASTEXITCODE -eq 0 -and $viaPython) {
    $viaPython = ($viaPython | Select-Object -First 1).Trim()
    if (Test-Path $viaPython -PathType Leaf) { return $viaPython }
  }

  throw ("adb not found. Set FFS_ADB or pass -Adb. Searched:`n  " + ($candidates -join "`n  "))
}

# -- optional: take the live lane straight from phone_link.py ---------------------------------
if ($PhoneLink) {
  $linkScript = Join-Path $toolsDir "phone_link.py"
  if (-not (Test-Path $linkScript)) { throw "-PhoneLink: no such script: $linkScript" }
  Write-Host "asking phone_link.py for a live lane (it heals all three first)..."
  $envLines = & python $linkScript env
  if ($LASTEXITCODE -ne 0) { throw "phone_link.py env failed (exit $LASTEXITCODE)" }
  foreach ($line in $envLines) {
    if ($line -notmatch '^\s*export\s+([A-Za-z_]+)="?([^"]*)"?\s*$') { continue }
    $key = $Matches[1]; $val = $Matches[2]
    switch ($key) {
      "ANDROID_ADB_SERVER_PORT" { if (-not $PSBoundParameters.ContainsKey("AdbPort")) { $AdbPort = [int]$val } }
      "ANDROID_SERIAL"          { if (-not $PSBoundParameters.ContainsKey("Serial"))  { $Serial  = $val } }
      "PATH" {
        # emitted as `export PATH="<adb dir>:$PATH"`
        $adbDir = $val -replace ':\$PATH$', ''
        $cand = Join-Path $adbDir "adb.exe"
        if (-not $Adb -and (Test-Path $cand -PathType Leaf)) { $Adb = (Resolve-Path $cand).Path }
      }
    }
  }
}

$adb = Resolve-Adb -Explicit $Adb
$adbArgs = @("-P", "$AdbPort")
if ($Serial) { $adbArgs += @("-s", $Serial) }
Write-Host ("adb: {0}  (server :{1}{2})" -f $adb, $AdbPort, $(if ($Serial) { ", serial $Serial" } else { "" }))

# The phone's 127.0.0.1:<port> -> this machine's <port>, over the adb transport.
# Check the exit code: a reverse that never landed is the exact failure this guards against.
& $adb @adbArgs reverse "tcp:$Port" "tcp:$Port" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "adb reverse failed on adb server :$AdbPort -- is the phone on that lane? Try -PhoneLink, or: python tools/phone_link.py status"
}
Write-Host "adb reverse tcp:$Port -> this machine  (adb server :$AdbPort)"

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "serving $Dir at http://127.0.0.1:$Port/fw/  (Ctrl+C to stop)"
Get-ChildItem $Dir -Filter *.bin | ForEach-Object { Write-Host ("  /fw/{0}  {1:N0} bytes" -f $_.Name, $_.Length) }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)

    # Serve ONLY /fw/<name>.bin, and resolve the result back inside $Dir before opening it --
    # otherwise a path like /fw/..%2f..%2fsecrets walks out of the served directory.
    $name = if ($rel -match '^/fw/([^/\\]+\.bin)$') { $Matches[1] } else { $null }
    $full = if ($name) { [IO.Path]::GetFullPath((Join-Path $Dir $name)) } else { $null }
    $ok = $full -and $full.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path $full)

    if (-not $ok) {
      $ctx.Response.StatusCode = 404
      $ctx.Response.Close()
      Write-Host "404 $rel"
      continue
    }

    $bytes = [IO.File]::ReadAllBytes($full)
    $ctx.Response.ContentType = "application/octet-stream"
    $ctx.Response.ContentLength64 = $bytes.Length
    # HEAD must not carry a body; the flasher may probe before downloading.
    if ($ctx.Request.HttpMethod -ne "HEAD") { $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) }
    $ctx.Response.Close()
    Write-Host ("200 {0}  {1:N0} bytes" -f $rel, $bytes.Length)
  }
} finally {
  $listener.Stop()
  & $adb @adbArgs reverse --remove "tcp:$Port" 2>$null | Out-Null
  Write-Host "stopped; adb reverse removed"
}
