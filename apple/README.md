# Native Apple bridges

The current Android headless bridge is the functional baseline. These standalone
Swift apps share CoreBluetooth transport, firmware validation/OTA, framebuffer
assembly, LC3 voice capture, durable transcription/search, and buzzer streaming.
They do not use Expo, a JS server, SideStore, or the obsolete EvenHub UI flow.

## Mac development app

Open `FFSBridgeMac.xcodeproj` and build **FFSBridgeMac** for My Mac. No paid Apple
account is needed for local development. The command-line build is:

```sh
python3 tools/generate_project.py --mac
xcodebuild -project FFSBridgeMac.xcodeproj -target FFSBridgeMac \
  -configuration Debug -sdk macosx \
  SYMROOT="$PWD/build/MacProducts" OBJROOT="$PWD/build/MacIntermediates" build
```

The app uses the Mac's own Bluetooth radio. Allow Bluetooth when prompted, keep the
glasses powered and nearby, and click Connect glasses. Disconnect the phone bridge
before switching drivers. Both lenses connect serially to avoid overlapping initiators. Each completes the stock
authentication request and matching success reply before becoming ready. Authentication
failure stops that attempt; reconnect explicitly after handling any OS pairing prompt.
After OTA, all connection entry points share a ten-second reboot delay. Explicit
disconnect or a Bluetooth power change cancels the pending reconnect task. This
reconnect cooldown has been exercised during dual-lens OTA; it does not establish
indefinite connection reliability.
The Mac app can remain in the background; the Mac must be awake and in Bluetooth range.
A closed app, sleeping Mac, or glasses in a powered-off state cannot receive commands.

A local command server starts with the app. It binds **127.0.0.1:8766 only**, uses
AES-GCM authenticated requests with freshness/replay checks, and writes the private
client config to `~/.config/ffs/mac.json` (mode 0600). It provides no shell execution.
In the complete private workspace, use `python3 tools/mac.py --help` from its root:
that wrapper shares the Android rig lease and builds glasses C apps before transmission.
The wrapper also provides `capture --output /private/path/hud.png`: it builds the current framebuffer payload, sends it, and receives one complete frame. The low-level client here can be used standalone:

```sh
FFS_IPHONE_CONFIG="$HOME/.config/ffs/mac.json" tools/ffs-iphone status
```

Use the desktop command panel for any RPC below. The framebuffer is explicitly the
right lens; it does not prove stereo agreement or that the panel is physically lit.

**Wake display** clears the stock display-sleep (silent-mode) switch before sending
FWAK. It is an explicit request to leave that mode, not an audio-mute operation.
`status` includes the settings snapshot and `infoReceivedAt`; cached device readings
are invalidated when a connection drops or a new connection starts.

## iPhone app

Open `FFSBridge.xcodeproj`, choose your Personal Team under Signing & Capabilities,
connect and trust your iPhone, enable Developer Mode, select it, and Run. The original
unsigned-IPA/SideStore pipeline is historical, not the development install route.
The generator optionally reads `Signing.local.xcconfig`, which stays untracked:

```text
DEVELOPMENT_TEAM = your-team-id
```

On the phone, allow Bluetooth and enable Developer connection only when needed.
The phone must keep the app foreground for Mac RPC; iOS Bluetooth background support
is not an unrestricted Android foreground service. Local Network access is needed
for LAN discovery. USB CoreDevice tunneling also works after pairing the development
app through Xcode. The workspace's `tools/iphone.py pair` copies the app-specific
pairing key over the trusted device connection without printing it.

## Commands

`status`, `events` (with `since` cursor), `connect`, `disconnect`, `scan`, `stopScan`,
`deviceInfo`, `setting`, `push`, `appData`, `screenshotReset`, `screenshot`,
`uploadFirmware`, `flash`, `flashProbe`, `voiceStart`, `voiceStop`, `voiceStatus`,
`voiceConfig`, `voiceConfigStatus`, `voiceSearch`, `voiceSessions`, `voiceExport`,
`voiceClear`, `buzzerSpeak`, `buzzerPlay`, `buzzerStop`.

Arguments are JSON objects; see `BridgeModel.command` for the exact contract.
FFSA app commands and FFSC data now use the paired command queue: `push` requires
both lenses and returns `executed: true` only after firmware acknowledges the same
command on both lenses. This requires firmware supporting FFSQ/event 0x25; it does
not fall back to the old right-only ACK. Other payload pushes still acknowledge
Bluetooth writes only. Verify their execution with fresh loader diagnostics and pixels.

A paired delivery timeout stops queued writes because one lens may still own its
command buffer. Restart both glasses and the bridge before resuming; reconnecting
Bluetooth alone does not establish which command ran. Command identity, retries and
frame semantics are described in `docs/PAIRED_COMMANDS.md`.
`events` preserves non-microphone service payloads for diagnostics. Microphone packets
are routed only into the voice recorder and never into generic command logs.

