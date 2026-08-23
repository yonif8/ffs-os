package expo.modules.ffsble.voice

import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WORD-BY-WORD TRANSCRIPTION -- a websocket held open for the whole capture, fed PCM as it
 * decodes, answering with partial transcripts that improve as more audio arrives.
 *
 * == WHY THIS EXISTS ALONGSIDE [SttQueue], NOT INSTEAD OF IT ==============================
 * The batch queue cannot be fast and it is not supposed to be: a clip is not uploadable until
 * it ENDS, so its words land a sentence at a time, one round trip after the speaker stops.
 * That is the right shape for the archive -- durable across app kills, retried forever, never
 * dropping a word -- and the wrong shape for a face you are looking through while talking.
 *
 * So this class is deliberately the OPPOSITE trade: nothing here is persisted, nothing is
 * retried past a reconnect, and if the socket never opens the capture is unaffected. Every
 * word still reaches the permanent index by the durable path. The split is the locked
 * "never silently drop a word" rule -- a best-effort socket may never be what keeps them.
 *
 * == WHY OkHttp, AFTER [HttpSttProvider] SPECIFICALLY AVOIDED IT ==========================
 * HttpURLConnection has no websocket. The alternatives were a hand-rolled RFC-6455 client
 * over SSLSocket (~250 lines of masking, fragmentation and ping/pong, all of it ours to get
 * wrong) or OkHttp, which React Native already puts on this app's runtime classpath (4.9.2,
 * via com.facebook.react). We take OkHttp compileOnly -- no APK weight added -- and treat its
 * ABSENCE as a normal outcome: [available] catches the missing class and the capture proceeds
 * batch-only with one log line. That is the concrete answer to the version-drift worry in
 * HttpSttProvider's header: drift degrades the disposable path, never the durable one.
 *
 * == PRIVACY =============================================================================
 * COUNTS ONLY in logs. Never a transcript, never a sample, never the URL (it can carry the
 * key in a query string). Callbacks get the text; nothing else does.
 */
