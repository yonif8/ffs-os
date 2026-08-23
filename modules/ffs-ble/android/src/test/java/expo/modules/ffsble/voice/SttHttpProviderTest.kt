package expo.modules.ffsble.voice

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * Proves the generic HTTP client works **without choosing a provider**.
 *
 * The trick that makes that possible: the "provider" here is a loopback socket server this
 * test itself configures. It exercises the same three things a real endpoint would -- receive
 * our audio, read our headers, return JSON in a shape we point a config path at -- and it
 * proves the seam without any vendor being involved, any key existing, or any byte leaving the
 * machine.
 *
 * ⚠️ WHY A HAND-ROLLED SERVER AND NOT `com.sun.net.httpserver`: Android unit tests compile
 * against `android.jar`, which does not carry the JDK's `jdk.httpserver` module, so
 * `HttpServer` does not resolve here. Forty lines of `ServerSocket` beats adding a test
 * dependency to a module that has none. `[proven]` -- this is the compile error that sent us
 * down this road.
 *
 * ⛔ Every URL here is `127.0.0.1`. No real host, real key or real transcript appears anywhere
 * in this file, and this repo is public.
 */
class SttHttpProviderTest {

    private lateinit var server: ServerSocket
    private lateinit var acceptor: Thread
    private var port = 0

    /** What the last request carried, for assertions. */
    private var lastPath: String? = null
    private var lastMethod: String? = null
    private var lastAuth: String? = null
    private var lastContentType: String? = null
    private var lastBody: ByteArray = ByteArray(0)

    /** What the server should answer with. */
    private var status = 200
    private var response = """{"text":"hello from the fake endpoint"}"""

    @Before
    fun setUp() {
        server = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        port = server.localPort
        acceptor = Thread {
            while (!server.isClosed) {
                try {
                    server.accept().use { serve(it) }
                } catch (_: Throwable) {
                    return@Thread // socket closed by tearDown
                }
            }
        }.apply { isDaemon = true; start() }
    }

    @After
    fun tearDown() {
        server.close()
    }

    /** Minimal HTTP/1.1 request reader + fixed responder. Enough for one request per socket. */
    private fun serve(sock: Socket) {
        val ins = sock.getInputStream()
        val requestLine = readLine(ins) ?: return
        val parts = requestLine.split(' ')
        lastMethod = parts.getOrNull(0)
        lastPath = parts.getOrNull(1)
        lastAuth = null
        lastContentType = null
        var contentLength = 0
        while (true) {
            val line = readLine(ins) ?: break
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx <= 0) continue
            val k = line.substring(0, idx).trim()
            val v = line.substring(idx + 1).trim()
            when {
                k.equals("Authorization", true) -> lastAuth = v
                k.equals("Content-Type", true) -> lastContentType = v
                k.equals("Content-Length", true) -> contentLength = v.toIntOrNull() ?: 0
            }
        }
        val body = ByteArray(contentLength)
        var read = 0
        while (read < contentLength) {
            val n = ins.read(body, read, contentLength - read)
            if (n <= 0) break
            read += n
        }
        lastBody = body.copyOf(read)

