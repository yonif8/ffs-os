<#
.SYNOPSIS
  Tap the on-screen element whose text/description matches a regex, scrolling to find it.

.DESCRIPTION
  Taps by ELEMENT BOUNDS rather than by eyeballed pixels. This exists because of a specific,
  repeatable failure:

    * android_tap takes DEVICE pixels (this phone is 720x1600), but the screenshot that
      android_get_screen_state returns is downscaled to ~351x700. Reading a coordinate off the
      screenshot and tapping it lands at less than half the intended height.
    * A tap in the wrong place produces NO error and NO log line — it looks exactly like a button
      that does nothing. The Connect button was "pressed" three times this way before anyone
      noticed the taps were landing in empty space.
    * Even a correct coordinate goes stale: relaunching the app resets the scroll position, so
      yesterday's y is today's different row.

  Querying the accessibility tree each time removes all three failure modes at once.

.EXAMPLE
  .\scripts\tap-text.ps1 -Match 'Scan \+ reclaim'      # the Connect row in the FFS app
#>
param(
  # Regex matched against each node's text and content-description.
  [Parameter(Mandatory = $true)][string]$Match,
  # How many times to scroll down looking for it before giving up.
  [int]$MaxScrolls = 6,
  # Report the match without tapping.
  [switch]$WhatIfOnly
)

$ErrorActionPreference = "Continue"
$phone = Join-Path $PSScriptRoot "phone.ps1"

function Find-Node([string]$pattern) {
  $dump = & $phone -Tool android_get_screen_state -Arguments '{"include_screenshot":false}' 2>&1 | Out-String
  foreach ($line in ($dump -split "`n")) {
    if ($line -notmatch $pattern) { continue }
    # Node rows are tab-separated and carry bounds as "left,top,right,bottom".
    if ($line -match '(\d+),(\d+),(\d+),(\d+)\s') {
      $l = [int]$Matches[1]; $t = [int]$Matches[2]; $r = [int]$Matches[3]; $b = [int]$Matches[4]
      # Skip nodes that are entirely behind the navigation bar (y >= 1504) — tapping those
      # hits the system nav, not the app.
      if ($t -ge 1500) { continue }
      return @{ x = [int](($l + $r) / 2); y = [int](($t + $b) / 2); line = $line.Trim() }
    }
  }
  return $null
}

for ($i = 0; $i -le $MaxScrolls; $i++) {
  $node = Find-Node $Match
  if ($node) {
    "found: $($node.line)"
    if ($WhatIfOnly) { "would tap ($($node.x),$($node.y))"; return }
    & $phone -Tool android_tap -Arguments "{`"x`":$($node.x),`"y`":$($node.y)}" 2>&1 | Select-Object -Last 1
    return
  }
  if ($i -eq $MaxScrolls) { break }
  # Scroll in DEVICE coordinates.
  & $phone -Tool android_swipe -Arguments '{"x1":360,"y1":1200,"x2":360,"y2":600,"duration_ms":400}' > $null 2>&1
  Start-Sleep -Seconds 2
}

throw "no visible element matched /$Match/ after $MaxScrolls scrolls"
