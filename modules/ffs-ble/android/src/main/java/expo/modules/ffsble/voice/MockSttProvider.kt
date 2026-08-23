package expo.modules.ffsble.voice

/**
 * The deterministic fake transcriber. This is the piece that makes "speak a sentence, find it
 * by searching for it" provable **with no cloud account, no key and no network**.
 *
 * WHY A MOCK IS LOAD-BEARING, NOT A CONVENIENCE
 * ---------------------------------------------
 * The definition of done for this half of S-VOICE is a search hit, and a search hit needs
 * text. If text can only come from a paid endpoint the user has not chosen yet, the whole
 * archive layer -- queue durability, backlog drain, FTS indexing, snippet rendering -- would
 * sit unproven until a provider arrives. With this class the pipeline is exercised end to end
 * today and the real provider is a config change, not an integration.
 *
 * HOW IT DECIDES WHAT WAS "SAID"
 * ------------------------------
 * Two layers, in order:
 *
 *   1. **Sidecar mapping.** A `Map<String,String>` keyed by [pcmKey] -- a stable FNV-1a hash of
 *      the sample bytes. A test does `provider.teach(pcm, "the quick brown fox ...")` and any
 *      later request carrying that same PCM transcribes to that sentence. This is what lets a
 *      test assert on REAL WORDS: the search query is a phrase from the middle of a sentence
 *      the test itself chose, so a passing search proves indexing, tokenising, matching and
 *      snippeting, not just that a row landed.
 *   2. **Synthetic fallback.** Unmapped audio yields a stable pseudo-sentence derived from the
 *      clip's duration and RMS energy, e.g. `mock clip 1200ms energy 4210 tokens alpha bravo`.
 *      Deterministic: same PCM in, same words out, forever. Never random -- a flaky corpus
 *      makes a flaky search test, and a flaky search test gets deleted.
 *
 * ⛔ [name] is `"mock"`, recorded on every segment it produces, so mock text is distinguishable
 * from real text in the archive **forever**. Nothing merges the two. If a real provider is
 * configured later, old mock segments stay labelled `mock` and can be filtered out; they are
 * not deleted, because nothing in this feature deletes anything.
 *
 * PRIVACY: this provider is the only one that never sends a byte off the phone.
 */
class MockSttProvider(
    /**
     * Pre-seeded sidecar. Keys are [pcmKey] values; use [teach] for the ergonomic form.
     * Copied defensively so a caller's map cannot mutate under the worker thread.
     */
    seed: Map<String, String> = emptyMap(),
    /** Reported confidence. Constant on purpose -- a fake confidence must look fake. */
    private val confidence: Double? = 0.99
) : SttProvider {

    companion object {
        /** The value written to [VoiceSegment.provider] for everything this class produces. */
        const val NAME = "mock"

        /**
         * Word pool for the synthetic fallback. NATO alphabet: obviously synthetic, no
         * possible resemblance to anything a person said, and safe to commit to a public repo.
         */
        private val WORDS = arrayOf(
            "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
            "india", "juliett", "kilo", "lima", "mike", "november", "oscar", "papa"
        )

        /**
         * FNV-1a over the little-endian sample bytes. Chosen over `ShortArray.contentHashCode`
         * because it is specified and stable across JVM versions -- the sidecar key has to
         * mean the same thing in a test today and on the phone tomorrow.
         */
        @JvmStatic
        fun pcmKey(pcm: ShortArray, count: Int = pcm.size): String {
            var h = 0x811C9DC5L
            for (i in 0 until count) {
                val s = pcm[i].toInt()
                h = ((h xor (s and 0xFF).toLong()) * 16777619L) and 0xFFFFFFFFL
                h = ((h xor ((s ushr 8) and 0xFF).toLong()) * 16777619L) and 0xFFFFFFFFL
            }
            return java.lang.Long.toHexString(h or 0x100000000L).substring(1)
        }
    }

    override val name: String = NAME

    private val sidecar = java.util.concurrent.ConcurrentHashMap<String, String>(seed)

    /** True always: the mock needs no configuration, which is precisely its value. */
    override fun isConfigured(): Boolean = true

    /**
     * Teach the mock that this exact PCM means this exact sentence. Returns the [pcmKey] so a
     * test can assert the mapping was keyed as expected.
     */
    fun teach(pcm: ShortArray, text: String): String {
        val k = pcmKey(pcm)
        sidecar[k] = text
        return k
    }

    /** Teach by pre-computed key, for a sidecar loaded from a fixture file. */
    fun teachKey(key: String, text: String) { sidecar[key] = text }

    /** How many sentences the mock has been taught. Counts only -- safe to log. */
    fun taughtCount(): Int = sidecar.size

    override fun transcribe(request: SttRequest): SttResult {
        val n = request.pcm.size
        if (n == 0) {
            // Not a failure worth retrying forever: an empty clip has no text and never will.
            // Reported ok=false so the queue's retry logic sees it, but with a stable reason.
            return SttResult(false, "", null, NAME, error = "empty-clip")
        }
        val key = pcmKey(request.pcm, n)
        val text = sidecar[key] ?: synthesise(request, key)
        return SttResult(true, text, confidence, NAME)
    }

    /**
     * Build a stable pseudo-sentence from measurable properties of the clip. Deliberately
     * self-describing so that if one of these ever shows up in a search result during real use
     * it is instantly recognisable as machine-made rather than as something anybody said.
     */
    private fun synthesise(request: SttRequest, key: String): String {
        val n = request.pcm.size
        val durationMs = (n.toLong() * 1000L) / maxOf(1, request.sampleRate)
        var sumSq = 0.0
        for (i in 0 until n) {
            val v = request.pcm[i].toDouble()
            sumSq += v * v
        }
        val rms = Math.sqrt(sumSq / n).toLong()
        // Four words picked by the hash: stable, and enough variety that two different clips
        // do not collide into identical text in a search test.
        val h = key.toLong(16)
        val sb = StringBuilder("mock clip ").append(durationMs).append("ms energy ")
            .append(rms).append(" tokens")
        for (i in 0 until 4) {
            sb.append(' ').append(WORDS[(((h ushr (i * 4)) and 0x0F).toInt())])
        }
        return sb.toString()
    }
}
