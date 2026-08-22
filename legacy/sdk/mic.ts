// The microphone up-stream — packet layer, session state, and the privacy contract.
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// ⛔ THE PRIVACY CONTRACT. READ THIS BEFORE YOU TOUCH ANYTHING BELOW.
// ══════════════════════════════════════════════════════════════════════════════════════════
// This module handles a live recording of the wearer. This repository is PUBLIC, it ships a
// telemetry pipe (`src/os/log.ts` → a loopback collector on the dev box, reached via `adb
// reverse`), and our own tooling tails logcat continuously. The pipe is on-desk now (not the
// internet), but every rule below still holds: a log record still lands on a PC in the room, and
// logcat is still grepped. So there are four rules, and they are structural rather than advisory:
//
//   1. AUDIO NEVER ENTERS A LOG. Not the LC3 bytes, not the decoded PCM, not base64 of either,
//      not a "first 16 bytes for debugging". `glog` already declares `ble:notify` a hot category
//      it intends to sample and ship — so a mic packet that reaches the generic notify path is
//      one config change away from being uploaded. It must never reach it at all.
//      ⚠️ At the time of writing, `G2Central.handleNotificationLocked` base64s EVERY notification
//      (audio characteristic included) into `onNotify`, which `os/calibration/capture.ts`
//      subscribes to. That is the hazard this module exists to fence off; the native guard is in
//      `modules/ffs-ble/.../G2Central.kt` next to the AUDIO_NOTIFY case.
//   2. TRANSCRIPTS NEVER ENTER A LOG EITHER, and neither does message text. A transcript is the
//      recording, just smaller.
//   3. METADATA ONLY. Everything in `MicStats` below is deliberately a COUNT or a DURATION:
//      packets, gaps, milliseconds, whether a session was running. Nothing about content. That is
//      what makes this object safe to log, and it is the only thing that is.
//   4. NO PERSISTENCE. Audio is not written to disk on the phone, and not to the glasses' own
//      flash either (the firmware has a file-dump path — `svc.audio` writing `lc3_data` files —
//      which is a production-test route we must not go near).
//
// A fifth rule that is about the wearer rather than the data: the mic is PUSH-TO-TALK. It opens on
// a deliberate gesture and closes on the end of the utterance or a timeout, never on a wake word
// and never continuously, and the glasses show a listening indicator for the whole time it is open.
// `MAX_SESSION_MS` below is the backstop for the case where every other stop path fails.
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE GLASSES ACTUALLY SEND
// ══════════════════════════════════════════════════════════════════════════════════════════
// ⭐ WHAT ACTUALLY OPENS THE MIC (corrected 2026-08-21, from our own log archive):
// **one `EvenAI CTRL ENTER` on the even_ai service (0x07)** — `G2Central.setMicStream`. NOT
// EvenHub Cmd 15, and NOT `AUDM_appAcquire(5)` from a payload; the latter is `[proven]` to run
// cleanly and do nothing (`ret=0x76100000`). Evidence: 3,281 notifications of the audio
// characteristic, every one 205 bytes and every one side=L, in 18 bursts across four days —
// nine of them starting 0.2–0.5 s after an `aiSwirl: CTRL ENTER` and ending within a second of
// `CTRL EXIT`. In the 22:55:47 burst the first packet is 250 ms after the CTRL and 165 ms
// BEFORE the ASK, so the CTRL is the opener and the ASK is not needed — which matters, because
// the ASK is what would submit a question to Even's cloud.
// ⚠️ Three bursts have no swirl before them at all, so the glasses can also open their own mic
// (the GX8002 wake word, or Even's on-glass voice flow). An idle mic is not a closed one.
//
// Once enabled, the glasses encode PCM → LC3 **on-device** and notify fixed-size packets on the **LEFT** arm's
// render characteristic `00002760-08c2-11e1-9073-0e8ac72e6402` — the same characteristic our image
// pushes use, in the notify-up direction. There is no EvenHub envelope on these: they are raw.
//
//     205 bytes total
//       [0  .. 199]  five 40-byte LC3 frames, 16 kHz mono, 10 ms each  → 50 ms of audio
//       [200..203]   not interpreted by any known implementation
//       [204]        an 8-bit sequence counter, wrapping
//
// ⚠️ BOTH lenses stream — each has its own DMIC — and only the LEFT one is used. faceclaw's
// controller drops the right outright (`if (!"L".equals(arm)) return;`), and mixing the two would
// feed the decoder two interleaved copies of the same speech. `G2Central` tags every packet with
// its side; filter on it before calling `MicSession.accept`.
//
// ≈20 packets/s ≈ 32.8 kbps. The layout is now `[proven]` on OUR hardware
// — 3,281 packets, all exactly 205 bytes, all side=L, zero on side=R — and independently
// `[proven-3p]`: it is what
// `reference/faceclaw/.../FaceclawLc3Decoder.java` + `native/faceclaw_lc3_decoder.c` decode, and
// that app transcribes real speech off real G2 glasses. Our own firmware trace agrees on the
// codec parameters (`svc_audio_pcm_to_lc3_encode` → `SVC_Lc3EncodeMono`, 16 kHz / mono / 10 ms).
// ⛔ AND THE LEAK WAS REAL, NOT HYPOTHETICAL. Every one of those 3,281 packets went through the
// old notification path: base64'd, written to the driver log, emitted to JS, and carried
// off-device by glog. The guard in `G2Central.handleNotificationLocked` is what stops it, and
// `G2Central.micLogStats` is the numeric instrument that replaces those log lines — because the
// reason they existed is that somebody needed to know packets were arriving, and that need does
// not go away when you delete the line.
//
// Decoding needs an LC3 decoder, which is native (Google's liblc3, decoder-only). This module
// deliberately stops at the packet boundary: sequencing, loss accounting, and session lifetime are
// pure logic that can be tested on this box, and they are also the part that decides whether a
// transcript was built from complete audio or from audio with a hole in it.
//
// ── INDEPENDENT CROSS-CHECK (2026-08-21 survey) ─────────────────────────────────────────────
// MentraOS's own driver corroborates the framing from a second, unrelated implementation:
//   • `G2.kt handleAudioData` takes `usableLength = min(data.size, 200)` and hands the decoder a
//     frame size of **40** — i.e. it treats a notification as 5×40 = 200 bytes of LC3 and DISCARDS
//     the trailing 5 (our [200..203] "not interpreted" + [204] seq counter). Same 40-byte frame,
//     same 5-per-packet, arrived at with no shared code.
//   • The men-g2-ble-gateway `constants.py` names the characteristic these ride:
//     `AUDIO_NOTIFY = 00002760-08C2-11E1-9073-0E8AC72E6402` — the LEFT arm's …6402, matching the
//     `AUDIO_NOTIFY` UUID our `G2Central` filters on. (Both MIT; cross-check only, nothing vendored.)
// So the LC3 mic framing is triangulated: our on-glass capture (205 B, all side=L), faceclaw's
// working decoder, and MentraOS's `min(_,200)`/40-byte handler all agree. The 205-vs-200 gap is
// not a contradiction — MentraOS simply drops the 5 trailing bytes we account for explicitly.

