package expo.modules.ffsble.voice

/**
 * Turns a [SttConfig] into a live [SttProvider]. The one place in the tree that maps a
 * `providerKind` string to an implementation.
 *
 * ⛔ **THERE ARE EXACTLY THREE KINDS AND NONE OF THEM IS A VENDOR.** `none`, `mock`, `http`.
 * A real provider arrives as `http` plus a config file, or -- if it genuinely cannot be
 * expressed as one HTTP request (streaming APIs, SDK-only vendors) -- as a NEW class
 * implementing [SttProvider] and a fourth kind. What must never happen is a vendor name
 * appearing as a constant, a default, or a branch inside [HttpSttProvider].
 *
 * WHY A FACTORY AND NOT `when` AT THE CALL SITE
 * ---------------------------------------------
 * [SttQueue] must be able to notice that the config changed from `none` to something real
 * WITHOUT being restarted -- that is the "backlog drains when a provider appears" requirement.
 * Routing every call through [current] gives it a single point to re-read from, and keeps the
 * mock injectable for tests via [override].
 */
class SttProviderFactory(
    private val store: SttConfigStore,
    /** Counts-only log sink, handed to the providers. */
    private val log: ((String) -> Unit)? = null
) {

    /**
     * Test/diagnostic hook: when non-null this provider is used regardless of config. This is
     * how a test drives the real [SttQueue] with a [MockSttProvider] it can teach sentences to.
     * ⛔ Never set in production code.
     */
    @Volatile
    var override: SttProvider? = null

    /** Cached HTTP client -- stateless, reads config per request, so one instance is enough. */
    private val http: SttProvider by lazy { HttpSttProvider({ store.load() }, log) }

    /** Lazily-made mock. Exposed so a caller can [MockSttProvider.teach] it. */
    val mock: MockSttProvider by lazy { MockSttProvider() }

    /**
     * The provider to use right now, or null when nothing is configured.
     *
     * A null return is a NORMAL, supported state -- "archive but do not transcribe". Callers
     * must treat it as "wait", never as "give up and drop the audio".
     */
    fun current(): SttProvider? {
        override?.let { return it }
        val cfg = store.load()
        return when (cfg.providerKind) {
            SttConfig.KIND_MOCK -> mock
            SttConfig.KIND_HTTP -> if (cfg.isUsable()) http else null
            else -> null
        }
    }

    /**
     * The configuration currently in force. [SttQueue] reads its retry/limit knobs from here
     * rather than holding its own [SttConfigStore], so there is one loader and one cache.
     */
    fun config(): SttConfig = store.load()

    /** True when [current] would return a provider that is ready to be called. */
    fun isConfigured(): Boolean = current()?.isConfigured() == true

    /** Safe-to-log description of the current routing decision. */
    fun describe(): String {
        val p = current()
        return "stt-provider=${p?.name ?: "none"} (${store.describe()})"
    }
}
