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
    else void runtime.boot();
  });
  return () => {
    sub.remove();
    runtime.stop();
  };
}
