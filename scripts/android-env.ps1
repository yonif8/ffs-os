# Build-shell environment for the Android target (Windows).
#
# Dot-source it, don't run it -- it must modify the CURRENT shell:
#
#     . .\scripts\android-env.ps1
#     npx expo run:android
#
# Deliberately NOT set as persistent user environment variables: this box already
# juggles a clang/Python PATH prelude for the CFW build (see CLAUDE.md "PATH for a
# build shell"), and a global JAVA_HOME is exactly the kind of ambient state that
# makes "works on my machine" bugs. One explicit command per shell is cheaper to
# reason about than invisible global state.
#
# Installed 2026-08-06. Versions are pinned by Expo 57 / RN 0.86:
#   compileSdk 36, minSdk 24, targetSdk 36, NDK 27.1.12297006, Gradle 9.3.1, JDK 17.
#
# ABI POLICY (decided 2026-08-06)
# ------------------------------
# app.json pins `buildArchs: ["armeabi-v7a"]` for the local dev loop, because the test
# phone (23028RNCAG, Android 13) runs a 32-bit-only ROM -- `ro.product.cpu.abilist64` is
# EMPTY and `ro.zygote` is `zygote32`. An arm64-v8a APK will not install on it at all.
#
# That pin is a DEV convenience, not a product decision. Any build meant to leave this
# machine must override it so the APK is not silently 32-bit-only:
#
#     .\gradlew.bat assembleRelease -PreactNativeArchitectures=armeabi-v7a,arm64-v8a
#
# (Roughly doubles NDK compile time, which is exactly why it is not the local default.)

$jdk = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot"
$sdk = "$env:LOCALAPPDATA\Android\Sdk"

if (-not (Test-Path $jdk)) { Write-Error "JDK 17 not found at $jdk"; return }
if (-not (Test-Path $sdk)) { Write-Error "Android SDK not found at $sdk"; return }

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:PATH = "$jdk\bin;$sdk\platform-tools;$sdk\cmdline-tools\latest\bin;$env:PATH"

Write-Host "JAVA_HOME    = $env:JAVA_HOME"
Write-Host "ANDROID_HOME = $env:ANDROID_HOME"
Write-Host ("java         = " + ((& java -version 2>&1)[0]))
if (Get-Command adb -ErrorAction SilentlyContinue) {
  Write-Host ("adb          = " + ((& adb version 2>&1)[0]))

  # Metro (debug JS bundle) and the on-device Android Remote Control MCP server.
  #
  # Both are localhost-only on their respective sides, tunnelled over the adb transport:
  #   reverse 8081 -> the PHONE reaches Metro on this PC
  #   forward 18080 -> this PC reaches the MCP server bound to 127.0.0.1:8080 ON THE PHONE
  #
  # Neither survives an adb server restart or a device reconnect, which is why they are
  # re-established here rather than set up once. The MCP server is registered user-scoped
  # in ~/.claude.json as "android-device"; it goes unreachable without this forward.
  & adb reverse tcp:8081 tcp:8081 2>&1 | Out-Null
  & adb forward tcp:18080 tcp:8080 2>&1 | Out-Null
  Write-Host "tunnels      = metro reverse 8081, device-mcp forward 18080"
} else {
  Write-Host "adb          = NOT FOUND (install platform-tools)"
}
