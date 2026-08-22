// FFS Glasses OS — native-push acknowledgement ORCHESTRATION (FUT-237), the PURE half.
//
// This is the retry/poll/ack state machine that used to live inline in App.tsx as five
// bare useRefs plus four closures scattered across the component body. It drives a native
// FXP1 payload push to loader ACKNOWLEDGEMENT: guard on the resident OTA loader, park a
// push until the loader is proven, send it, then poll device-info until the loader either
// attributes the exact frame (accepted), rejects it (failed), or the tries run out
// (unconfirmed). The pure `verifyPushAck`/`loaderRecordFromVersions` helpers already lived
// in `pushAck.ts`; this is the imperative loop around them.
//
// WHY A PLAIN CONTROLLER WITH INJECTED EFFECTS (mirrors src/data/pump.ts): every side effect
// — `pushPayload`, `requestDeviceInfo`, `schedule` (setTimeout), `setStatus`, `log` — is
// injected, so the whole machine runs on a PC with no phone and no glasses, and every branch
// ("loader absent", "link dropped mid-ack", "poll timed out", "wrong frame") is an ordinary
// test. ⚠️ This file imports NOTHING from react / react-native / the native module, so
// `bun test` can load it directly (the React binding lives in usePushAck.ts).
//
// ⛔ BEHAVIOUR IS FROZEN. This was lifted verbatim out of App.tsx — same retry counts
// (4 ack tries, 3 loader-check reads), same poll delays (2500 ms after a send, 1200 ms
// between ack polls), same status strings, same telemetry events. Do not "improve" the
// timing here without a deliberate decision; App used to depend on these exact numbers.

import { base64ByteLength, loaderMarkerPresent, loaderRecordFromVersions, verifyPushAck, type LoaderRecord } from "./pushAck";

/** The two firmware-version strings a device-info readback carries (one per lens). */
export type DeviceVersions = {
  leftVersion?: string | null;
  rightVersion?: string | null;
};

/** Everything the machine touches the outside world through — all injected for testability. */
export interface PushAckDeps {
  /** Push the base64 FXP1 payload frame to the glasses (FfsBle.pushPayloadViaImage). */
  pushPayload: (b64: string) => void;
  /** Ask the glasses for a fresh device-info readback (FfsBle.requestDeviceInfo). */
  requestDeviceInfo: () => void;
  /** Surface the human push-status line (the Dashboard's OTA-loader verdict). */
  setStatus: (msg: string) => void;
  /** Schedule a delayed callback. Mirrors setTimeout; injected so tests drive time. */
  schedule: (fn: () => void, ms: number) => void;
  /** Structured telemetry under cat "os" (glog.emit("os", event, data)). */
  log: (event: string, data: Record<string, unknown>) => void;
}

type AckState = {
  token: number;
  label: string;
  frameLen: number;
  baseline: Pick<LoaderRecord, "gen" | "ran"> | null;
  tries: number;
  pollScheduled: boolean;
};

/**
 * The push-ack loop as a plain, pure-logic object (no React). Feed it the device-info
 * readbacks and link-drop notifications the app already receives; it drives the loader
 * handshake through the injected deps. One instance lives for the life of a session.
 */
export class PushAckController {
  // FUT-237 fix: the guard demanded positive proof of the loader, but device-info starts
  // empty, so the first tap only fired the read and the user had to tap AGAIN. We park the
  // push here and fire it automatically the moment the readback lands.
  private pendingPush: { label: string; event: string; b64: string } | null = null;
  private ack: AckState | null = null;
  private token = 0;
  // Loader presence cannot vanish without a reflash, so LATCH it: once a CFW marker (the ⟨CAPS⟩
  // EVENCFW advertisement, or a ⟨LOADER⟩ receipt) is seen in any readback it stays seen (a
  // marker-less event no longer sends us down the "no loader" path and makes the user tap
  // repeatedly).
  private loaderSeenFlag = false;
  private readTries = 0;

  constructor(private readonly deps: PushAckDeps) {}

  /** True once a CFW marker has ever been seen (latched; can't un-see without reflash). */
  get loaderSeen(): boolean {
    return this.loaderSeenFlag;
  }

  /**
   * Is the resident OTA loader present? The latch OR a live CFW marker in the current readback —
   * the ⟨CAPS⟩ EVENCFW advertisement (present on a freshly flashed image before any push) or a
   * ⟨LOADER⟩ receipt. See `loaderMarkerPresent` for the full rationale and stock-safety argument.
   * Pushing a payload with no loader is DESTRUCTIVE (the stock decoder parses our Thumb-2 as a
   * bitmap → blank lens → watchdog reboot), so this gates every push and the data-plane frames.
   */
  loaderPresent(di: DeviceVersions | null | undefined): boolean {
    if (this.loaderSeenFlag) return true;
    return loaderMarkerPresent(di?.leftVersion, di?.rightVersion);
  }

