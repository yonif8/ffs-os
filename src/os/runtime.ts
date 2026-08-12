// The mini-OS runtime — boots FfsOs on the glasses and keeps it alive across link drops.
//
// This is the seam between the app and the SDK, and it is intentionally the ONLY place that
// knows both exist. The OS itself (src/sdk/os.ts) never imports the driver; it is written purely
// against Session/OsHost, which is the property that makes "an app can be written against the
// SDK without touching firmware internals" a demonstrable claim rather than an aspiration.

import FfsBle from "../../modules/ffs-ble";
import { FfsOs } from "../sdk/os";
import { Session } from "../sdk/session";
import { nativeHost, nativeTransport, takeoverPage } from "../sdk/native";
import { describeEvent, normalizeEvent, parseImageAck, parsePageResponse } from "../sdk/events";
import { hex } from "../sdk/proto";
import {
  IMU_CTRL_FIELD,
  encodeImuControl,
  encodeProbe3Page,
  encodeStyleProbePage,
  encodeTileProbePage,
} from "../sdk/wire";
import { encodeLauncherPage, spaceOut } from "../sdk/launcher";
import { encodeImagePage, encodeImageRawData } from "../sdk/wire";
import { Raster } from "../sdk/raster";
import { zlibStored } from "../sdk/deflate";
import { rasterToBmp } from "../sdk/bmp";

type Log = (message: string) => void;

/**
 * Image sessions must differ between pushes; a reused id can read as a repeat of a session the
 * firmware has already completed.
 *
 * Starts at 128 rather than 0 ON PURPOSE: the NATIVE driver has its own counter that begins at 1
 * and has already used low ids this session. Sharing the low range means our first push can
 * collide with one the firmware considers finished — so the two counters are kept apart.
 */
let rasterSession = 128;

export class OsRuntime {
  private session: Session | null = null;
  private host: (ReturnType<typeof nativeHost>) | null = null;
  private subs: Array<{ remove(): void }> = [];
  private running = false;

  constructor(private readonly log: Log = () => {}) {}

  get isRunning(): boolean { return this.running; }