        val payload = response.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status ${if (status in 200..299) "OK" else "ERR"}\r\n" +
            "Content-Type: application/json\r\n" +
            "Content-Length: ${payload.size}\r\n" +
            "Connection: close\r\n\r\n"
        sock.getOutputStream().apply {
            write(head.toByteArray(Charsets.US_ASCII))
            write(payload)
            flush()
        }
    }

    /** Read one CRLF-terminated line as ASCII. Null at end of stream. */
    private fun readLine(ins: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = ins.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().removeSuffix("\r")
            sb.append(c.toChar())
        }
    }

    private fun baseConfig() = SttConfig(
        providerKind = SttConfig.KIND_HTTP,
        endpointUrl = "http://127.0.0.1:$port/stt",
        headers = mapOf("Authorization" to "Bearer FAKE-LOCAL-TOKEN"),
        extraParams = mapOf("language" to "en-US", "sample_rate" to "16000"),
        textPath = "text"
    )

    private fun provider(cfg: SttConfig) = HttpSttProvider({ cfg })

    private fun pcm(n: Int) = ShortArray(n) { (it % 100 - 50).toShort() }

    private fun request(n: Int = 1600) =
        SttRequest(pcm = pcm(n), sessionId = "s-1", startMs = 0, endMs = 100)

    // -- happy paths ---------------------------------------------------------------------------

    @Test
    fun bodyCarrierSendsWavAndReadsTheConfiguredPath() {
        val r = provider(baseConfig()).transcribe(request())
        assertTrue(r.error ?: "", r.ok)
        assertEquals("hello from the fake endpoint", r.text)
        assertEquals("POST", lastMethod)
        assertEquals("Bearer FAKE-LOCAL-TOKEN", lastAuth)
        assertEquals("audio/wav", lastContentType)
        // 44-byte RIFF header + 1600 samples * 2 bytes.
        assertEquals(44 + 3200, lastBody.size)
        assertEquals("RIFF", String(lastBody, 0, 4))
        assertEquals("WAVE", String(lastBody, 8, 4))
        // extraParams default to the query string.
        assertTrue(lastPath!!.contains("language=en-US"))
        assertTrue(lastPath!!.contains("sample_rate=16000"))
    }

    @Test
    fun rawPcmCarrierSendsBareSamples() {
        val cfg = baseConfig().copy(audioEncoding = SttConfig.AUDIO_RAW_PCM)
        val r = provider(cfg).transcribe(request(800))
        assertTrue(r.ok)
        assertEquals(1600, lastBody.size)
        assertEquals("application/octet-stream", lastContentType)
    }

    @Test
    fun multipartCarrierNamesTheFieldFromConfig() {
        val cfg = baseConfig().copy(
            audioCarrier = SttConfig.CARRIER_MULTIPART,
            paramsIn = SttConfig.PARAMS_IN_MULTIPART,
            multipartFieldName = "audio_file",
            multipartFileName = "clip.wav"
        )
        val r = provider(cfg).transcribe(request(320))
        assertTrue(r.ok)
        assertTrue(lastContentType!!.startsWith("multipart/form-data; boundary="))
        val text = String(lastBody, Charsets.ISO_8859_1)
        assertTrue(text.contains("name=\"audio_file\"; filename=\"clip.wav\""))
        assertTrue(text.contains("name=\"language\""))
    }

    @Test
    fun jsonBodyCarriesBase64AudioAtTheConfiguredField() {
        val cfg = baseConfig().copy(
            paramsIn = SttConfig.PARAMS_IN_JSON_BODY,
            jsonAudioField = "content"
        )
        val r = provider(cfg).transcribe(request(160))
        assertTrue(r.ok)
        assertTrue(lastContentType!!.startsWith("application/json"))
        val doc = MiniJson.parse(String(lastBody, Charsets.UTF_8)) as Map<*, *>
        assertEquals("en-US", doc["language"])
        val b64 = doc["content"] as String
        // 44 + 320 bytes -> ceil(364/3)*4 = 488 chars of base64.
        assertEquals(488, b64.length)
        assertTrue(b64.startsWith("UklGR")) // "RIFF" in base64 -- container survived the trip.
    }

    @Test
    fun nestedResponsePathAndConfidenceAreRead() {
        response = """{"results":[{"alternatives":[{"transcript":"nested ok","c":0.55}]}]}"""
        val cfg = baseConfig().copy(
            textPath = "results.0.alternatives.0.transcript",
            confidencePath = "results.0.alternatives.0.c"
        )
        val r = provider(cfg).transcribe(request(160))
        assertTrue(r.ok)
        assertEquals("nested ok", r.text)
        assertNotNull(r.confidence)
        assertEquals(0.55, r.confidence!!, 1e-9)
    }

    // -- failure paths -------------------------------------------------------------------------

    @Test
    fun serverErrorNeverLeaksTheBodyOrTheHeaders() {
        status = 500
        response = """{"secret":"TRANSCRIPT-THAT-MUST-NOT-BE-LOGGED"}"""
        val r = provider(baseConfig()).transcribe(request(160))
        assertFalse(r.ok)
        assertEquals("http-500", r.error)
        assertEquals("", r.text)
        val err = r.error!!
        assertFalse(err.contains("TRANSCRIPT-THAT-MUST-NOT-BE-LOGGED"))
        assertFalse(err.contains("FAKE-LOCAL-TOKEN"))
        assertFalse(err.contains("127.0.0.1"))
    }

    @Test
    fun wrongResponsePathIsAFailureNotAnEmptyTranscript() {
        response = """{"text":"present"}"""
        val r = provider(baseConfig().copy(textPath = "nope.0.missing")).transcribe(request(160))
        assertFalse(r.ok)
        assertEquals("response-path-miss", r.error)
    }

    @Test
    fun nonJsonResponseFailsCleanly() {
        response = "<html>gateway error</html>"
        val r = provider(baseConfig()).transcribe(request(160))
        assertFalse(r.ok)
        assertEquals("bad-json", r.error)
    }

    @Test
    fun providerReportedErrorInABody200IsSurfaced() {
        response = """{"error":{"message":"quota exceeded"}}"""
        val cfg = baseConfig().copy(errorPath = "error.message")
        val r = provider(cfg).transcribe(request(160))
        assertFalse(r.ok)
        assertEquals("provider-error:quota exceeded", r.error)
    }

    @Test
    fun clipLongerThanTheConfiguredMaximumIsRefusedNotTruncated() {
        val cfg = baseConfig().copy(maxClipSeconds = 1)
        // 5 s at 16 kHz.
        val r = provider(cfg).transcribe(
            SttRequest(pcm = pcm(80_000), sessionId = "s", startMs = 0, endMs = 5000)
        )
        assertFalse(r.ok)
        assertTrue(r.error!!.startsWith("clip-too-long"))
        // Nothing was sent: half a sentence is worse than no sentence.
        assertEquals(0, lastBody.size)
    }

    @Test
    fun unreachableEndpointFailsWithAClassNameOnly() {
        val cfg = baseConfig().copy(endpointUrl = "http://127.0.0.1:1/stt")
        val r = provider(cfg).transcribe(request(160))
        assertFalse(r.ok)
        assertTrue(r.error!!.startsWith("io:"))
        assertFalse(r.error!!.contains("FAKE-LOCAL-TOKEN"))
    }

    @Test
    fun unconfiguredProviderRefusesBeforeTouchingTheNetwork() {
        val r = HttpSttProvider({ SttConfig.NONE }).transcribe(request(160))
        assertFalse(r.ok)
        assertEquals("not-configured", r.error)
        assertFalse(HttpSttProvider({ SttConfig.NONE }).isConfigured())
    }

    // -- helpers -------------------------------------------------------------------------------

    @Test
    fun base64MatchesTheReferenceImplementation() {
        val data = ByteArray(257) { (it * 7).toByte() }
        for (n in intArrayOf(0, 1, 2, 3, 4, 5, 255, 256, 257)) {
            assertEquals(
                "length $n",
                java.util.Base64.getEncoder().encodeToString(data.copyOf(n)),
                HttpSttProvider.base64(data.copyOf(n))
            )
        }
    }

    @Test
    fun wavHeaderIsCanonical() {
        val h = HttpSttProvider.wavHeader(16000, 1, 3200)
        assertEquals("RIFF", String(h, 0, 4))
        assertEquals(36 + 3200, le32(h, 4))
        assertEquals("WAVEfmt ", String(h, 8, 8))
        assertEquals(16, le32(h, 16))
        assertEquals(1, le16(h, 20))       // PCM
        assertEquals(1, le16(h, 22))       // mono
        assertEquals(16000, le32(h, 24))
        assertEquals(32000, le32(h, 28))   // byte rate
        assertEquals(2, le16(h, 32))       // block align
        assertEquals(16, le16(h, 34))      // bits per sample
        assertEquals("data", String(h, 36, 4))
        assertEquals(3200, le32(h, 40))
    }

    private fun le16(b: ByteArray, o: Int) = (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8)
    private fun le32(b: ByteArray, o: Int) = le16(b, o) or (le16(b, o + 2) shl 16)
}
