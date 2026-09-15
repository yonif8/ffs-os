# Codex client for FFS Glasses

The glasses run the interface; FFSBridgeMac is a transport. The bridge never
starts a local Codex process and never hosts a task. It opens an SSH byte pipe to
the already-running Codex app-server control socket on KJDev, upgrades that pipe
to WebSocket, and speaks the versioned app-server JSON-RPC protocol.

## Runtime architecture

```text
G2 lenses                  FFSBridgeMac                         KJDev
Codex ABI-5 app  <─CDX1─>  paired 0x91/0x90 transport  <─SSH─> existing app-server
local UI/gestures           1 KiB latest-state snapshots        existing tasks
       │
       └─LC3 mic──────────> Deepgram live stream
                <─CDX1 live transcript
```

The bridge sends complete `CDX1` snapshots rather than fragile deltas. A snapshot
is at most 1,024 bytes, preserves valid UTF-8, and drops oldest conversation text
first so the newest exchange survives mailbox pressure. Glasses commands carry a
launch session ID and monotonically increasing command ID. The bridge persists the
last accepted pair before a remote mutation, preventing a replayed BLE notification
from sending a spoken message twice.

Only semantic operations cross the bridge: select task, request older history,
change task-list page, start/pause/finalize transcription, answer a question, and
interrupt the active turn. Drawer movement, focus, scrolling, animations, draft
review, and Back behavior stay on the glasses.

## Tasks and projects

`CodexService` reads all non-archived tasks from KJDev, uses canonical app-server
project assignments when present, and otherwise applies explicitly configured
remote workspace roots. Anything unmatched is shown under **Unclassified**. It
does not invent or mutate projects. Stable 16-bit handles keep full server task IDs
off the constrained glasses wire. The last selected task and handle map persist in
Application Support.

The drawer is paged at 24 wire rows, including repeated project headings. Reaching
an end requests the next or previous page; a physical swipe still changes at most
one selectable row. Opening a task resumes it on KJDev and fetches the newest ten
turns. Older pages are prepended on demand. User and agent messages render; private
reasoning and tool internals do not.

Active tasks show a small spinner and idle tasks a green completed/waiting dot.
Agent message deltas stream into the current conversation. `request_user_input`
questions with selectable choices are presented sequentially; command, file and
permission approvals are deliberately not granted by the glasses client.

## Push to talk

The current firmware exposes its processed 16 kHz mono microphone stream on the
left/slave BLE link. Holding the touchpad opens/resumes capture; release disables
the microphone and pauses capture without sending. Holding again appends to the
same draft. Deepgram interim/final text returns in `CDX1` snapshots for live display.
A tap while paused opens the explicit Send/Discard review. Send asks Deepgram to
finalize, waits for the final tail, and issues exactly one `turn/start` with a stable
`clientUserMessageId`; Discard never contacts KJDev.

Voice configuration remains outside source control at:

```text
~/Library/Application Support/FFSBridgeMac/voice/stt-config.json
```

The production profile is English, 16 kHz `linear16`, Deepgram Nova-3, with both
batch and streaming endpoints. Keep this file mode `0600`; never put its key in a
repository, build setting, app package, screenshot, or test log.

## Codex bridge configuration

Optional KJDev and fallback project mapping lives outside source control at:

```text
~/Library/Application Support/FFSBridgeMac/codex/config.json
```

Example without credentials:

```json
{
  "host": "codex-server",
  "socketPath": "/home/claude-bot/.codex/app-server-control/app-server-control.sock",
  "projects": [
    {"name": "misc poly", "root": "/home/claude-bot/ClaudeProjects/tsy/misc_poly"}
  ]
}
```

The SSH host must already work non-interactively. The bridge invokes fixed
`/usr/bin/ssh` with `BatchMode=yes` and a fixed `nc -U <socket>` command. It does not
accept shell fragments from glasses or RPC clients.

## Diagnostics and verification

Developer RPCs `codexStatus` and `codexRefresh` report connectivity, task count,
active task, thinking state, PTT state and draft byte count. The ordinary `status`
response embeds the same object. Codex transport events join the existing daily
JSONL log, but transcript contents and credentials are not added to command logs.

Reproduce the off-device checks from the Apple repository root:

```sh
python3 apple/tools/test_codex.py --live
python3 apple/tools/test_services.py
python3 apple/tools/test_app_library.py
python3 apple/tools/generate_project.py --mac --no-local-seeds
xcodebuild -project apple/FFSBridgeMac.xcodeproj -target FFSBridgeMac \
  -configuration Debug -sdk macosx \
  SYMROOT="$PWD/apple/build/MacProducts" \
  OBJROOT="$PWD/apple/build/MacIntermediates" build
```

`--live` is read-only: it initializes against the existing KJDev app-server and
lists projects/tasks. It does not resume a task or start a turn.

## Failure and rollback

If KJDev disconnects, the glasses retain the latest snapshot and local navigation;
the bridge reconnects with bounded backoff. A draft is retained when final send
cannot reach KJDev. Stop is enabled semantically only when this connection knows the
active task and turn IDs. Exit Codex is entirely local and never interrupts a turn.

Rollback is recoverable: quit the new FFSBridgeMac build, restore the previous
signed `.app` bundle, relaunch it, and remove Codex from the desired on-glass catalog
with `librarySetListed` if required. The retained package, task mapping, transcripts
and recordings remain in Application Support unless deliberately removed. App
catalog rollback does not require a firmware reflash. If release-event support was
introduced by a firmware candidate, use the separately pinned known-good loader
artifact and the workspace's controlled flash procedure; never reconstruct or flash
an unverified local image.

## Deliberate limits

- English transcription only.
- At most three displayed choices per question; no free-form question response yet.
- No file editing UI, command approval, file-change approval, task creation, rename,
  archive or model selection on glasses.
- Conversation snapshots are intentionally bounded; older history is paged.
- Mac must be awake, in BLE range, and able to reach KJDev and Deepgram.
- The experimental Starfield app-launch transition remains disabled; Codex uses the
  normal OS loader and app lifecycle.