  /**
   * Boot the OS.
   *
   * Seeding the session from `takeoverPage()` is load-bearing: the firmware holds ONE page and
   * ignores a second CREATE, so booting on a link where anything already rendered (a debug list,
   * the dashboard) would otherwise send a CREATE that the firmware drops on the floor — the HUD
   * would keep showing the old screen and nothing would report an error.
   */
  async boot(): Promise<void> {
    if (this.running) {
      this.log("[os] already running");
      return;
    }
    this.running = true;

    const alreadyCreated = takeoverPage();
    this.log(`[os] boot — firmware page ${alreadyCreated ? "EXISTS (rebuild)" : "absent (create)"}`);

    const host = nativeHost();
    const session = new Session({
      transport: nativeTransport(),
      pageAlreadyCreated: alreadyCreated,
      onRestore: (cause, depth) => this.log(`[os] restore(${cause}) depth=${depth}`),
    });
    this.host = host;
    this.session = session;

    // The link is the OS's ground truth. A drop means the firmware kept nothing, so the page
    // slot must be cleared before recovery — otherwise the restoring declare goes out as a
    // REBUILD of a page that no longer exists and the HUD stays blank.
    this.subs.push(
      FfsBle.addListener("onDisconnected", () => {
        this.log("[os] link lost");
        session.onDisconnected();
      })
    );
    this.subs.push(
      FfsBle.addListener("onPairReady", () => {
        // RE-SEED from the driver rather than trusting our own bookkeeping. `onDisconnected`
        // fires per LENS, and only the right lens holds the page, so inferring "the firmware
        // lost its page" from any drop is a guess — and guessing wrong here is silent either
        // way: a stale CREATE is ignored and leaves the HUD frozen, a stale REBUILD targets a
        // page that no longer exists and leaves it blank. The driver knows; ask it.
        const held = takeoverPage();
        if (held) session.pageSlot.markCreated();
        else session.pageSlot.reset();
        this.log(`[os] link back — firmware page ${held ? "held" : "gone"}, restoring`);
        void session.onReconnected().catch((e) => this.log(`[os] restore failed: ${e}`));
      })
    );

    const os = new FfsOs(session, host);
    try {
      // Resolves when the user backs out of the home screen.
      await os.run();
      this.log("[os] home exited");
    } catch (e) {
      this.log(`[os] crashed: ${e}`);
    } finally {
      this.stop();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    this.session?.closeAll();
    this.session = null;
    this.host?.dispose();
    this.host = null;
    this.log("[os] stopped");
  }
}

/**
 * Wire the debug `OS` broadcast to the runtime. Returns an unsubscribe function.
 *
 * Debug-only by construction: the broadcast receiver that emits `onOsCommand` is itself gated on
 * FLAG_DEBUGGABLE in the native module.
 */
export function attachOsCommandListener(log: Log = () => {}): () => void {
  const runtime = new OsRuntime(log);

  // THE DIAGNOSTIC THAT WAS MISSING ALL NIGHT. The firmware answers every page request with a
  // verdict — CREATE_INVALID_CONTAINER, OVERSIZE, OUT_OF_MEMORY, REBUILD_FAILED — and we were
  // not listening, so a rejected page and a page that simply drew nothing looked identical from
  // here. Logging every one turns "the HUD is black" into a reason, for free and always on.
  //
  // FAILURES ALWAYS; successes only when the verdict for that kind CHANGES. The dashboard sends
  // up to five in-place text updates per tick and each is answered, so logging every success
  // would emit ~15 lines a minute of "text ok" and bury the rejections this exists to surface —
  // a diagnostic that drowns its own signal is worse than not having one.
  const lastVerdict = new Map<string, string>();
  const verdicts = nativeTransport().onInbound((p) => {
    const r = parsePageResponse(p);
    if (!r) return;
    if (!r.ok) {
      log(`[page] ${r.kind} REJECTED by firmware: ${r.name}`);
      lastVerdict.set(r.kind, r.name);
      return;
    }
    if (lastVerdict.get(r.kind) !== r.name) {
      log(`[page] ${r.kind} ok`);
      lastVerdict.set(r.kind, r.name);
    }
  });

  // EVERY probe is fired through here, never with a bare `void`.
  //
  // `void somePromise()` discards the rejection, and Hermes prints nothing for an unhandled one.
  // Measured 2026-08-09: a raster push stopped between "container declared" and the first
  // fragment and produced NO log line, NO error and NO red box — indistinguishable from the
  // glasses ignoring us, which is the single most expensive thing a failure can look like here.
  // It cost a hardware cycle to even establish that the throw was on the phone.
  const fire = (name: string, p: Promise<void>) =>
    void p.catch((e) => log(`[${name}] THREW: ${(e && (e.stack || e.message)) || String(e)}`));

  const sub = FfsBle.addListener("onOsCommand", ({ cmd }) => {
    if (cmd === "stop") runtime.stop();
    else if (cmd === "imu") fire("imu", probeImu(log));
    else if (cmd === "styles") fire("styles", probeStyles(log));
    else if (cmd === "tiles") fire("tiles", probeTiles(log));
    else if (cmd === "p3") fire("p3", probe3(log));
    else if (cmd === "launcher") fire("launcher", showLauncher(log));
    else if (cmd === "raster") fire("raster", showRaster(log, "mode2"));
    else if (cmd === "rasterbmp") fire("raster", showRaster(log, "bmp"));
    // Single-fragment variants: small enough that the whole frame fits one message, which
    // removes fragmenting and ACK ordering from the experiment entirely.
    else if (cmd === "rastertiny") fire("raster", showRaster(log, "mode2", 48, 32));
    else if (cmd === "rastertinybmp") fire("raster", showRaster(log, "bmp", 48, 32));
    // The two-frame experiment: same encoder, deliberately different pixels. See RasterVariant.
    else if (cmd === "rastera") fire("raster", showRaster(log, "mode2", 48, 32, "A"));
    else if (cmd === "rasterb") fire("raster", showRaster(log, "mode2", 48, 32, "B"));
    else if (cmd === "rasterabmp") fire("raster", showRaster(log, "bmp", 48, 32, "A"));
    else if (cmd === "rasterbbmp") fire("raster", showRaster(log, "bmp", 48, 32, "B"));
    else fire("boot", runtime.boot());
  });
  return () => {
    sub.remove();
    verdicts();
    runtime.stop();
  };
}

/**
 * Turn the IMU stream on, report what comes back, and turn it off again.
 *
 * Worth noting what this probe does NOT need: any native code. The head-motion stream is a plain
 * EvenHub command in and plain EvenHub frames out, so `sendEvenHub` + `onServiceRaw` carry it
 * end to end. A new capability on this service costs a TypeScript function and nothing else —
 * which is the actual test of whether the two-call transport was drawn in the right place.
 *
 * ⚠️ The reference kit's author records never once observing IMU data from this firmware, so an
 * empty result here is a real possible outcome and not necessarily a bug in this code.
 */
async function probeImu(log: Log): Promise<void> {
  const tx = nativeTransport();
  let samples = 0;
  let decoded = 0;
  let rawFrames = 0;

  // Count RAW frames, not just decoded ones. "no IMU samples" and "the glasses sent nothing at
  // all" are different findings, and only the raw count separates them.
  const off = tx.onInbound((payload) => {
    rawFrames += 1;
    const e = normalizeEvent(payload);
    if (e?.kind === "imu") {
      samples += 1;
      if (samples <= 5) log(`[imu] ${describeEvent(e)}`);
    } else if (e) {
      decoded += 1;
    } else if (rawFrames <= 6) {
      // Anything the decoder does not recognise, verbatim — an IMU frame in an unexpected shape
      // would otherwise be indistinguishable from silence.
      log(`[imu] undecoded frame: ${hex(payload)}`);
    }
  });

  // THE 22-vs-20 QUESTION IS CLOSED, so this no longer sweeps both.
  //
  // This loop used to also try wrapper field 20, on the grounds that g2-kit and faceclaw said 22
  // while MentraOS said 20 and a wrong field is silent. Reading the generated FileDescriptorProto
  // settles it: field 20 is `MenuStartEv` (MenuStartUpEvent), field 22 is `ImuCtrl`. So the
  // field-20 arm was not an alternative hypothesis — it was sending a malformed menu-startup
  // event to the firmware and calling the resulting silence evidence. See IMU_CTRL_FIELD.
  {
    const before = samples;
    log(`[imu] enabling via wrapper field ${IMU_CTRL_FIELD} (pace 100)`);
    await tx.sendEvenHub(encodeImuControl({ enable: true, magic: 210, pace: 100 }));
    await new Promise((r) => setTimeout(r, 5000));
    await tx.sendEvenHub(encodeImuControl({ enable: false, magic: 211 }));
    log(`[imu] field ${IMU_CTRL_FIELD}: ${samples - before} sample(s)`);
  }

  off();
  log(`[imu] RESULT samples=${samples} decoded-non-imu=${decoded} raw-frames=${rawFrames}`);
  log("[imu] NOTE the glasses were STATIONARY — this cannot distinguish 'no IMU stream' from");
  log("[imu]      'IMU reports only on motion'. Retest by moving them.");
}

/**
 * Render the border/radius style probe and report what went out.
 *
 * Uses takeoverPage() for the CREATE-vs-REBUILD decision for the same reason every other page
 * does: the firmware ignores a second CREATE silently, so guessing leaves the HUD unchanged with
 * no error anywhere.
 */
async function probeStyles(log: Log): Promise<void> {
  const tx = nativeTransport();
  const held = takeoverPage();
  const bytes = encodeStyleProbePage({ rebuild: held, magic: 233 });
  await tx.sendEvenHub(bytes);
  log(`[styles] sent ${bytes.length}B (${held ? "rebuild" : "create"}) — narrow list + radius sweep`);
}

/** Render the multi-list tile probe — see encodeTileProbePage for what it settles. */
async function probeTiles(log: Log): Promise<void> {
  const tx = nativeTransport();
  const held = takeoverPage();
  const bytes = encodeTileProbePage({ rebuild: held, magic: 234 });
  await tx.sendEvenHub(bytes);
  log(`[tiles] sent ${bytes.length}B (${held ? "rebuild" : "create"}) — 4 decorative lists + 1 capturing`);
}

/** Probe 3: two lists, and whether a list container's own border draws. */
async function probe3(log: Log): Promise<void> {
  const tx = nativeTransport();
  const held = takeoverPage();
  const bytes = encodeProbe3Page({ rebuild: held, magic: 235 });
  await tx.sendEvenHub(bytes);
  log(`[p3] sent ${bytes.length}B (${held ? "rebuild" : "create"}) — 2 lists + list border/radius`);
}

/**
 * Render the RAIL launcher.
 *
 * The widget lines are placeholders for now: the point of this first frame is to confirm the
 * geometry on-glass — that the 3-letter marks fit a 64px tile, the underscores join into a
 * hairline, all six rows are visible, and an 8-container page is accepted.
 */
async function showLauncher(log: Log): Promise<void> {
  const tx = nativeTransport();
  const held = takeoverPage();
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const bytes = encodeLauncherPage({
    marks: ["CLK", "TMR", "NTE", "DEV", "SET", "APP"],
    clock: spaceOut(`${hh}:${mm}`),
    status: spaceOut("BAT 39%"),
    widgets: [
      "NEXT    10:30   Standup",
      "STEPS   8,240   4.1 KM",
      "MSG     Dana - see you at 6",
    ],
    rebuild: held,
    magic: 236,
  });
  await tx.sendEvenHub(bytes);
  log(`[launcher] sent ${bytes.length}B (${held ? "rebuild" : "create"}) — rail + dashboard`);
}

/**
 * THE RASTER PROOF — arbitrary pixels drawn natively, with no LVGL, no resident loader and no
 * flash.
 *
 * The CFW's image channel has a mode the phone had never used: mode 2 inflates a zlib stream
 * straight into the display buffer at 8bpp and presents it. That escapes every EvenHub limit at
 * once — no more single rounded rect, one font and no shapes. The firmware owns and redraws the
 * result; the phone composes it once.
 *
 * The frame deliberately shows things EvenHub CANNOT express: several filled rounded tiles at
 * the same time, an antialiased arc gauge, circles, and a grey ramp proving all 256 levels are
 * live rather than the 16 a 4-bit BMP would give.
 */
/**
 * Frame content. "shape" is the original probe; A and B exist for ONE question.
 *
 * On 2026-08-09 an 886 B BMP and a 1548 B mode-2 stream rendered a byte-identical
 * ring-and-tab glyph that is not the shape either encodes. That compared two ENCODERS of
 * the same picture, so it could not distinguish "our encoders are both wrong" from "the
 * image path never draws caller pixels at all". A and B are the same encoder carrying
 * maximally different content: a fully-lit rectangle and a half-lit one. If the HUD is
 * identical for both, caller pixels are not reaching the glass and no amount of encoder
 * work would help — which is the finding, not a failure.
 *
 * Deliberately NOT all-white vs all-black: an all-black frame is indistinguishable from
 * "nothing rendered", which is the one reading this experiment cannot afford to be
 * ambiguous about. Both frames are bright; they differ in SHAPE.
 */
type RasterVariant = "shape" | "A" | "B";

async function showRaster(
  log: Log,
  how: "mode2" | "bmp" = "mode2",
  w = 200,
  h = 100,
  variant: RasterVariant = "shape"
): Promise<void> {
  const tx = nativeTransport();
  const W = w, H = h;
  const CID = 2, NAME = "ffs-rast";

  // 1. Declare the surface. Its width/height are what the firmware expects the frame to be.
  const held = takeoverPage();
  await tx.sendEvenHub(encodeImagePage({
    x: 188, y: 94, width: W, height: H,
    containerId: CID, containerName: NAME,
    rebuild: held, magic: 240,
  }));
  log(`[raster] container ${W}x${H} declared (${held ? "rebuild" : "create"}) — 700ms settle`);
  // The firmware needs ~700ms after a container create/rebuild before it accepts pixels.
  await new Promise((r) => setTimeout(r, 800));

  // 2. Draw. Everything below is impossible through EvenHub containers.
  const r = new Raster(W, H).clear(0);
  if (variant === "A") {
    // FRAME A — the whole container lit. Nothing the firmware draws on its own is a
    // full-bleed rectangle, so this is distinguishable from the placeholder glyph too.
    r.fillRect(0, 0, W, H, 255);
  } else if (variant === "B") {
    // FRAME B — left half lit, right half dark. Same encoder, same size, same session
    // handling as A; only the pixels differ.
    r.fillRect(0, 0, Math.floor(W / 2), H, 255);
  } else if (W < 120) {
    // TINY VARIANT — one unmistakable shape, small enough to fit a SINGLE fragment. That takes
    // fragmenting and ACK ordering out of the experiment entirely: if anything at all appears,
    // the container, the page and the decode path are all fine and only content is in question,
    // which is a far better place to be than a uniformly black HUD.
    r.fillRoundRect(2, 2, W - 4, H - 4, 8, 200);
    r.disc(W / 2, H / 2, Math.min(W, H) / 4, 0);
  } else {
  // three filled tiles — EvenHub can show exactly one rounded rect, and only as a selection
  for (let i = 0; i < 3; i++) r.fillRoundRect(6 + i * 34, 8, 28, 28, 8, 210);
  // an outlined tile beside them, to show fill and stroke are both available
  r.roundRect(108, 8, 28, 28, 8, 255, 2);
  // an arc gauge — the shape the stock dashboard has and EvenHub has no message for
  r.arc(168, 24, 20, Math.PI * 0.75, Math.PI * 2.25, 255, 3);
  r.disc(168, 24, 4, 255);
  // a hairline that is actually continuous, unlike a row of underscores
  r.line(6, 46, 194, 46, 160);
  // a 256-level ramp: proof this is 8bpp, not the 16 levels a 4-bit BMP allows
  for (let x = 0; x < 188; x++) r.fillRect(6 + x, 54, 1, 10, Math.round((x / 187) * 255));
  // circles at descending brightness
  for (let i = 0; i < 5; i++) r.circle(20 + i * 40, 82, 10, 60 + i * 48, 2);
  }

  // 3. Push it. The BMP variant is the CONTROL: it uses the already-proven decode path and no
  //    compression, so if it renders and mode 2 does not, the fault is isolated to zlib rather
  //    than to the container, the fragmenting or the page — which all look identical from here
  //    (a black HUD).
  const payload = how === "bmp" ? rasterToBmp(r) : r.toMode2(zlibStored);
  const FRAG = 4096;
  const total = payload.length;
  const n = Math.ceil(total / FRAG);

  // ACK-GATE each fragment, exactly as the native driver does: arm BEFORE sending so a fast ACK
  // cannot race us, then send the next only once this one is acknowledged. Firing them blind on
  // a fixed delay gets every fragment ACKed and still renders nothing.
  //
  // A FRESH session id per push, too. Reusing one id across pushes lets the firmware treat a
  // later push as a repeat of a session it has already completed.
  const session = (rasterSession = (rasterSession + 1) & 0xff);
  const acks = new Map<number, (ok: boolean) => void>();
  const off = tx.onInbound((p) => {
    const a = parseImageAck(p);
    if (a && a.session === session) acks.get(a.fragment)?.(a.ok);
  });

  try {
    for (let i = 0; i < n; i++) {
      const chunk = payload.subarray(i * FRAG, Math.min((i + 1) * FRAG, total));
      const acked = new Promise<boolean>((resolve) => {
        acks.set(i, resolve);
        // Never hang the OS on a lost ACK; press on and let the frame fail visibly instead.
        setTimeout(() => resolve(false), 2500);
      });
      await tx.sendEvenHub(encodeImageRawData({
        containerId: CID, containerName: NAME,
        sessionId: session, totalSize: total, fragmentIndex: i,
        data: chunk, magic: (241 + i) & 0xff,
      }));
      const ok = await acked;
      acks.delete(i);
      if (!ok) { log(`[raster] fragment ${i} not acked — aborting`); break; }
    }
  } finally {
    off();
  }
  log(
    `[raster] pushed ${total}B in ${n} ack-gated fragments ` +
      `(${W}x${H}, ${how}, variant ${variant}, session ${session})`,
  );
}
