package expo.modules.ffsble.voice

import java.io.Closeable

// ═══════════════════════════════════════════════════════════════════════════════════════════
// S-VOICE shared contracts.
//
// Everything downstream of the BLE driver talks through the types in this file, so the three
// layers -- decode, archive, transcription -- can be built and tested independently and none of
// them can reach past its own seam.
//
// ⛔ PRIVACY, STRUCTURALLY. Audio (LC3 bytes, PCM, base64 of either) and transcript text NEVER
// enter a log line and NEVER cross the JS bridge. See `G2Central.onAudioPacket`. What may be
// logged is COUNTS and MILLISECONDS. The archive is a file on the phone; the only thing that
// leaves the device is what an explicitly-configured STT provider is sent.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * One parsed 205-byte mic notification.
 *
 * [lc3] aliases the source array (no copy) unless the pipeline needed to own it; treat it as
 * read-only. [ssr] and [tdoa] are preserved all the way into the archive because a sibling
 * stream needs them for own-voice gating and they are per-50 ms metadata worth keeping.
 */
data class VoicePacket(
    /** Backing array holding 200 bytes = five 40-byte LC3 frames at [lc3Offset]. */
    val lc3: ByteArray,
    /** Offset of the LC3 payload inside [lc3]. */
    val lc3Offset: Int,
    /** Speech-presence / SNR proxy, computed on-glass (energy ratio vs a 10-frame mean). */
    val ssr: Int,
    /** 2-mic cross-correlation, raw fixed-point (eighths of a sample). */
    val tdoa: Int,
    /** Mod-256 packet counter from byte 204. */
    val counter: Int,
    /** "L" or "R" -- which lens notified this copy. */
    val side: String,
    /** Phone monotonic clock at receipt, ms. */
    val tMs: Long
) {
    /** [tdoa] in whole samples. */
    val tdoaSamples: Double get() = tdoa / VoiceFormat.TDOA_FRAC_DIVISOR

    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

/**
 * A persistent LC3 decoder. **ONE INSTANCE PER STREAM** -- the decoder carries state across
 * frames and a fresh instance per packet is the second way to produce noise.
 *
 * Backed on-device by liblc3 through JNI (`NativeLc3Decoder`); a deterministic fake stands in
 * for it in plain-JVM unit tests, which is the whole reason this is an interface.
 */
interface Lc3Decoder : Closeable {
    /**
     * Decode ONE 40-byte frame into [out] at [outOff]. Returns liblc3's own result:
     * `0` = decoded, `1` = **PLC ran and the output is valid audio, NOT an error**, `<0` = bad
     * parameters.
     */
    fun decodeFrame(src: ByteArray, off: Int, len: Int, out: ShortArray, outOff: Int): Int

    /**
     * Run packet-loss concealment for one lost frame (`lc3_decode(dec, NULL, 0, ...)`), writing
     * [VoiceFormat.SAMPLES_PER_FRAME] samples to [out]. This is how a gap is filled, and it is
     * why the decoder must be persistent: concealment is generated from the state left by the
     * frames that did arrive.
     */
    fun concealFrame(out: ShortArray, outOff: Int): Int
}

/** What the framer did with the arriving packets -- the numeric, loggable account of a stream. */
data class VoiceFramerStats(
    var received: Int = 0,
    /** Dropped as the other lens's copy of a packet we already have. */
    var duplicates: Int = 0,
    /** Packets not [VoiceFormat.PACKET_BYTES] long. */
    var malformed: Int = 0,
    /** Frames synthesised by PLC to bridge a small gap. */
    var concealed: Int = 0,
    /** Gaps too large to conceal -- the stream was resynced and audio is genuinely missing. */
    var resyncs: Int = 0,
    /** Packets the firmware dropped, as counted from the mod-256 counter. */
    var lostPackets: Int = 0
)

/** One PCM chunk out of the decode thread, with the metadata of the packet that made it. */
data class VoiceAudioChunk(
    /** 16 kHz mono s16 samples. */
    val pcm: ShortArray,
    val samples: Int,
    val ssr: Int,
    val tdoa: Int,
    /** True if any frame in this chunk came from concealment rather than real audio. */
    val concealed: Boolean,
    val tMs: Long
) {
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

// -- Archive -------------------------------------------------------------------------------

/** A recorded stretch of listening. Sessions never expire and are never auto-deleted. */
data class VoiceSession(
    val id: String,
    val startedAtEpochMs: Long,
    var endedAtEpochMs: Long?,
    /** Absolute path of the raw 205-byte master stream (`.g2a`). */
    val masterPath: String,
    var packets: Int = 0,
    var durationMs: Long = 0
)

/** A transcribed span inside a session. */
data class VoiceSegment(
    val id: Long,
    val sessionId: String,
    /** Offset of this span from the start of its session, ms. */
    val startMs: Long,
    val endMs: Long,
    val text: String,
    /** Provider-reported confidence in 0..1, or null if the provider does not report one. */
    val confidence: Double?,
    /** Name of the [SttProvider] that produced [text] -- mock runs stay distinguishable forever. */
    val provider: String,
    val createdAtEpochMs: Long
)

/** A full-text search result. */
data class VoiceSearchHit(
    val segment: VoiceSegment,
    /** Text with matched terms wrapped in `[` `]`, or the plain text if unavailable. */
    val snippet: String,
    val sessionStartedAtEpochMs: Long
)

/**
 * The searchable, permanent side of the archive. Implementations must keep everything: there is
 * no retention policy and no eviction, by explicit decision.
 */
interface TranscriptIndex : Closeable {
    fun upsertSession(session: VoiceSession)
    fun listSessions(limit: Int = 100): List<VoiceSession>
    fun getSession(id: String): VoiceSession?

    /** Returns the assigned segment id. */
    fun addSegment(
        sessionId: String,
        startMs: Long,
        endMs: Long,
        text: String,
        confidence: Double?,
        provider: String
    ): Long

    /** Full-text query. Term-prefix and phrase syntax is implementation-defined. */
    fun search(query: String, limit: Int = 50): List<VoiceSearchHit>
    fun segmentsOf(sessionId: String): List<VoiceSegment>
    fun stats(): Map<String, Long>
}

// -- Speech-to-text ------------------------------------------------------------------------

/**
 * ⛔ **NO PROVIDER IS CHOSEN OR HARDCODED ANYWHERE IN THIS TREE.** This is the seam a provider
 * drops into later. What ships is the interface, a mock for tests, and one generic
 * config-driven HTTP client that most cloud STT REST endpoints fit without new code.
 *
 * Credentials NEVER live in source. Config is read from a JSON file in the app's private
 * storage, written at runtime.
 */
data class SttRequest(
    /** 16 kHz mono s16le PCM, already assembled -- no container. */
    val pcm: ShortArray,
    val sampleRate: Int = VoiceFormat.SAMPLE_RATE,
    val sessionId: String,
    val startMs: Long,
    val endMs: Long
) {
    override fun equals(other: Any?): Boolean = this === other
    override fun hashCode(): Int = System.identityHashCode(this)
}

/** What a provider gives back. [ok] false means "try again later" -- audio is never discarded. */
data class SttResult(
    val ok: Boolean,
    val text: String,
    val confidence: Double?,
    val provider: String,
    /** Loggable failure reason. ⛔ Must never contain transcript text or audio. */
    val error: String? = null
)

interface SttProvider {
    /** Stable identifier recorded on every segment, so mock output is never mistaken for real. */
    val name: String

    /** Synchronous; called from the upload worker thread, never from the decode thread. */
    fun transcribe(request: SttRequest): SttResult

    /** False when the provider has no usable configuration -- the queue then just waits. */
    fun isConfigured(): Boolean
}
