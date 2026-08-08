<#
.SYNOPSIS
  Compare two HUD captures region by region, to decide what actually changed on the lens.

.DESCRIPTION
  Written because the rig's optical resolution is not always enough to READ small text through
  the camera — the glow blooms and six clock digits turn into one bright smear. Squinting at a
  blurry crop is exactly the kind of "evidence" that has produced wrong conclusions on this
  project before.

  A per-region pixel difference answers the question that actually matters without needing to
  resolve glyphs: did the HEADER change while the LIST stayed put? That is the whole claim behind
  an in-place text update, and it is measurable even when the text is illegible.

  Regions are in SCREENSHOT pixels (the ~351x700 downscaled frame), matching hud-probe's crop
  space — NOT device pixels.

.EXAMPLE
  .\scripts\region-diff.ps1 -A clock_a.png -B clock_b.png
#>
param(
  [Parameter(Mandatory = $true)][string]$A,
  [Parameter(Mandatory = $true)][string]$B,
  # Header strip and list body, as they sit at the rig's ~1.9X zoom.
  [int[]]$Header = @(86, 176, 60, 12),
  [int[]]$List   = @(86, 195, 140, 40),
  # A patch of empty background — the noise floor, so sensor noise is not read as a change.
  [int[]]$Background = @(250, 300, 60, 40)
)

$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Drawing

function Mean-AbsDiff($bmpA, $bmpB, [int[]]$r) {
  $sum = 0.0; $n = 0
  for ($y = $r[1]; $y -lt $r[1] + $r[3]; $y++) {
    for ($x = $r[0]; $x -lt $r[0] + $r[2]; $x++) {
      $pa = $bmpA.GetPixel($x, $y); $pb = $bmpB.GetPixel($x, $y)
      # Green channel only: the HUD is monochrome green and the other channels are mostly noise.
      $sum += [Math]::Abs([int]$pa.G - [int]$pb.G); $n++
    }
  }
  if ($n -eq 0) { return 0 }
  return [Math]::Round($sum / $n, 2)
}

$bmpA = New-Object System.Drawing.Bitmap((Resolve-Path $A).Path)
$bmpB = New-Object System.Drawing.Bitmap((Resolve-Path $B).Path)

$noise = Mean-AbsDiff $bmpA $bmpB $Background
$hdr   = Mean-AbsDiff $bmpA $bmpB $Header
$lst   = Mean-AbsDiff $bmpA $bmpB $List

$bmpA.Dispose(); $bmpB.Dispose()

"background (noise floor) : $noise"
"header                   : $hdr"
"list body                : $lst"
if ($noise -gt 0) {
  "header / noise           : $([Math]::Round($hdr / [Math]::Max($noise, 0.01), 1))x"
  "list   / noise           : $([Math]::Round($lst / [Math]::Max($noise, 0.01), 1))x"
}
