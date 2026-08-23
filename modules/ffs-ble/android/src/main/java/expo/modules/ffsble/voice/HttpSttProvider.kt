package expo.modules.ffsble.voice

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * ONE generic, config-driven HTTP client that most cloud STT REST endpoints fit **without a
 * line of new code**.
 *
 * ⛔ **NO PROVIDER IS NAMED, DEFAULTED OR BRANCHED ON ANYWHERE IN THIS FILE.** Everything
 * provider-shaped -- the URL, the auth header, the parameter names, the response path -- comes
 * from [SttConfig], which comes from a JSON file the user writes at runtime. If you find
 * yourself adding `if (host == ...)` here, the right move is a new [SttProvider], not a
 * special case.
 *
 * WHY `HttpURLConnection` AND NOT OkHttp/Retrofit
 * -----------------------------------------------
 * This module has zero runtime dependencies today and that is worth keeping: every dependency
 * added to a native Expo module is a dependency the app ships and a version to reconcile at
 * every RN upgrade. `HttpURLConnection` is on every Android and every desktop JVM, which also
 * means this class is testable against a `com.sun.net.httpserver.HttpServer` on localhost --
 * which is exactly how it is proven (`SttHttpProviderTest`) without choosing a vendor.
 *
 * WHAT A REQUEST LOOKS LIKE
 * -------------------------
 * ```
 *   <method> <endpointUrl>?<queryParams>[&<extraParams if paramsIn=query>]
 *   <headers ...>                       <- credentials live here
 *   body:  carrier=body       -> the encoded audio, Content-Type = effectiveAudioContentType()
 *          carrier=multipart  -> multipart/form-data: audio as <multipartFieldName>,
 *                                extraParams as text parts (if paramsIn=multipart)
 *          paramsIn=json-body -> application/json: extraParams as fields plus base64 audio
 *                                at <jsonAudioField>
 * ```
 *
 * ⛔ **ERROR HYGIENE.** [SttResult.error] is a loggable string, so it may contain a status
 * code, a phase name and an exception class -- and NOTHING else. Never the response body
 * (which holds the transcript), never a header (which holds the key), never a byte of audio,
 * never the full URL (a key can ride in the query string). `SttHttpProviderTest` asserts this
 * on a 500 whose body is a distinctive string.
 *
 * ⚠️ **WAV FRAMING IS DUPLICATED HERE ON PURPOSE.** A sibling stream owns `WavWriter.kt` for
 * the on-disk archive. This class writes its own minimal 44-byte header inline rather than
 * depend on that file, so the two streams do not serialise on each other. `[hypothesis]` the
 * two are byte-identical for 16 kHz mono s16le; once both have landed, delete [wavHeader] here
 * and call the shared writer. Tracked in `docs/S-VOICE-STT-PROVIDER.md`.
 */