/** Sample rate of the G2 mic stream. `[proven-static]` from the firmware's own encoder params. */
export const SAMPLE_RATE = 16000;
/** One LC3 frame is 10 ms. */
export const FRAME_US = 10000;
/** …and 40 bytes at this bitrate. */
export const FRAME_BYTES = 40;
/** Five frames ride in one BLE notification. */
export const FRAMES_PER_PACKET = 5;
/** Byte offset of the wrapping 8-bit sequence counter. */
export const COUNTER_OFFSET = 204;
/** Total notification size. Anything else is not a mic packet. */
export const PACKET_BYTES = 205;
/** PCM samples one packet decodes to (5 × 160). */
export const SAMPLES_PER_PACKET = FRAMES_PER_PACKET * (SAMPLE_RATE / (1_000_000 / FRAME_US));
/** Milliseconds of audio one packet carries. */
export const PACKET_MS = (FRAMES_PER_PACKET * FRAME_US) / 1000;

/**
 * Hard ceiling on one push-to-talk session.
 *
 * Not a UX choice — a safety interlock. If the release gesture is missed, if the app is
 * backgrounded mid-utterance, if the BLE link drops between enable and disable, this is what stops
 * the glasses recording. The firmware's own terminal UI uses a 60 s recording timeout; 30 s is
 * plenty for a reply and halves the worst case.
 */
export const MAX_SESSION_MS = 30_000;

/** Why a mic session ended. All four are safe to log — none of them say anything about content. */
export type MicStopReason =
  /** the wearer let go / confirmed — the normal path */
  | "user"
  /** MAX_SESSION_MS elapsed */
  | "timeout"
  /** the link dropped or the app lost the foreground */
  | "link"
  /** something threw; treat the utterance as lost */
  | "error";

/**
 * Everything we are allowed to know about a session after it ends.
 *
 * Deliberately content-free, so this whole object can go to `glog` as-is. Resist adding a field
 * that is not a count or a duration; the first `text` field here is the day the contract breaks.
 */
