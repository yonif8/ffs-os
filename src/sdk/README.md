# The FFS SDK

A TypeScript SDK for the Even Realities G2. Everything here is written so an app can be built
against it **without touching firmware internals** — no protobuf, no field numbers, no container
ids, no BLE. [`os.ts`](os.ts) is the worked proof of that claim: it is a complete mini-OS and it
imports nothing but `Session` and its own host interface.

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
  { rows: [{ label: "Clock", value: "clock" }, { label: "Settings", value: "settings" }] },
  async (sel) => {
    if (sel.value === "settings") { /* push more screens here */ }
  }
);
```

`menu()` returns when the user backs out. A double-tap on the temple is "back", and it arrives as
a value (`null` from `nextSelection()`), never as an exception — so a stray `catch {}` in an app
cannot swallow the second-most-common user action.

## Why it is shaped like this

**Declare once; the glasses own the interaction.** A list is declared one time and the firmware
runs the scrolling itself. Measured on hardware: scrolling row 0 → row 1 produced *zero* wire
traffic; the phone heard nothing until the user tapped. There is deliberately **no reconciler** —
any diffing layer risks reintroducing the ~156 ms-per-scroll round trip the SDK exists to remove.
`SessionStats.declareCount` and `bytesOut` exist so a test can assert that property rather than
hope for it.

**Pop and reconnect are the same function.** The firmware has no page stack, so returning from a
submenu means re-declaring the parent — which is byte-for-byte what recovering from a dropped
link must do. Implementing them once means the least-testable path in the SDK is also the
most-exercised one: if restore breaks, the settings menu breaks in the first minute of ordinary
use, on a perfectly healthy link.

**Provenance is enforced, not documented.** [`types.ts`](types.ts) carries a ledger of every
capability with its evidence, and `assertProven()` **throws** for anything unproven. Cardinal rule
1 says mapped ≠ proven; a warning in a log nobody reads is how "mapped" quietly becomes "shipped".
The `allowUnproven` escape hatch exists because the experiment that proves a capability must call
it while it is still unproven.

## The one sharp edge: the page slot

The firmware has **one** page slot, and a second `CREATE` on it is *silently ignored*. So
CREATE-vs-REBUILD is a property of the **link**, not of a screen — `PageSlot` in
[`screen.ts`](screen.ts) models exactly that, and `Session` owns one.

This is the SDK's most expensive lesson. Deciding it per-screen looks natural and is wrong: every
pushed submenu would start life believing it had never declared, send a second CREATE, and be
dropped on the floor. Nothing reports an error — the HUD simply keeps showing the parent menu
while the phone believes it navigated. A menu tree hits this on the very first navigation.
Pinned by *"a pushed submenu REBUILDs"* in `__tests__/session.test.ts`.

Two corollaries:
- On a **dropped link** call `session.onDisconnected()` — the firmware kept nothing, so REBUILDing
  a page that no longer exists would leave the HUD blank.
- On **boot**, seed from `takeoverPage()`. Booting on a link where anything already rendered
  otherwise makes the opening CREATE a silent no-op.

## Layout

| File | What |
|---|---|
| `proto.ts` | Hand-rolled protobuf reader/writer. Pure. |
| `base64.ts` | The codec on every byte in and out. Pure, and tested against Node's `Buffer`. |
| `wire.ts` | Page/container encoders; `CONTAINER_IDS` are firmware lookup keys. |
| `events.ts` | Inbound decode. ⚠️ Proto3 omits defaults — an absent index means row 0. |
| `settings.ts` | sid `0x09`. ⛔ Never write sid `0x80`. |
| `screen.ts` | `ListScreen`, `Transport`, `PageSlot`. |
| `session.ts` | The screen stack and the single restore path. |
| `types.ts` | The provenance ledger, `LIMITS`, and the runtime gate. |
| `os.ts` | The mini-OS. Imports no firmware detail — that is the point. |
| `native.ts` | The **only** file that knows the native module exists. |

Everything except `native.ts` is pure and runs under `bun test` with no glasses attached.

## Hard-won facts

- **Row 0 has no index field.** Proto3 omits zero, so a tap on the first row carries no index at
  all. Decoding absent-as-null made row 0 unselectable.
- **`EventSource` only exists on Sys events.** A tap on a list or text container is permanently
  source-blind: you cannot tell the temple pad from the ring.
- **Double-tap arrives as a SysEvent**, not a list event, even with a list on screen.
- **Brightness is nonlinear.** 15 is the working value through the camera rig; 100 blows the
  selected row into an unreadable bar and below 10 the unselected rows stop being legible.
- **`BRIGHTNESS_INFO` returns only brightness.** Query `BASIC_SETTING` for anything else, or a
  successful setter looks like it failed.
- **Lens offset is fields 4 (x) and 3 (y).** Fields 15/16 are *brightness* calibration.
- ⛔ **Never call SELECT (event 2) from a CFW payload** — it reboots a lens.

## Testing

```bash
bun test src/sdk/__tests__
```

The tests that matter are the ones that pin *architecture* rather than behaviour: scrolling costs
zero bytes, a submenu REBUILDs, a dropped link CREATEs afresh, and identical content is a genuine
no-op. Those are the properties a future refactor would break silently.
