<#
.SYNOPSIS
  One-call HUD probe: fire a debug broadcast, then photograph the glasses through the camera rig.

.DESCRIPTION
  Collapses the whole verification cycle — broadcast -> settle -> re-focus the camera -> capture ->
  crop+upscale — into a single invocation, because doing it by hand costs five round trips per
  observation and the focus step is easy to forget.

  READ docs/VERIFICATION-RIG.md before trusting anything this prints. The traps that have each
  already caused a WRONG CONCLUSION at least once:

   * The camera's tap-to-focus EXPIRES. A frame that looks like an unlit HUD is usually just a
     stale focus/metering point. This script re-taps before every capture for exactly that reason —
     do not remove it.
   * Tap-to-focus also re-meters EXPOSURE. When the room lights changed (e.g. overnight), a
     previously-good manual exposure renders the whole frame pure black. Pitch-black output means
     "re-meter", not "the glasses are off".
   * HUD brightness 15 is the working value. 20+ blows the selected row into an unreadable bar;
     below 10 the unselected rows stop being legible. Judge the WHOLE screen, not the bright row.
   * The camera app must be in the FOREGROUND. It hibernates; -Wake brings it back.

  ⚠️ TWO COORDINATE SPACES — this one silently wasted a cycle:
    * android_tap takes DEVICE pixels. The phone is 720x1600.
    * android_get_screen_state returns a screenshot DOWNSCALED to ~351x700, i.e. ~2.05x smaller.
  So a coordinate read off a screenshot must be multiplied by ~2.05 before it is tapped. Taps that
  are merely in the wrong PLACE tend to look like "the button does nothing" rather than an error —
  a Connect button was tapped three times at screenshot coordinates before this was noticed. In the
  camera app the mistake hides even better, because any tap inside the preview still focuses
  SOMETHING, just not where intended. Use android_get_screen_state with include_screenshot=false to
  read a node's real bounds instead of eyeballing pixels.

  -CropX/-CropY/-CropW/-CropH are in SCREENSHOT pixels (the crop runs on the returned PNG);
  -FocusX/-FocusY are in DEVICE pixels (they drive a real tap). They are deliberately named
  differently so the two spaces cannot be confused at the call site.

  The crop window defaults to where the HUD sits at ~1.9X zoom. If the rig is physically nudged the
  window is wrong and you will crop empty space — pass -Full to see the whole frame and re-derive it.

.EXAMPLE
  .\scripts\hud-probe.ps1 -Action SETTING -Extra '--es key header' -Out hud_header
  .\scripts\hud-probe.ps1 -Action SHOW_LIST -Extra "--es items 'A,B,C'" -Out hud_list
  .\scripts\hud-probe.ps1 -Out hud_now          # capture only, send nothing
#>
param(
  # Debug broadcast to fire first (bare action name, e.g. SETTING / SHOW_LIST / BRIGHTNESS).
  # Omit to capture whatever is already on the HUD.
  [string]$Action,
  # Extra args for `am broadcast`, e.g. "--es key geo --ei value 1".
  # NOT named -Args: $Args is a PowerShell automatic variable, and a param of that name binds
  # to nothing, so the broadcast goes out with no extras and the probe silently does nothing.
  [string]$Extra = "",
  # Output basename; writes <Out>.png (full frame) and <Out>_zoom.png (cropped HUD).
  [string]$Out = "hud",
  # Seconds to let the render settle before the shutter. Image transfers need longer than lists.
  [int]$SettleSec = 4,
  # Skip the crop and keep the full frame — use when the rig has moved and the window is wrong.
  [switch]$Full,
  # FULL SENSOR RESOLUTION (2448x3264) instead of the low-res screen-state screenshot.
  # Presses the camera app's OWN shutter and pulls the JPEG it writes, so the app's focus, zoom
  # and exposure are all preserved. Use this whenever the answer depends on READING glyphs — it
  # is what finally made Hebrew letterforms legible. ~7x the linear resolution and ~2.4MB, so it
  # is slower; the default screen-state capture is fine for "did the screen change".
  [switch]$HiRes,
  # Bring the camera app back to the foreground first (it hibernates).
  [switch]$Wake,
  # Crop window in SCREENSHOT pixels (~351x700), tuned for ~1.9X zoom.
  [int]$CropX = 80, [int]$CropY = 170, [int]$CropW = 170, [int]$CropH = 80,
  [int]$Scale = 5,
  # Tap-to-focus point in DEVICE pixels (720x1600) — roughly the HUD's centre in the preview.
  [int]$FocusX = 318, [int]$FocusY = 420
)

