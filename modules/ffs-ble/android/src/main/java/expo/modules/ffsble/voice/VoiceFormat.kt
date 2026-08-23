package expo.modules.ffsble.voice

/**
 * The S-VOICE wire format — the 205-byte microphone packet the glasses notify on the ESS
 * audio characteristic (`G2Central.AUDIO_NOTIFY`, `…0E8AC72E6402`).
 *
 * ```
 *   205 bytes
 *     [0  ..199]  FIVE 40-byte LC3 frames — 16 kHz mono, 10 ms each -> 50 ms of audio
 *     [200..201]  ssr   int16 LE — speech-presence / SNR proxy, computed ON-GLASS
 *     [202..203]  tdoa  int16 LE — 2-mic cross-correlation, 3 fractional bits
 *     [204]       counter u8     — mod-256, wraps; the ONLY loss signal we get
 * ```
 *
 * ⛔ **THE 200 BYTES ARE NOT ONE LC3 FRAME.** They are five, decoded through ONE persistent
 * decoder instance whose state carries across frames. Handing all 200 to a decoder as a single
 * frame produces WHITE NOISE — that is the exact failure signature, and it has cost other
 * implementations days.
 *
 * There is no G2 header, no CRC, no service id and no in-band sequence number on this pipe: it is
 * a raw notify. `enc_len` is a firmware variable, so [LC3_BYTES] is asserted per packet rather
 * than assumed — a packet whose length is not [PACKET_BYTES] is not a mic packet.
 *
 * ⚠️ The firmware **silently drops** frames when its tx queue is half full. Gaps are NORMAL and
 * expected, not a bug in this code. [VoiceFramer] turns them into PLC frames or a resync.
 *
 * ⚠️ **BOTH lenses notify** the same audio. Left and right carry the same counter for the same
 * 50 ms, so a `gap == 0` is a duplicate to be dropped, not a stall.
 */
object VoiceFormat {
    /** Total notification size. Anything else is not a mic packet. */
    const val PACKET_BYTES = 205

    /** Bytes of LC3 payload at the head of a packet. Asserted, never assumed. */
    const val LC3_BYTES = 200

    /** One LC3 frame at 32 kbps / 10 ms. */
    const val FRAME_BYTES = 40

    /** Five frames ride in one notification. */
    const val FRAMES_PER_PACKET = 5

    /** Mic sample rate. */
    const val SAMPLE_RATE = 16000

    /** LC3 frame duration in microseconds — the `dt_us` liblc3 is set up with. */
    const val FRAME_US = 10000

    /** PCM samples in one 10 ms frame. */
    const val SAMPLES_PER_FRAME = 160

    /** PCM samples one packet decodes to (5 x 160). */
    const val SAMPLES_PER_PACKET = FRAMES_PER_PACKET * SAMPLES_PER_FRAME

    /** Milliseconds of audio one packet carries. */
    const val PACKET_MS = 50

    /** Byte offset of the `ssr` int16 LE. */
    const val OFF_SSR = 200

    /** Byte offset of the `tdoa` int16 LE. */
    const val OFF_TDOA = 202

    /** Byte offset of the wrapping 8-bit packet counter. */
    const val OFF_COUNTER = 204

    /**
     * `tdoa` is a fixed-point sample offset with three fractional bits, so the raw int16 is
     * eighths of a sample. Divide by this to get samples; multiply by 1e6/[SAMPLE_RATE] for µs.
     */
    const val TDOA_FRAC_DIVISOR = 8.0

    /** ~20 packets/s. */
    const val PACKETS_PER_SEC = 1000 / PACKET_MS
}
