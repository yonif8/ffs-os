// The piezo buzzer — the G2's only output that isn't the lens.
//
// ⚠️ THE IMPORTANT THING TO KNOW FIRST: this needs NO CFW payload and no resident loader. The
// flashed CFW already interprets image-channel messages beginning with byte 5 as buzzer commands
// (`[5][kind][args…]`, zlib_glue.c image_dispatch), so sounding the piezo is three bytes over a
// channel that already works. A whole payload probe was written for this before that path was
// found — and the loader turned out to be wedged that night, so the payload route would not have
// worked at all. If a capability looks like it needs custom code on the glasses, check whether
// the CFW already exposes it.
//
// Proven on-glass 2026-08-08: Yoni heard it.

/** Buzzer command kinds, as the CFW's image_dispatch decodes them. */
const Kind = {
  PRESET: 0,
  NOTE: 1,
  STOP: 2,
  RAW: 3,
  SEQUENCE: 4,
} as const;

/** Image-channel message type for "this is a sound, not pixels". */
const SOUND_MODE = 5;

/**
 * One of the firmware's own canned UI sounds, 0..8.
 *
 * These are what the firmware plays for its own notifications, so they are short and
 * self-terminating. Values above 8 are dropped by the CFW rather than passed to the driver.
 */
export function encodePreset(preset: number): Uint8Array {
  return Uint8Array.from([SOUND_MODE, Kind.PRESET, Math.max(0, Math.min(8, Math.round(preset)))]);
}

/**
 * A musical note: `note` 1..7, `octave` 0..3, `beat` in units of ~62 ms.
 *
 * The ranges are not stylistic. The driver computes its PWM period as
 * `1000000 / (0xffff - table[idx])`, and note 1..7 x octave 0..3 is exactly what keeps the
 * table index inside [0,27] — outside it the divisor can reach zero. The CFW enforces this too;
 * clamping here means a caller gets a sound rather than silent rejection.
 */
export function encodeNote(note: number, octave: number, beat: number): Uint8Array {
  return Uint8Array.from([
    SOUND_MODE,
    Kind.NOTE,
    Math.max(1, Math.min(7, Math.round(note))),
    Math.max(0, Math.min(3, Math.round(octave))),
    Math.max(1, Math.min(255, Math.round(beat))),
  ]);
}

/**
 * A raw tone: `freq` 1..20000 Hz, `duty` 0..100 %, `ms` duration.
 *
 * ⛔⛔ `ms` IS NOT HONOURED ON 2.2.7.14 — THIS TONE DOES NOT STOP BY ITSELF. ⛔⛔
 *
 * Observed on-glass 2026-08-08: a raw tone played INDEFINITELY and only stopped when an
 * explicit STOP was sent. The cause is visible in the CFW source:
 *
 *     FW_BUZZ_RAW(freq, duty);                       // starts the PWM
 *     uint32_t h = *(volatile uint32_t *)BUZZ_TIMER_ADDR;
 *     if (h) FW_TIMER_START(h, ms);                  // ONLY this ever stops it
 *
 * `BUZZ_TIMER_ADDR` is G2FW_BUZZ_TIMER_HANDLE_PTR, which is [M] in g2fw.h — mapped, never
 * verified on this build. If it reads 0, the guard skips the timer, the duration is silently
 * discarded, and the piezo is left driven forever. There is no error and no telemetry; the
 * only symptom is a sound that will not stop, next to someone's head, at 4am.
 *
 * So: NEVER send this and trust `ms`. Use `playTone()` on the host, which arms its OWN
 * phone-side stop, or use a preset/note (both self-terminate in the driver). This encoder stays
 * exported because the experiment that eventually PROVES the firmware timer must be able to
 * call it — and because pretending the primitive does not exist would not make it safer.
 */
export function encodeRawTone(freq: number, duty: number, ms: number): Uint8Array {
  const f = Math.max(1, Math.min(20000, Math.round(freq)));
  const d = Math.max(0, Math.min(100, Math.round(duty)));
  const m = Math.max(1, Math.min(65535, Math.round(ms)));
  return Uint8Array.from([
    SOUND_MODE, Kind.RAW,
    f & 0xff, (f >> 8) & 0xff,
    d,
    m & 0xff, (m >> 8) & 0xff,
  ]);
}

/** Silence immediately, including cancelling a running sequence. */
export function encodeStop(): Uint8Array {
  return Uint8Array.from([SOUND_MODE, Kind.STOP]);
}

export interface ToneStep {
  freq: number;
  duty: number;
  ms: number;
}

/**
 * A sequence of tones played by the CFW's own timer, so the phone sends ONE message for a
 * melody instead of one per note and nothing depends on BLE timing between steps.
 *
 * Any new sound supersedes a running sequence — the CFW stops its sequencer before starting
 * anything else, so a stale melody cannot keep reprogramming the PWM underneath a new tone.
 */
export function encodeSequence(steps: readonly ToneStep[]): Uint8Array {
  const n = Math.min(steps.length, 255);
  const out = [SOUND_MODE, Kind.SEQUENCE, n];
  for (let i = 0; i < n; i++) {
    const f = Math.max(1, Math.min(20000, Math.round(steps[i].freq)));
    const d = Math.max(0, Math.min(100, Math.round(steps[i].duty)));
    const m = Math.max(1, Math.min(65535, Math.round(steps[i].ms)));
    out.push(f & 0xff, (f >> 8) & 0xff, d, m & 0xff, (m >> 8) & 0xff);
  }
  return Uint8Array.from(out);
}

/**
 * The sound the OS uses when a timer finishes: a PRESET, deliberately.
 *
 * Not a raw tone and not a sequence. Presets run entirely inside the firmware's driver and
 * self-terminate, so no phone-side stop has to arrive for the sound to end — which is exactly
 * the property the raw-tone path turned out not to have. The OS should never depend on a
 * terminator crossing a BLE link that can drop.
 */
export const OS_DONE_PRESET = 1;

/**
 * Play a raw tone SAFELY: send it, then send STOP from the phone after `ms`.
 *
 * This exists because the firmware's own stop-timer does not fire on 2.2.7.14 (see
 * `encodeRawTone`), so the only reliable terminator is one we control. `send` is whatever
 * ships bytes to the image channel; `delay` is injected so tests need no real clock.
 *
 * The stop is sent even if the caller never awaits, and a margin is added so a slow link
 * cannot make the tone outlast its own terminator by much.
 */
export async function playToneSafely(
  send: (bytes: Uint8Array) => Promise<void> | void,
  tone: { freq: number; duty: number; ms: number },
  delay: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  // Cap the duration: an unbounded value here becomes an unbounded sound if the stop is lost.
  const ms = Math.max(1, Math.min(3000, Math.round(tone.ms)));
  await send(encodeRawTone(tone.freq, tone.duty, ms));
  try {
    await delay(ms + 120);
  } finally {
    // finally, so an abort or a throw mid-wait still silences the piezo.
    await send(encodeStop());
  }
}