Firmware must match an independently obtained CI SHA-256 and all component CRCs,
TOC/subheader boundaries and main-image MRAM bounds. Unknown goldens require explicit
opt-in. A successful dry-run for the exact image and both ready OTA channels is
mandatory. Real OTA owns the radio until transfer ends and reports reconnection
separately. **Arbitrary service 0x80 writes are forbidden.** The typed
`connectionHeartbeat` command sends only the exact Android connection heartbeat
(command 14); it requires both lenses and no active flash. The opt-in
`connectionHeartbeatEnabled` command sends it on each lens becoming ready and
every 12 seconds; it defaults off and pauses during OTA. Testing on stock 2.2.10.10
received heartbeat replies but did not prevent the 30-second disconnect.
Real OTA requires authentication on both current connections. This follows the
[upstream 2.2.9 compatibility fix](https://github.com/jimrandomh/g2flash/commit/7c6d3c15b0bac9ad7247163c12c53efeb101e503). During OTA,
control-channel heartbeat traffic is suppressed. An ambiguous timeout or lost
link stops the transfer without replaying a possibly committed block; only an
explicit block rejection permits retry in place. Automatic reconnect-and-resume
is not implemented. `python3 tools/test_flash_transfer.py` verifies these paths
against a simulated peer using the production transfer code.
Physical flashing still
requires the project's rig procedure and hardware validation of this path.

Recordings and STT credentials stay outside source control. On Mac they live under
`~/Library/Application Support/FFSBridgeMac`; on iOS in app Documents. Original
accepted LC3 packets and decoded PCM are retained. STT is off until configured;
`{"providerKind":"mock"}` is a synthetic test provider, not real transcription.
HTTP/WSS providers use the current Android configuration schema. WAV sharing and
full-text search are available. Buzzer speech requires the matching firmware stream
receiver; installing this app does not install newer firmware on the glasses.

## Verification

```sh
python3 tools/test_core.py
python3 tools/test_services.py
```

Core tests compare transport/OTA/settings structures against independent fixtures,
current Android firmware goldens and the private workspace's stock firmware image.
The service integration test needs only macOS and the vendored Android liblc3; it
checks synthetic audio decoding/PLC, duplicate/side filtering, durable raw/PCM/WAV,
STT indexing/restart recovery, and real localhost RPC authentication/replay rejection.
It uses the Mac command port, so quit FFS Dev Bridge before running that test.
These checks establish implementation behavior, not hardware parity. The private
workspace's STATUS.md is the home for actual on-glass verification results.

## Native app library and home screen

The shared `AppLibrary` stores native FFSA packages and small app-authored checkpoints
on the companion. **Apps on glasses** lets you import a package and sync its catalog.
Catalog sync first clears the on-glass catalog metadata, then sends the complete
desired snapshot of names, icon identifiers and version metadata. This makes both
lenses converge even if one contains an entry unknown to the current companion. Product-shell
firmware with persistent-catalog support retains those entries across reboot. When
the wearer opens one, the companion sends its current metadata, saved state and
code, in that order; no app content is preloaded by catalog synchronization. The companion waits for a firmware
execution acknowledgement. Back navigation, native drawing and memory release run on
the glasses. Recent apps are saved sessions, not background processes.

Settings readbacks are sent only when their encoded values differ from the last
paired acknowledgement. Failed sends and disconnections invalidate that cache;
unchanged polling therefore avoids another UI journal transaction while changed
settings and fresh connections still synchronize.

Each entry has **Add to glasses** / **Remove from glasses** controls. These change
only the on-glass catalog over Bluetooth; the companion retains the package and
checkpoint. Choices persist on the companion and are applied at the next sync if
made while disconnected. No firmware flash is needed for catalog additions,
removals or updated package names/icon identifiers. The companion can retain more
than 12 packages, while at most 12 may be listed on the glasses at once.

RPC: `libraryAdd {base64: <FXP1/FFSA frame>}`, `librarySetListed {id: <app ID>, listed: true|false}`,
`librarySync`, `libraryStatus`. The status field `listed` is the desired catalog
membership; the operation's message reports synchronization success or failure.
The workspace CLI supports `install <source.c> --library`; it chooses the packer from
that source's SDK checkout, or an explicit `--sdk-root`. App packages must match the
active firmware ABI. Existing ABI-5 voice apps do not run on the ABI-4 product image.

Optional private starter packages can be placed in `FFSBridge/SeedApps.local/*.ffsa`
before running the project generator. They are copied into the built app and imported
only if that app ID is not already in the user's library. This directory is ignored;
no proprietary firmware or private content belongs in the public bridge repository.

`python3 tools/test_app_library.py` exercises corrupt-package refusal, execution ACK matching,
local state persistence across restart, token-bearing app loads, and clearing state.
Native hardware and phone-background behaviour are separate validation steps; the
private workspace's STATUS.md records their current status.
