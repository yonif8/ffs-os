<#
.SYNOPSIS
  Serve firmware images to the phone over the USB tunnel, for the duration of a flash.

.DESCRIPTION
  The firmware is Even's copyrighted image plus our patch, so it is not in this repo and no
  longer sits on a public host. It used to: a Cloudflare R2 bucket answered HTTP 200 with a
  4.4 MB image to anyone, and App.tsx published the full URL list. That was closed on
  2026-08-09.

  Nothing about flashing actually needed a public URL. The flasher never trusted the URL —
  G2Flasher runs the same gate chain on whatever it downloads (SHA match, EVENOTA container
  parse, MRAM brick-guard, known-golden lookup), and refuses anything that misses. The SHA pin
  is the control; the URL is just transport. So the transport can be a cable.

  This starts a read-only HTTP server on this machine and points the phone's localhost at it
  with `adb reverse`, so http://127.0.0.1:8799/fw/<name>.bin resolves ON THE PHONE to a file
  HERE. Nothing is exposed to the network: adb reverse rides the USB transport, and the
  listener is bound to loopback on this end too.

  ⚠️ `adb reverse` is per-transport — it vanishes on every replug or adb server restart.
  Re-run this if a flash cannot fetch.

.EXAMPLE
  .\scripts\fw-serve.ps1 -Dir C:\Users\Yoni\Desktop\fw-staging
  # then flash, e.g.:
  #   adb shell am broadcast -a com.futurefounders.ffs.FLASH -p com.futurefounders.glassesos `
  #     --es url http://127.0.0.1:8799/fw/g2_2.2.7.14_loader.bin --es sha <sha256> --ez dry true
#>
param(
  # Directory holding the .bin images. Served as /fw/<filename>.
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$Port = 8799
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Dir)) { throw "no such directory: $Dir" }
$Dir = (Resolve-Path $Dir).Path

$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) { throw "adb not found at $adb" }

# The phone's 127.0.0.1:<port> -> this machine's <port>, over USB.
& $adb reverse "tcp:$Port" "tcp:$Port" | Out-Null
Write-Host "adb reverse tcp:$Port -> this machine"

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
  & $adb reverse --remove "tcp:$Port" 2>$null | Out-Null
  Write-Host "stopped; adb reverse removed"
}