class HttpSttProvider(
    /** Read afresh per request so a config change takes effect without restarting the queue. */
    private val configProvider: () -> SttConfig,
    /** Counts-only log sink. ⛔ Never receives a body, a header or audio. */
    private val log: ((String) -> Unit)? = null
) : SttProvider {

    companion object {
        const val NAME = "http"

        /** Cap on the response we will read. A runaway body must not OOM the phone. */
        private const val MAX_RESPONSE_BYTES = 4 * 1024 * 1024

        /** Fixed multipart boundary. Contains no user data, so it cannot leak anything. */
        private const val BOUNDARY = "----ffsvoiceboundary7d41b2c9"

        /**
         * Minimal 44-byte canonical WAV (RIFF/WAVE, PCM fmt chunk) header for s16le mono.
         * See the class KDoc for why this is not `WavWriter`.
         */
        @JvmStatic
        fun wavHeader(sampleRate: Int, channels: Int, dataBytes: Int): ByteArray {
            val byteRate = sampleRate * channels * 2
            val h = ByteArray(44)
            fun ascii(off: Int, s: String) { for (i in s.indices) h[off + i] = s[i].code.toByte() }
            fun le32(off: Int, v: Int) {
                h[off] = (v and 0xFF).toByte()
                h[off + 1] = ((v ushr 8) and 0xFF).toByte()
                h[off + 2] = ((v ushr 16) and 0xFF).toByte()
                h[off + 3] = ((v ushr 24) and 0xFF).toByte()
            }
            fun le16(off: Int, v: Int) {
                h[off] = (v and 0xFF).toByte()
                h[off + 1] = ((v ushr 8) and 0xFF).toByte()
            }
            ascii(0, "RIFF"); le32(4, 36 + dataBytes); ascii(8, "WAVE")
            ascii(12, "fmt "); le32(16, 16); le16(20, 1)     // 1 = PCM, uncompressed
            le16(22, channels); le32(24, sampleRate); le32(28, byteRate)
            le16(32, channels * 2); le16(34, 16)             // block align, bits per sample
            ascii(36, "data"); le32(40, dataBytes)
            return h
        }

        private val B64 =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray()

        /**
         * Standard base64, no line wrapping. Hand-rolled because `android.util.Base64` is a
         * throwing stub under plain-JVM unit tests and `java.util.Base64` is API 26+, while
         * this module still targets older devices. Twenty lines beats either constraint.
         */
        @JvmStatic
        fun base64(data: ByteArray): String {
            val sb = StringBuilder(((data.size + 2) / 3) * 4)
            var i = 0
            while (i + 2 < data.size) {
                val n = ((data[i].toInt() and 0xFF) shl 16) or
                        ((data[i + 1].toInt() and 0xFF) shl 8) or
                        (data[i + 2].toInt() and 0xFF)
                sb.append(B64[(n ushr 18) and 63]).append(B64[(n ushr 12) and 63])
                    .append(B64[(n ushr 6) and 63]).append(B64[n and 63])
                i += 3
            }
            when (data.size - i) {
                1 -> {
                    val n = (data[i].toInt() and 0xFF) shl 16
                    sb.append(B64[(n ushr 18) and 63]).append(B64[(n ushr 12) and 63])
                        .append("==")
                }
                2 -> {
                    val n = ((data[i].toInt() and 0xFF) shl 16) or
                            ((data[i + 1].toInt() and 0xFF) shl 8)
                    sb.append(B64[(n ushr 18) and 63]).append(B64[(n ushr 12) and 63])
                        .append(B64[(n ushr 6) and 63]).append('=')
                }
            }
            return sb.toString()
        }

        /** s16 samples -> little-endian bytes. */
        @JvmStatic
        fun pcmToLeBytes(pcm: ShortArray): ByteArray {
            val out = ByteArray(pcm.size * 2)
            for (i in pcm.indices) {
                val v = pcm[i].toInt()
                out[i * 2] = (v and 0xFF).toByte()
                out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
            }
            return out
        }
    }

    override val name: String = NAME

    override fun isConfigured(): Boolean {
        val c = configProvider()
        return c.providerKind == SttConfig.KIND_HTTP && c.isUsable()
    }

    override fun transcribe(request: SttRequest): SttResult {
        val cfg = configProvider()
        if (cfg.providerKind != SttConfig.KIND_HTTP) return fail("not-configured")
        val problems = cfg.validationProblems()
        if (problems.isNotEmpty()) return fail("config-invalid:${problems.first()}")

        val clipSeconds = request.pcm.size.toDouble() / maxOf(1, request.sampleRate)
        if (clipSeconds > cfg.maxClipSeconds) {
            // ⛔ We do NOT truncate. Sending half a sentence produces a wrong transcript that
            // then looks authoritative in search forever. Fail, stay pending, keep the audio.
            return fail("clip-too-long:${clipSeconds.toInt()}s>${cfg.maxClipSeconds}s")
        }

        val audio = try {
            encodeAudio(cfg, request)
        } catch (t: Throwable) {
            return fail("encode:${t.javaClass.simpleName}")
        }

        var conn: HttpURLConnection? = null
        try {
            val url = URL(buildUrl(cfg))
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = cfg.method.uppercase()
                connectTimeout = cfg.connectTimeoutMs
                readTimeout = cfg.readTimeoutMs
                doInput = true
                useCaches = false
                instanceFollowRedirects = true
            }
            // ⛔ Credentials go on the wire here and nowhere else. Not logged, not echoed.
            for ((k, v) in cfg.headers) conn.setRequestProperty(k, v)

            val body = buildBody(cfg, audio, conn)
            if (body != null) {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }

            val status = conn.responseCode
            val stream: InputStream? =
                if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { readCapped(it) } ?: ""

            if (status !in 200..299) {
                // ⛔ status only. The error body can echo the audio or the key back at us.
                log?.invoke("stt-http: HTTP $status (${text.length} B body, not logged)")
                return fail("http-$status")
            }
            return parse(cfg, text)
        } catch (t: Throwable) {
            // ⛔ Exception CLASS only -- a message can contain the full URL, and the URL can
            // contain an API key in the query string.
            return fail("io:${t.javaClass.simpleName}")
        } finally {
            try { conn?.disconnect() } catch (_: Throwable) { }
        }
    }

    // -- request construction ----------------------------------------------------------------

    /** [endpointUrl] plus [queryParams], plus [extraParams] when `paramsIn=query`. */
    internal fun buildUrl(cfg: SttConfig): String {
        val params = LinkedHashMap<String, String>()
        params.putAll(cfg.queryParams)
        if (cfg.paramsIn == SttConfig.PARAMS_IN_QUERY) params.putAll(cfg.extraParams)
        if (params.isEmpty()) return cfg.endpointUrl
        val sb = StringBuilder(cfg.endpointUrl)
        sb.append(if (cfg.endpointUrl.contains('?')) '&' else '?')
        var first = true
        for ((k, v) in params) {
            if (!first) sb.append('&')
            first = false
            sb.append(URLEncoder.encode(k, "UTF-8")).append('=')
                .append(URLEncoder.encode(v, "UTF-8"))
        }
        return sb.toString()
    }

    /** PCM -> the bytes the provider wants, per [SttConfig.audioEncoding]. */
    internal fun encodeAudio(cfg: SttConfig, request: SttRequest): ByteArray {
        val pcmBytes = pcmToLeBytes(request.pcm)
        return when (cfg.audioEncoding) {
            SttConfig.AUDIO_RAW_PCM -> pcmBytes
            SttConfig.AUDIO_WAV -> {
                val h = wavHeader(request.sampleRate, 1, pcmBytes.size)
                val out = ByteArray(h.size + pcmBytes.size)
                System.arraycopy(h, 0, out, 0, h.size)
                System.arraycopy(pcmBytes, 0, out, h.size, pcmBytes.size)
                out
            }
            // An unimplemented encoding fails LOUDLY at request time rather than shipping the
            // wrong bytes and getting back plausible-looking garbage.
            else -> throw IllegalArgumentException("unsupported encoding")
        }
    }

    /**
     * Body plus its `Content-Type`. Returns null for a method with no body (e.g. a `GET`
     * endpoint that takes a pre-signed audio URL -- unlikely but not our business to forbid).
     */
    private fun buildBody(
        cfg: SttConfig,
        audio: ByteArray,
        conn: HttpURLConnection
    ): ByteArray? {
        if (cfg.method.equals("GET", true) || cfg.method.equals("HEAD", true)) return null

        // JSON envelope wins if asked for: audio rides base64 inside the document.
        if (cfg.paramsIn == SttConfig.PARAMS_IN_JSON_BODY) {
            val doc = LinkedHashMap<String, Any?>()
            for ((k, v) in cfg.extraParams) doc[k] = v
            doc[cfg.jsonAudioField] = base64(audio)
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            return MiniJson.write(doc).toByteArray(Charsets.UTF_8)
        }

        if (cfg.audioCarrier == SttConfig.CARRIER_MULTIPART) {
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$BOUNDARY")
            val out = ByteArrayOutputStream()
            if (cfg.paramsIn == SttConfig.PARAMS_IN_MULTIPART) {
                for ((k, v) in cfg.extraParams) {
                    out.write(("--$BOUNDARY\r\nContent-Disposition: form-data; name=\"$k\"" +
                        "\r\n\r\n$v\r\n").toByteArray(Charsets.UTF_8))
                }
            }
            out.write(("--$BOUNDARY\r\nContent-Disposition: form-data; " +
                "name=\"${cfg.multipartFieldName}\"; filename=\"${cfg.multipartFileName}\"\r\n" +
                "Content-Type: ${cfg.effectiveAudioContentType()}\r\n\r\n")
                .toByteArray(Charsets.UTF_8))
            out.write(audio)
            out.write("\r\n--$BOUNDARY--\r\n".toByteArray(Charsets.UTF_8))
            return out.toByteArray()
        }

        conn.setRequestProperty("Content-Type", cfg.effectiveAudioContentType())
        return audio
    }

    // -- response handling -------------------------------------------------------------------

    private fun readCapped(stream: InputStream): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var total = 0
        while (true) {
            val n = stream.read(buf)
            if (n <= 0) break
            total += n
            if (total > MAX_RESPONSE_BYTES) break
            out.write(buf, 0, n)
        }
        return out.toString("UTF-8")
    }

    /**
     * Pull the transcript out of the response using [SttConfig.textPath].
     *
     * A path MISS is a failure, not an empty transcript: the two are indistinguishable from
     * here, and treating a misconfigured path as "the user said nothing" would write empty
     * segments into a permanent archive while quietly consuming the queue item.
     */
    internal fun parse(cfg: SttConfig, body: String): SttResult {
        val root = MiniJson.parseOrNull(body) ?: return fail("bad-json")

        if (cfg.errorPath.isNotBlank()) {
            val e = MiniJson.pathString(root, cfg.errorPath)
            if (!e.isNullOrBlank()) {
                // Bounded, and only from a path the user pointed at a diagnostic field.
                return fail("provider-error:${e.take(120)}")
            }
        }

        val text = MiniJson.pathString(root, cfg.textPath) ?: return fail("response-path-miss")
        val conf = if (cfg.confidencePath.isBlank()) null
                   else MiniJson.pathDouble(root, cfg.confidencePath)
        log?.invoke("stt-http: ok (${text.length} chars, not logged)")
        return SttResult(true, text, conf, NAME)
    }

    private fun fail(reason: String) = SttResult(false, "", null, NAME, error = reason)
}
