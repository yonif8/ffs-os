package expo.modules.ffsble.voice

/**
 * The provider-agnostic description of "how to turn a clip of PCM into text over HTTP".
 *
 * ⛔ **NO PROVIDER IS CHOSEN HERE, AND NONE MAY EVER BE.** There is no vendor name in this
 * file, no default endpoint, no example host, no `if (provider == ...)`. The user supplies a
 * provider and its credentials at runtime; this type is the shape of that answer.
 *
 * WHY A CONFIG OBJECT RATHER THAN AN INTERFACE PER PROVIDER
 * --------------------------------------------------------
 * `[mapped]` Surveying what cloud STT REST endpoints actually require, essentially all of them
 * reduce to the same seven decisions:
 *
 *   1. WHERE   -- a URL and an HTTP method.
 *   2. WHO     -- one or more request headers carrying an API key or bearer token.
 *   3. WHAT    -- the audio, either as the raw request body or as one field of a multipart
 *                 form, in some container (`wav`) or as bare samples (`raw-pcm`).
 *   4. HOW     -- declared sample rate / channels / language / model, which the provider wants
 *                 either as query parameters or as JSON body fields. We keep them as an opaque
 *                 `Map<String,String>` because the KEY NAMES are the provider-specific part and
 *                 belong in config, never in code.
 *   5. ANSWER  -- where in the response JSON the transcript sits, as a dotted/indexed path.
 *   6. LIMITS  -- max clip length and request timeout.
 *   7. RETRY   -- attempts and backoff.
 *
 * Anything that does not fit those seven needs a new [SttProvider] implementation, not a patch
 * to this class. That is a deliberate boundary: [HttpSttProvider] must stay dumb.
 *
 * ⛔ **[headers] HOLDS CREDENTIALS.** [toString] redacts every header VALUE, and so does
 * [redactedSummary]. Nothing in this tree may print a header value; `SttConfigRedactionTest`
 * enforces it. The same applies to [queryParams] and [extraParams] -- a provider that wants
 * its key as `?key=...` is common enough that they are redacted too.
 */
