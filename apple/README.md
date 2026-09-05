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
before switching drivers. Both lenses connect serially to avoid overlapping initiators.
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

Arguments are JSON objects; see `BridgeModel.command` for the exact contract. A push
acknowledges Bluetooth writes, **not execution**. Attribute results using fresh loader
generation, executed generation, payload/frame lengths and return code, then pixels.
`events` preserves non-microphone service payloads for diagnostics. Microphone packets
are routed only into the voice recorder and never into generic command logs.

Firmware must match an independently obtained CI SHA-256 and all component CRCs,
TOC/subheader boundaries and main-image MRAM bounds. Unknown goldens require explicit
opt-in. A successful dry-run for the exact image and both ready OTA channels is
mandatory. Real OTA owns the radio until transfer ends and reports reconnection
separately. **Service 0x80 is forbidden**, including the old Android heartbeat; the
Apple bridge uses a read-only settings query on 0x09 instead. Physical flashing still
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