# "Continue", NOT "Stop": adb and monkey write progress chatter to stderr even on success, and
# Windows PowerShell turns any native stderr into a terminating NativeCommandError under "Stop" —
# which aborts the probe on a command that actually worked. The one step that must not fail
# silently (the capture) is checked explicitly below.
$ErrorActionPreference = "Continue"
$root  = Split-Path $PSScriptRoot -Parent
$phone = Join-Path $PSScriptRoot "phone.ps1"
$adb   = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
$pkg   = "com.futurefounders.glassesos"
Set-Location $root

if ($Action) {
  & $adb shell "am broadcast -a com.futurefounders.ffs.$Action $Extra -p $pkg" > $null 2>&1
  Start-Sleep -Seconds $SettleSec
}

if ($Wake) {
  # The camera app hibernates; without this the capture silently returns the launcher.
  & $adb shell "monkey -p com.android.camera -c android.intent.category.LAUNCHER 1" > $null 2>&1
  Start-Sleep -Seconds 3
}

# Re-focus AND re-meter. Tapping on the HUD itself (not the dark surround) is what makes the text
# legible — metering on black overexposes the lit row into a solid bar.
& $phone -Tool android_tap -Arguments "{`"x`":$FocusX,`"y`":$FocusY}" > $null 2>&1
Start-Sleep -Seconds 3

$png = "$Out.png"
if (Test-Path $png) { Remove-Item $png -Force }

if ($HiRes) {
  # Press the camera app's shutter and pull the file it writes. NOT android_save_camera_photo:
  # that grabs the camera itself, losing the app's focus/zoom/exposure, and returns an
  # unusable blurred, blown-out frame. The app's own capture keeps every manual adjustment.
  & $phone -Tool android_tap -Arguments '{"x":360,"y":1327}' > $null 2>&1
  Start-Sleep -Seconds 4
  $env:MSYS_NO_PATHCONV = "1"   # or Git Bash rewrites /sdcard/... into a Windows path
  $latest = (& $adb shell "ls -t /sdcard/DCIM/Camera/*.jpg 2>/dev/null | head -1").Trim()
  if (-not $latest) { throw "no photo appeared in /sdcard/DCIM/Camera (did the shutter fire?)" }
  & $adb pull $latest $png > $null 2>&1
  if (-not (Test-Path $png)) { throw "pull failed for $latest" }
  "captured (hi-res) -> $png  [$([int]((Get-Item $png).Length/1024)) KB]"
  return
}

# The screenshot call fails intermittently; one retry has always been enough.
foreach ($try in 1..3) {
  & $phone -Tool android_get_screen_state -Arguments '{"include_screenshot":true}' -OutFile $png > $null 2>&1
  if (Test-Path $png) { break }
  Start-Sleep -Seconds 2
}
if (-not (Test-Path $png)) { throw "capture failed after 3 attempts (is the MCP server up?)" }

if ($Full) { "captured -> $png"; return }

Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Resolve-Path $png))
$dst = New-Object System.Drawing.Bitmap ([int]($CropW*$Scale)), ([int]($CropH*$Scale))
$g   = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = 'HighQualityBicubic'
$g.DrawImage($src,
  (New-Object System.Drawing.Rectangle(0,0,[int]($CropW*$Scale),[int]($CropH*$Scale))),
  (New-Object System.Drawing.Rectangle($CropX,$CropY,$CropW,$CropH)), 'Pixel')
$g.Dispose()
$zoom = "${Out}_zoom.png"
$dst.Save((Join-Path $root $zoom), [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose(); $src.Dispose()
"captured -> $png ; cropped -> $zoom"
