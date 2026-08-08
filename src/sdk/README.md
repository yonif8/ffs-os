# The FFS SDK

A TypeScript SDK for the Even Realities G2. Everything here is written so an app can be built
against it **without touching firmware internals** — no protobuf, no field numbers, no container
ids, no BLE. [`os.ts`](os.ts) is the worked proof of that claim: a complete mini-OS that imports
nothing but `Session` and its own host interface.

Everything except [`native.ts`](native.ts) is pure and runs under `bun test` with no glasses
attached (108 tests).

## The five-minute version

```ts
import { Session } from "./session";
import { nativeTransport, nativeHost, takeoverPage } from "./native";

const session = new Session({
  transport: nativeTransport(),
  // The firmware holds ONE page and ignores a second CREATE — ask the driver what it already did.
  pageAlreadyCreated: takeoverPage(),
});

await session.menu(
  { header: "Settings", rows: [{ label: "Clock", value: "clock" }] },
  async (sel) => { /* push more screens here */ }
);
```

`menu()` returns when the user backs out. A double-tap is "back", and it arrives as a **value**
(`null` from `nextSelection()`), never an exception — so a stray `catch {}` in an app cannot
swallow the second-most-common user action.

## Why it is shaped like this

**Declare once; the glasses own the interaction.** A list is declared one time and the firmware
runs the scrolling itself. Measured: scrolling row 0 → row 1 produced *zero* wire traffic. There
is deliberately **no reconciler** — any diffing layer risks reintroducing the per-scroll round
trip the SDK exists to remove. `SessionStats.declareCount` exists so a test can assert that.

**Pop and reconnect are the same function.** The firmware has no page stack, so returning from a
submenu means re-declaring the parent — byte-for-byte what recovering from a dropped link must
do. Implementing them once makes the least-testable path also the most-exercised one. Verified
against a real drop: the OS re-declared a running timer at stack depth 4.

**Provenance is enforced, not documented.** [`types.ts`](types.ts) carries a ledger of ~40
capabilities with their evidence, and `assertProven()` **throws** for anything unproven. Mapped ≠
proven; an address is not a capability, and neither is an encoder that passes its tests.

## THE CONSTRAINT THAT SHAPES EVERY UI

**The glasses report nothing until a tap.** Scrolling is native and silent, so the phone *cannot*
know which row is under the user's finger. Anything the phone draws to indicate selection is
therefore permanently out of sync.

Consequences, all of which the launcher's design is downstream of:
- The only selection indicator that can track a scroll is the firmware's own list highlight.
- A "details of the highlighted item" panel is **impossible**. The launcher's panel shows world
  state (time, battery, date) because that is true regardless of which row is lit — which is
  very likely why Even's own head-up display is also a dashboard.
- Any UI that needs to know the cursor position needs a redesign, not a workaround.

## What the display can and cannot do

Established on hardware, each the hard way:

| Fact | Consequence |
|---|---|
| A **narrow list draws its focused row as a rounded tile** (64px wide → 64×41, r≈13) | This is the iPhone-style app icon, drawn by the firmware, sliding at zero wire cost |
| **TEXT containers ignore borderWidth/Color/Radius/padding** | No boxes. Structure comes from type, position and whitespace; rules are literal underscores |
| **No font size, weight or alignment field exists** | Letterspacing (`spaceOut`) is the ONLY typographic hierarchy. Containers are the only tab stops |
| **1 LIST + 7 TEXT renders; 5 LISTS is fatal** | A rejected page blanks the HUD *and* kills the page slot until a reconnect + CREATE. `encodeCompositePage` throws above the proven shape |
| **Cmd 5 updates any container id in place** | Live widgets without a rebuild — and a rebuild would reset list focus to row 0 every tick |
| **A page REBUILD resets list focus** | Never rebuild on a timer. Rebuild only on navigation |
| Row pitch ≈ 41px, glyph advance ≈ 12px | Measured off photographs; layouts carry slack rather than depending on exactness |

## The sharp edge: the page slot

The firmware has **one** page slot and a second `CREATE` is *silently ignored*. So
CREATE-vs-REBUILD is a property of the **link**, not of a screen — `PageSlot` models exactly
that, and `Session` owns one.

Deciding it per-screen looks natural and is wrong: every pushed submenu would believe it had
never declared, send a second CREATE, and be dropped with no error — the HUD keeps showing the
parent while the phone believes it navigated. Pinned by *"a pushed submenu REBUILDs"*.

- On a **drop**, call `session.onDisconnected()`; the firmware kept nothing.
- On **boot**, seed from `takeoverPage()`; the driver is the authority.

## Layout

| File | What |
|---|---|
| `proto.ts` | Protobuf reader/writer. ⚠️ Keeps wire-type-5 bytes — skipping them silently drops IMU data |
| `base64.ts` | The codec on every byte in and out. Checked against Node's `Buffer` |
| `deflate.ts` | Minimal zlib (stored blocks), for the raster path. Checked against Node's inflater |
| `wire.ts` | Page/container/image encoders. `CONTAINER_IDS` are firmware lookup keys |
| `events.ts` | Inbound decode. ⚠️ Proto3 omits defaults — an absent index means row 0 |
| `settings.ts` | sid `0x09`. ⛔ Never write sid `0x80` |
| `sound.ts` | The piezo. ⛔ Raw tones do NOT self-terminate — see below |
| `raster.ts` | 8bpp canvas with antialiased shapes, for the direct-framebuffer path |
| `bmp.ts` | 4-bit BMP — the proven decode path, kept as a control |
| `launcher.ts` | The rail launcher: geometry, slots, page encoder |
| `screen.ts` | `ListScreen`, `Transport`, `PageSlot`, slots and in-place updates |
| `session.ts` | The screen stack and the single restore path |
| `types.ts` | The provenance ledger, `LIMITS`, and the runtime gate |
| `os.ts` | The mini-OS. Imports no firmware detail — that is the point |
| `native.ts` | The **only** file that knows the native module exists |

## Hard-won facts

- **Row 0 has no index field.** Proto3 omits zero, so a tap on the first row carries no index.
- **`EventSource` only exists on Sys events** — a tap on a list is permanently source-blind.
- **Double-tap arrives as a SysEvent**, not a list event, even with a list on screen.
- **Brightness is nonlinear.** 15 is the working value through the camera rig.
- **`BRIGHTNESS_INFO` returns only brightness** — query `BASIC_SETTING` for anything else.
- **Lens offset is fields 4 (x) and 3 (y).** Fields 15/16 are *brightness* calibration.
- ⛔ **Raw buzzer tones never stop by themselves on 2.2.7.14.** `ms` is silently discarded because
  the firmware's stop-timer handle reads 0. Use a preset, or `playToneSafely()` which arms its own
  phone-side STOP. This woke someone at 4am.
- ⛔ **Never call SELECT (event 2) from a CFW payload** — it reboots a lens.
- **IMU control transmits but nothing comes back** (both candidate wrapper fields tried, zero
  inbound frames). Untested in motion.
- **The CFW image channel has a direct-framebuffer mode** (mode 2: zlib → display buffer at 8bpp).
  Encoders written and pinned; **not yet rendering** — see `cfw.directFramebuffer`.

## Testing

```bash
bun test src/sdk/__tests__
```

The tests that matter pin *architecture*, not behaviour: scrolling costs zero bytes, a submenu
REBUILDs, a dropped link CREATEs afresh, identical content is a genuine no-op, a failed push
unwinds, and a ticking clock never rebuilds the page. Those are the properties a future refactor
would break silently.
