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
import { describeEvent, normalizeEvent } from "../sdk/events";
import { hex } from "../sdk/proto";
import {
  encodeImuControl,
  encodeProbe3Page,
  encodeStyleProbePage,
  encodeTileProbePage,
} from "../sdk/wire";
import { encodeLauncherPage, spaceOut } from "../sdk/launcher";

type Log = (message: string) => void;

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
  const sub = FfsBle.addListener("onOsCommand", ({ cmd }) => {
    if (cmd === "stop") runtime.stop();
    else if (cmd === "imu") void probeImu(log);
    else if (cmd === "styles") void probeStyles(log);
    else if (cmd === "tiles") void probeTiles(log);
    else if (cmd === "p3") void probe3(log);
    else if (cmd === "launcher") void showLauncher(log);
    else void runtime.boot();
  });
  return () => {
    sub.remove();
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

  // The wrapper field is the one real disagreement between sources: g2-kit's GENERATED schema and
  // faceclaw both say 22, MentraOS's notes say 20. Try both rather than argue — a wrong field
  // number is silent, because protobuf ignores fields it does not know.
  for (const field of [22, 20]) {
    const before = samples;
    log(`[imu] enabling via wrapper field ${field} (pace 100)`);
    await tx.sendEvenHub(encodeImuControl({ enable: true, magic: 210, pace: 100, field }));
    await new Promise((r) => setTimeout(r, 5000));
    await tx.sendEvenHub(encodeImuControl({ enable: false, magic: 211, field }));
    log(`[imu] field ${field}: ${samples - before} sample(s)`);
    await new Promise((r) => setTimeout(r, 500));
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