data class SttConfig(
    /**
     * `"none"` (default, and the state the app ships in), `"mock"`, or `"http"`.
     *
     * `"none"` is not an error state: it means "archive the audio, transcribe later". The
     * queue accumulates and drains the day a provider appears. See [SttQueue].
     */
    val providerKind: String = KIND_NONE,

    /** Human label for the settings UI. Purely cosmetic; never used to select behaviour. */
    val displayName: String = "",

    // -- 1. WHERE --------------------------------------------------------------------------

    /** Full endpoint URL. Empty means "not configured" for [KIND_HTTP]. */
    val endpointUrl: String = "",

    /** HTTP method. `POST` for every batch STT endpoint seen so far; configurable anyway. */
    val method: String = "POST",

    // -- 2. WHO ----------------------------------------------------------------------------

    /**
     * Request headers, verbatim. This is where an API key lives -- `Authorization: Bearer ...`,
     * `x-api-key: ...`, `Ocp-Apim-Subscription-Key: ...`, whatever the provider wants.
     *
     * ⛔ REDACTED in every rendering of this object.
     */
    val headers: Map<String, String> = emptyMap(),

    /** Query parameters appended to [endpointUrl]. ⛔ Also redacted -- keys ride here too. */
    val queryParams: Map<String, String> = emptyMap(),

    // -- 3. WHAT ---------------------------------------------------------------------------

    /** [AUDIO_WAV] or [AUDIO_RAW_PCM]. The enum is deliberately open -- see [audioEncoding]. */
    val audioEncoding: String = AUDIO_WAV,

    /**
     * `"body"` -- the audio IS the request body, with [audioContentType] as `Content-Type`.
     * `"multipart"` -- the audio is one part of a `multipart/form-data` body, named
     * [multipartFieldName], alongside [extraParams] as text parts.
     */
    val audioCarrier: String = CARRIER_BODY,

    /** Form field name when [audioCarrier] is [CARRIER_MULTIPART]. */
    val multipartFieldName: String = "file",

    /** Filename declared for the multipart part. Some endpoints sniff the extension. */
    val multipartFileName: String = "clip.wav",

    /**
     * `Content-Type` for the audio bytes. Empty picks a sane value from [audioEncoding]
     * (`audio/wav` / `application/octet-stream`), which keeps a minimal config short without
     * hardcoding anything provider-shaped.
     */
    val audioContentType: String = "",

    // -- 4. HOW ----------------------------------------------------------------------------

    /**
     * Declared audio parameters and model selection, expressed generically. Typical contents:
     * `{"sample_rate":"16000","channels":"1","language":"en-US","model":"..."}`.
     *
     * WHERE they go is [paramsIn]: query string, multipart text parts, or a JSON body. The
     * key NAMES are the provider's vocabulary and therefore config, not code.
     *
     * ⛔ Redacted when rendered -- a provider may want its key here.
     */
    val extraParams: Map<String, String> = emptyMap(),

    /** [PARAMS_IN_QUERY], [PARAMS_IN_MULTIPART] or [PARAMS_IN_JSON_BODY]. */
    val paramsIn: String = PARAMS_IN_QUERY,

    /**
     * Only for [PARAMS_IN_JSON_BODY]: the JSON field the base64 audio is written to. Endpoints
     * that take a JSON envelope invariably want the audio base64'd inside it.
     */
    val jsonAudioField: String = "audio",

    // -- 5. ANSWER -------------------------------------------------------------------------

    /**
     * Dotted/indexed path into the response JSON for the transcript text, resolved by
     * [MiniJson.path] -- e.g. `results.0.alternatives.0.transcript`, or just `text`.
     *
     * ⚠️ A wrong path is indistinguishable from an empty transcript, so [HttpSttProvider]
     * reports "response path missed" as a FAILURE (retryable) rather than as empty text. Audio
     * is never discarded on a miss.
     */
    val textPath: String = "text",

    /** Optional path to a 0..1 confidence. Null/miss simply yields a null confidence. */
    val confidencePath: String = "",

    /**
     * Optional path to a provider-side error message, used to make a failure legible when the
     * HTTP status is 200 but the body carries an error. ⛔ The value is copied into
     * [SttResult.error] -- ONLY set this to a path that holds a diagnostic, never a transcript.
     */
    val errorPath: String = "",

    // -- 6. LIMITS -------------------------------------------------------------------------

    /**
     * Longest clip that may be sent in one request. The queue does not split a longer item --
     * it fails it as `clip-too-long` and LEAVES IT PENDING, because silently sending half of
     * somebody's sentence is worse than waiting for a config that fits.
     */
    val maxClipSeconds: Int = 60,

    /** Connect timeout, ms. */
    val connectTimeoutMs: Int = 15_000,

    /** Read timeout, ms. Generous: batch STT of a minute of audio can take a while. */
    val readTimeoutMs: Int = 60_000,

    // -- 7. RETRY --------------------------------------------------------------------------

    /** Attempts per queue drain pass, including the first. */
    val retryAttempts: Int = 3,

    /** First backoff step, ms. Doubles per attempt up to [retryMaxBackoffMs]. */
    val retryBackoffMs: Long = 2_000,

    /** Ceiling on the doubling. */
    val retryMaxBackoffMs: Long = 300_000,

    // -- 8. LIVE STREAMING (word-by-word on the face) ---------------------------------------
    //
    // The batch fields above are the DURABLE path: a clip is written to disk, uploaded, and
    // the transcript stored forever. It is correct and it is slow -- a clip cannot be sent
    // until it ends, so the words land a sentence at a time.
    //
    // These fields describe a SECOND, DISPOSABLE path: a websocket held open for the whole
    // session, fed PCM as it decodes, answering with partial transcripts that get better as
    // more audio arrives. Nothing here is archived; if the socket dies, the batch path still
    // has every word. That split is deliberate -- the locked rule is never silently drop a
    // word, and a best-effort socket can never be the thing that keeps them.
    //
    // Provider-agnostic on purpose: the defaults happen to fit Deepgram's live endpoint, but
    // every URL, parameter and JSON path is config, exactly as the batch half is.

    /** `wss://...` endpoint. EMPTY DISABLES live streaming; the batch path is unaffected. */
    val streamUrl: String = "",

    /** Query parameters appended to [streamUrl]. Sample rate/encoding go here. */
    val streamParams: Map<String, String> = emptyMap(),

    /** Dotted path to the transcript text inside one socket message. */
    val streamTextPath: String = "channel.alternatives.0.transcript",

    /**
     * Dotted path to the boolean saying "this text is settled, later messages will not revise
     * it". Text arriving with it false REPLACES the pending tail; with it true, the tail is
     * committed and a new one starts.
     */
    val streamFinalPath: String = "is_final",

    /** Sent as a text frame at end of session, if non-empty, before the close handshake. */
    val streamCloseMessage: String = "{\"type\":\"CloseStream\"}",

    /** Milliseconds of audio per socket send. Smaller = lower latency, more BLE-independent radio. */
    val streamChunkMs: Int = 100,

    /** Reconnect backoff, ms. Doubles to [streamReconnectMaxMs]. */
    val streamReconnectMs: Long = 1_000,

    /** Ceiling on the reconnect doubling. */
    val streamReconnectMaxMs: Long = 30_000
) {

    /** Live streaming is configured and may be attempted. */
    val streamingEnabled: Boolean get() = streamUrl.isNotBlank()


    companion object {
        const val KIND_NONE = "none"
        const val KIND_MOCK = "mock"
        const val KIND_HTTP = "http"

        /**
         * Audio encodings. `wav` and `raw-pcm` are IMPLEMENTED. The set is intentionally left
         * open (a plain String, not a Kotlin enum) so a future `flac`/`opus`/`ogg` is a new
         * branch in the encoder rather than a breaking change to every persisted config file
         * -- an unknown value fails loudly at request-build time instead of failing to parse.
         */
        const val AUDIO_WAV = "wav"
        const val AUDIO_RAW_PCM = "raw-pcm"

        const val CARRIER_BODY = "body"
        const val CARRIER_MULTIPART = "multipart"

        const val PARAMS_IN_QUERY = "query"
        const val PARAMS_IN_MULTIPART = "multipart"
        const val PARAMS_IN_JSON_BODY = "json-body"

        /** The config an unconfigured phone has: keep the audio, transcribe nothing. */
        val NONE = SttConfig()

        /**
         * A ready-made mock config. Used by tests and by the "prove the pipeline works before
         * you pay anybody" path in the settings UI.
         */
        val MOCK = SttConfig(providerKind = KIND_MOCK, displayName = "Mock (offline, for tests)")

        /** Parse from the JSON written by [toJson]. Unknown keys are ignored. */
        fun fromJson(text: String): SttConfig {
            val m = MiniJson.parseOrNull(text) as? Map<*, *> ?: return NONE
            return SttConfig(
                providerKind = MiniJson.str(m, "providerKind", KIND_NONE),
                displayName = MiniJson.str(m, "displayName", ""),
                endpointUrl = MiniJson.str(m, "endpointUrl", ""),
                method = MiniJson.str(m, "method", "POST"),
                headers = MiniJson.strMap(m, "headers"),
                queryParams = MiniJson.strMap(m, "queryParams"),
                audioEncoding = MiniJson.str(m, "audioEncoding", AUDIO_WAV),
                audioCarrier = MiniJson.str(m, "audioCarrier", CARRIER_BODY),
                multipartFieldName = MiniJson.str(m, "multipartFieldName", "file"),
                multipartFileName = MiniJson.str(m, "multipartFileName", "clip.wav"),
                audioContentType = MiniJson.str(m, "audioContentType", ""),
                extraParams = MiniJson.strMap(m, "extraParams"),
                paramsIn = MiniJson.str(m, "paramsIn", PARAMS_IN_QUERY),
                jsonAudioField = MiniJson.str(m, "jsonAudioField", "audio"),
                textPath = MiniJson.str(m, "textPath", "text"),
                confidencePath = MiniJson.str(m, "confidencePath", ""),
                errorPath = MiniJson.str(m, "errorPath", ""),
                maxClipSeconds = MiniJson.int(m, "maxClipSeconds", 60),
                connectTimeoutMs = MiniJson.int(m, "connectTimeoutMs", 15_000),
                readTimeoutMs = MiniJson.int(m, "readTimeoutMs", 60_000),
                retryAttempts = MiniJson.int(m, "retryAttempts", 3),
                retryBackoffMs = MiniJson.long(m, "retryBackoffMs", 2_000),
                retryMaxBackoffMs = MiniJson.long(m, "retryMaxBackoffMs", 300_000),
                streamUrl = MiniJson.str(m, "streamUrl", ""),
                streamParams = MiniJson.strMap(m, "streamParams"),
                streamTextPath = MiniJson.str(m, "streamTextPath", "channel.alternatives.0.transcript"),
                streamFinalPath = MiniJson.str(m, "streamFinalPath", "is_final"),
                streamCloseMessage = MiniJson.str(m, "streamCloseMessage", "{\"type\":\"CloseStream\"}"),
                streamChunkMs = MiniJson.int(m, "streamChunkMs", 100),
                streamReconnectMs = MiniJson.long(m, "streamReconnectMs", 1_000),
                streamReconnectMaxMs = MiniJson.long(m, "streamReconnectMaxMs", 30_000)
            )
        }
    }

    /**
     * Serialise, INCLUDING credentials -- this is what [SttConfigStore] writes to private
     * storage. ⛔ Never send the output of this anywhere but that file. To show a config to a
     * human or a log, use [redactedSummary].
     */
    fun toJson(): String = MiniJson.write(
        linkedMapOf<String, Any?>(
            "providerKind" to providerKind,
            "displayName" to displayName,
            "endpointUrl" to endpointUrl,
            "method" to method,
            "headers" to headers,
            "queryParams" to queryParams,
            "audioEncoding" to audioEncoding,
            "audioCarrier" to audioCarrier,
            "multipartFieldName" to multipartFieldName,
            "multipartFileName" to multipartFileName,
            "audioContentType" to audioContentType,
            "extraParams" to extraParams,
            "paramsIn" to paramsIn,
            "jsonAudioField" to jsonAudioField,
            "textPath" to textPath,
            "confidencePath" to confidencePath,
            "errorPath" to errorPath,
            "maxClipSeconds" to maxClipSeconds,
            "connectTimeoutMs" to connectTimeoutMs,
            "readTimeoutMs" to readTimeoutMs,
            "retryAttempts" to retryAttempts,
            "retryBackoffMs" to retryBackoffMs,
            "retryMaxBackoffMs" to retryMaxBackoffMs,
            "streamUrl" to streamUrl,
            "streamParams" to streamParams,
            "streamTextPath" to streamTextPath,
            "streamFinalPath" to streamFinalPath,
            "streamCloseMessage" to streamCloseMessage,
            "streamChunkMs" to streamChunkMs,
            "streamReconnectMs" to streamReconnectMs,
            "streamReconnectMaxMs" to streamReconnectMaxMs
        )
    )

    /**
     * Everything about this config that is safe to print: kinds, counts and the endpoint's
     * HOST (not its path or query, which can carry a key).
     *
     * ⛔ This is the ONLY sanctioned rendering. [toString] delegates here so that an accidental
     * `Log.d(TAG, "$cfg")` cannot leak a bearer token -- the leak-by-default direction of a
     * Kotlin data class is exactly the trap that put 3,281 base64 audio frames in the driver
     * log once already (see `G2MicStats`).
     */
    fun redactedSummary(): String {
        val host = try {
            if (endpointUrl.isBlank()) "" else java.net.URI(endpointUrl).host ?: "?"
        } catch (_: Throwable) { "?" }
        return "SttConfig(kind=$providerKind, host=${if (host.isBlank()) "-" else host}, " +
            "method=$method, enc=$audioEncoding, carrier=$audioCarrier, paramsIn=$paramsIn, " +
            "headers=${headers.size} REDACTED, query=${queryParams.size} REDACTED, " +
            "params=${extraParams.size} REDACTED, textPath=$textPath, " +
            "maxClipS=$maxClipSeconds, attempts=$retryAttempts)"
    }

    override fun toString(): String = redactedSummary()

    /**
     * Is there enough here to actually transcribe? `none` never is; `mock` always is; `http`
     * needs at least a URL and a place to read the answer from.
     */
    fun isUsable(): Boolean = when (providerKind) {
        KIND_MOCK -> true
        KIND_HTTP -> endpointUrl.isNotBlank() && textPath.isNotBlank()
        else -> false
    }

    /**
     * Human-readable list of what is missing, for the settings screen. Never includes a value,
     * only a field name -- a validator that echoes what you typed is a credential leak.
     */
    fun validationProblems(): List<String> {
        if (providerKind == KIND_NONE || providerKind == KIND_MOCK) return emptyList()
        if (providerKind != KIND_HTTP) return listOf("providerKind: unknown kind")
        val out = ArrayList<String>()
        if (endpointUrl.isBlank()) out.add("endpointUrl: required")
        else if (!endpointUrl.startsWith("http://") && !endpointUrl.startsWith("https://"))
            out.add("endpointUrl: must be http(s)")
        if (textPath.isBlank()) out.add("textPath: required")
        if (audioEncoding != AUDIO_WAV && audioEncoding != AUDIO_RAW_PCM)
            out.add("audioEncoding: only '$AUDIO_WAV' and '$AUDIO_RAW_PCM' are implemented")
        if (audioCarrier != CARRIER_BODY && audioCarrier != CARRIER_MULTIPART)
            out.add("audioCarrier: must be '$CARRIER_BODY' or '$CARRIER_MULTIPART'")
        if (maxClipSeconds <= 0) out.add("maxClipSeconds: must be positive")
        if (retryAttempts <= 0) out.add("retryAttempts: must be at least 1")
        return out
    }

    /** Effective audio `Content-Type`, filling in a default from [audioEncoding]. */
    fun effectiveAudioContentType(): String = when {
        audioContentType.isNotBlank() -> audioContentType
        audioEncoding == AUDIO_WAV -> "audio/wav"
        else -> "application/octet-stream"
    }
}