  /**
   * The push entry point. If the loader is already proven, send now; otherwise park the push
   * and fire a device-info read so the readback path can send it automatically (ONE tap).
   */
  guardedPush(
    label: string,
    event: string,
    b64: string,
    di: DeviceVersions | null | undefined,
    pairReady: boolean,
  ): void {
    if (!pairReady) return;
    if (this.ack || this.pendingPush) {
      this.deps.setStatus("⛔ PUSH BLOCKED — another payload is still awaiting loader attribution");
      return;
    }
    const baseline = loaderRecordFromVersions(di?.leftVersion, di?.rightVersion);
    if (this.loaderPresent(di) && baseline) {
      this.loaderSeenFlag = true;
      this.deps.log(event, {});
      this.sendAwaitingAck(label, b64, baseline);
      return;
    }
    // Not proven yet — park the push and let the readback fire it. ONE tap.
    this.pendingPush = { label, event, b64 };
    this.readTries = 0;
    this.deps.setStatus("⏳ checking the glasses for the OTA loader… this push will go automatically.");
    this.deps.requestDeviceInfo();
  }

  /**
   * A device-info readback arrived. Advance any in-flight ack (accept / fail / poll again),
   * then, if a push is parked and the loader is now proven, send it. Call after the app's own
   * device-info telemetry — this consumes only the push-ack-relevant fields.
   */
  onDeviceInfo(
    leftVersion: string | null | undefined,
    rightVersion: string | null | undefined,
  ): void {
    const loaderRecord = loaderRecordFromVersions(leftVersion, rightVersion);
    if (loaderMarkerPresent(leftVersion, rightVersion)) {
      this.loaderSeenFlag = true;
    }
    const ack = this.ack;
    if (ack) {
      const verdict = verifyPushAck(ack.baseline, loaderRecord, ack.frameLen);
      if (verdict.state === "accepted") {
        this.ack = null;
        this.deps.setStatus(`✅ loader ran ${ack.label} (gen ${verdict.record.gen}, ${ack.frameLen} B attributed)`);
        this.deps.log("push_acked", { label: ack.label, frameLen: ack.frameLen, gen: verdict.record.gen });
      } else if (verdict.state === "failed") {
        this.ack = null;
        this.deps.setStatus(`⛔ PUSH FAILED — ${ack.label}: ${verdict.reason}`);
        this.deps.log("push_failed", { label: ack.label, reason: verdict.reason });
      } else if (!ack.pollScheduled) {
        ack.tries += 1;
        if (ack.tries >= 4) {
          this.ack = null;
          this.deps.setStatus(`⛔ PUSH UNCONFIRMED — ${ack.label}: ${verdict.reason}`);
          this.deps.log("push_unconfirmed", { label: ack.label, reason: verdict.reason });
        } else {
          const token = ack.token;
          ack.pollScheduled = true;
          this.deps.schedule(() => {
            const current = this.ack;
            if (current?.token === token) {
              current.pollScheduled = false;
              this.deps.requestDeviceInfo();
            }
          }, 1200);
        }
      }
    }
    const p = this.pendingPush;
    if (!p) return;
    if (this.loaderSeenFlag && loaderRecord) {
      this.pendingPush = null;
      this.deps.log(p.event, {});
      this.sendAwaitingAck(p.label, p.b64, loaderRecord);
      return;
    }
    // Marker-less readback. Some events legitimately lack it, so try a few times before
    // concluding the loader really is absent.
    this.readTries += 1;
    if (this.readTries >= 3) {
      this.pendingPush = null;
      this.deps.setStatus(
        "⛔ BLOCKED — no OTA loader on the glasses (stock firmware). Pushing would crash a lens. Flash g2_2.2.6.10_loader.bin first.",
      );
      this.deps.log("push_blocked", { label: p.label, reason: "no_loader" });
    } else {
      this.deps.requestDeviceInfo();
    }
  }

  /**
   * The pair link dropped. Any in-flight ack can never be attributed now, so fail it loudly,
   * and clear a parked push. (App also drops its cfwSeen latch — that stays in App.)
   */
  onLinkDropped(): void {
    const ack = this.ack;
    if (ack) {
      this.ack = null;
      this.deps.setStatus(`⛔ PUSH FAILED — ${ack.label}: glasses link dropped before loader acknowledgement`);
      this.deps.log("push_failed", { label: ack.label, reason: "link_dropped_before_ack" });
    }
    this.pendingPush = null;
  }

  private sendAwaitingAck(label: string, b64: string, baseline: LoaderRecord | null): void {
    let frameLen: number;
    try {
      frameLen = base64ByteLength(b64);
    } catch (e) {
      this.deps.setStatus(`⛔ PUSH BLOCKED — ${label}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const token = ++this.token;
    this.ack = { token, label, frameLen, baseline, tries: 0, pollScheduled: true };
    this.deps.setStatus(`⏳ sent ${label}; waiting for attributed loader execution…`);
    this.deps.pushPayload(b64);
    this.deps.schedule(() => {
      if (this.ack?.token === token) {
        this.ack.pollScheduled = false;
        this.deps.requestDeviceInfo();
      }
    }, 2500);
  }
}