class LiveSttStream(
    private val cfg: SttConfig,
    /** A better guess at the tail. Replaces whatever the last interim said. */
    private val onInterim: (String) -> Unit,
    /** Settled text. Append it and start a new tail. */
    private val onFinal: (String) -> Unit,
    /** COUNTS ONLY. */
    private val log: ((String) -> Unit)? = null
) {
    companion object {
        /** True if OkHttp's websocket client is actually on the classpath at runtime. */
        val available: Boolean by lazy {
            try {
                Class.forName("okhttp3.WebSocket"); true
            } catch (t: Throwable) {
                false
            }
        }
    }

    private val lock = Object()
    private val running = AtomicBoolean(false)
    private var socket: okhttp3.WebSocket? = null
    private var client: okhttp3.OkHttpClient? = null
    private var pending = ByteArrayOutputStream()
    private var chunkBytes = 3200
    private var backoffMs = 1_000L
    private var opened = 0L
    private var sentBytes = 0L
    private var messages = 0L
    private var reconnects = 0L

    /** Set while a connect is in flight, so audio is buffered rather than thrown away. */
    @Volatile private var connecting = false

    fun stats(): String =
        "live-stt: opened=$opened reconnects=$reconnects sent=${sentBytes / 1024}KB msgs=$messages"

    /**
     * Open the socket. Safe to call when streaming is not configured or OkHttp is missing --
     * it logs once and returns false, and the caller carries on with the durable path.
     */
    fun start(): Boolean {
        if (!cfg.streamingEnabled) return false
        if (!available) {
            log?.invoke("live-stt: OkHttp websocket not on the classpath -- batch path only")
            return false
        }
        if (!running.compareAndSet(false, true)) return true
        chunkBytes = (cfg.streamChunkMs.coerceIn(20, 1000) * VoiceFormat.SAMPLE_RATE / 1000) * 2
        backoffMs = cfg.streamReconnectMs.coerceAtLeast(100L)
        connect()
        return true
    }

    /** Feed decoded audio. Cheap and non-blocking: buffers, and sends whole chunks only. */
    fun feed(pcm: ShortArray, samples: Int) {
        if (!running.get()) return
        val n = minOf(samples, pcm.size)
        if (n <= 0) return
        val out = ArrayList<ByteArray>(2)
        synchronized(lock) {
            // s16 little-endian, which is what every live STT endpoint calls `linear16`.
            for (i in 0 until n) {
                val v = pcm[i].toInt()
                pending.write(v and 0xFF)
                pending.write((v shr 8) and 0xFF)
            }
            // A dead socket must not grow this without bound: while reconnecting we keep at
            // most ~2 s of audio and drop the OLDEST, because the newest words are the ones
            // still worth showing. The archive keeps all of it regardless.
            val cap = chunkBytes * 20
            if (pending.size() > cap) {
                val all = pending.toByteArray()
                val keep = all.copyOfRange(all.size - cap, all.size)
                pending = ByteArrayOutputStream().apply { write(keep) }
            }
            while (pending.size() >= chunkBytes && socket != null) {
                val all = pending.toByteArray()
                out.add(all.copyOfRange(0, chunkBytes))
                pending = ByteArrayOutputStream().apply { write(all, chunkBytes, all.size - chunkBytes) }
            }
        }
        for (b in out) {
            val s = socket ?: break
            try {
                if (s.send(okio.ByteString.of(*b))) sentBytes += b.size
            } catch (t: Throwable) {
                log?.invoke("live-stt: send failed (${t.javaClass.simpleName})")
                break
            }
        }
    }

    /** Close politely: the provider flushes its last words before the socket goes away. */
    fun stop() {
        if (!running.compareAndSet(true, false)) return
        val s = synchronized(lock) { val x = socket; socket = null; x }
        try {
            if (s != null && cfg.streamCloseMessage.isNotBlank()) s.send(cfg.streamCloseMessage)
            s?.close(1000, "done")
        } catch (t: Throwable) {
            log?.invoke("live-stt: close threw (${t.javaClass.simpleName})")
        }
        try { client?.dispatcher?.executorService?.shutdown() } catch (_: Throwable) {}
        client = null
        log?.invoke(stats())
    }

    // -- socket ---------------------------------------------------------------------------

    internal fun url(): String {
        val sb = StringBuilder(cfg.streamUrl)
        var first = !cfg.streamUrl.contains('?')
        for ((k, v) in cfg.streamParams) {
            sb.append(if (first) '?' else '&').append(URLEncoder.encode(k, "UTF-8"))
                .append('=').append(URLEncoder.encode(v, "UTF-8"))
            first = false
        }
        return sb.toString()
    }

    private fun connect() {
        if (!running.get() || connecting) return
        connecting = true
        val c = client ?: okhttp3.OkHttpClient.Builder()
            .connectTimeout(cfg.connectTimeoutMs.toLong(), java.util.concurrent.TimeUnit.MILLISECONDS)
            // NOT the batch read timeout: a live socket is idle whenever nobody is talking,
            // and a read timeout would tear it down mid-silence.
            .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
            .pingInterval(15, java.util.concurrent.TimeUnit.SECONDS)
            .build().also { client = it }

        val req = okhttp3.Request.Builder().url(url()).apply {
            for ((k, v) in cfg.headers) addHeader(k, v)
        }.build()

        c.newWebSocket(req, object : okhttp3.WebSocketListener() {
            override fun onOpen(webSocket: okhttp3.WebSocket, response: okhttp3.Response) {
                synchronized(lock) { socket = webSocket }
                connecting = false
                opened++
                backoffMs = cfg.streamReconnectMs.coerceAtLeast(100L)
                log?.invoke("live-stt: socket open (#$opened)")
            }

            override fun onMessage(webSocket: okhttp3.WebSocket, text: String) {
                messages++
                handle(text)
            }

            override fun onMessage(webSocket: okhttp3.WebSocket, bytes: okio.ByteString) {
                messages++
                handle(bytes.utf8())
            }

            override fun onFailure(webSocket: okhttp3.WebSocket, t: Throwable, response: okhttp3.Response?) {
                synchronized(lock) { socket = null }
                connecting = false
                // Status code only. A response body can echo the request, key included.
                log?.invoke("live-stt: socket failed (${t.javaClass.simpleName}, http=${response?.code ?: 0})")
                scheduleReconnect()
            }

            override fun onClosed(webSocket: okhttp3.WebSocket, code: Int, reason: String) {
                synchronized(lock) { socket = null }
                connecting = false
                if (running.get()) {
                    log?.invoke("live-stt: socket closed ($code) -- reconnecting")
                    scheduleReconnect()
                }
            }
        })
    }

    private fun scheduleReconnect() {
        if (!running.get()) return
        val wait = backoffMs
        backoffMs = minOf(backoffMs * 2, cfg.streamReconnectMaxMs.coerceAtLeast(wait))
        reconnects++
        Thread({
            try { Thread.sleep(wait) } catch (_: InterruptedException) { return@Thread }
            connect()
        }, "live-stt-reconnect").apply { isDaemon = true }.start()
    }

    /**
     * One socket message -> at most one callback. Empty transcripts are common (the provider
     * saying "still listening") and are dropped rather than pushed as a blank line.
     */
    internal fun handle(json: String) {
        val root = MiniJson.parseOrNull(json) ?: return
        val text = MiniJson.pathString(root, cfg.streamTextPath)?.trim() ?: return
        if (text.isEmpty()) return
        val fin = when (val v = MiniJson.path(root, cfg.streamFinalPath)) {
            is Boolean -> v
            is String -> v == "true"
            is Number -> v.toInt() != 0
            else -> false
        }
        try {
            if (fin) onFinal(text) else onInterim(text)
        } catch (t: Throwable) {
            log?.invoke("live-stt: sink threw (${t.javaClass.simpleName})")
        }
    }
}