export interface MicStats {
  /** packets accepted and passed to the decoder */
  packets: number;
  /** packets whose counter repeated the previous one (BLE re-delivery) */
  duplicates: number;
  /** packets the counter says never arrived — each is 50 ms of missing audio */
  missing: number;
  /** notifications that were not 205 bytes, or were otherwise unusable */
  malformed: number;
  /** wall-clock length of the session */
  elapsedMs: number;
  /** audio actually received, from the packet count — compare against elapsedMs to spot a stall */
  audioMs: number;
  reason: MicStopReason;
}

/** A packet that passed validation. `lc3` is a VIEW into the caller's buffer — do not retain it. */
export interface MicPacket {
  /** the 200 bytes of LC3 payload, five 40-byte frames back to back */
  lc3: Uint8Array;
  /** the wrapping 8-bit sequence counter as sent */
  counter: number;
}

/**
 * Validate one raw notification from the audio characteristic.
 *
 * Returns null rather than throwing: a malformed packet is an ordinary event on a radio link, and
 * a throw here would land on the BLE callback thread.
 */
export function parseMicPacket(data: Uint8Array): MicPacket | null {
  if (data.length !== PACKET_BYTES) return null;
  return {
    lc3: data.subarray(0, FRAME_BYTES * FRAMES_PER_PACKET),
    counter: data[COUNTER_OFFSET]!,
  };
}

/** How the counter moved between two packets. Exported for the test, and because the arithmetic */
/** is the kind that is written wrong once and then trusted forever. */
export function counterGap(previous: number, current: number): number {
  return (current - previous) & 0xff;
}

/**
 * One push-to-talk session: sequencing, loss accounting, and the safety timeout.
 *
 * Owns no I/O. The caller sends the enable command, feeds every notification in, and on stop gets
 * back a `MicStats` it may log. Keeping this pure is what lets the loss accounting be tested
 * without a radio — and loss accounting is not cosmetic: a transcript assembled across a 300 ms
 * hole is a transcript with a word missing, and the wearer should be told rather than shown a
 * confident wrong sentence.
 */
export class MicSession {
  private startedAt: number | null = null;
  private lastCounter = -1;
  private packets = 0;
  private duplicates = 0;
  private missing = 0;
  private malformed = 0;

  /** @param now injectable clock, so the timeout is testable without waiting 30 s. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  get running(): boolean {
    return this.startedAt !== null;
  }

  /** Mark the session open. Call this when the enable command is written, not when it is acked. */
  start(): void {
    this.startedAt = this.now();
    this.lastCounter = -1;
    this.packets = 0;
    this.duplicates = 0;
    this.missing = 0;
    this.malformed = 0;
  }

  /**
   * Offer one raw notification.
   *
   * Returns the packet to decode, or null when there is nothing to decode — a duplicate, a
   * malformed frame, or a packet that arrived while no session was open. That last case matters:
   * the glasses keep streaming until the disable command lands, so a few packets always trail the
   * stop, and they must be dropped rather than appended to the next utterance.
   */
  accept(data: Uint8Array): MicPacket | null {
    if (this.startedAt === null) return null;

    const packet = parseMicPacket(data);
    if (packet === null) {
      this.malformed++;
      return null;
    }

    if (this.lastCounter >= 0) {
      const gap = counterGap(this.lastCounter, packet.counter);
      if (gap === 0) {
        this.duplicates++;
        return null;
      }
      this.missing += gap - 1;
    }

    this.lastCounter = packet.counter;
    this.packets++;
    return packet;
  }

  /** True once the safety ceiling is reached. Poll it, or arm a timer — either way, honour it. */
  get expired(): boolean {
    return this.startedAt !== null && this.now() - this.startedAt >= MAX_SESSION_MS;
  }

  /** Close the session and hand back the (content-free, loggable) stats. */
  stop(reason: MicStopReason): MicStats {
    const startedAt = this.startedAt ?? this.now();
    this.startedAt = null;
    return {
      packets: this.packets,
      duplicates: this.duplicates,
      missing: this.missing,
      malformed: this.malformed,
      elapsedMs: this.now() - startedAt,
      audioMs: this.packets * PACKET_MS,
      reason,
    };
  }
}

/**
 * Did this session capture audio clean enough to trust a transcript from it?
 *
 * The threshold is a judgement, not a measurement: 2 % of 50 ms packets missing is 1 s lost per
 * minute, scattered. Below it, transcribe silently. Above it, the wearer should be shown that the
 * capture was lossy rather than shown a fluent sentence with a word quietly deleted from it.
 */
export function captureIsTrustworthy(stats: MicStats): boolean {
  const total = stats.packets + stats.missing;
  if (total === 0) return false;
  return stats.missing / total <= 0.02 && stats.malformed === 0;
}
