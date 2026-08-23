package expo.modules.ffsble.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The message decoder and URL builder of the live (word-by-word) path, exercised without a
 * socket. [LiveSttStream.handle] is `internal` precisely so this test can drive the exact
 * function the websocket callback drives.
 */
class LiveSttStreamTest {

    private fun cfg() = SttConfig(
        providerKind = SttConfig.KIND_HTTP,
        streamUrl = "wss://example.test/v1/listen",
        streamParams = linkedMapOf("encoding" to "linear16", "sample_rate" to "16000", "a b" to "c&d")
    )

    private fun stream(
        onInterim: (String) -> Unit = {},
        onFinal: (String) -> Unit = {},
        c: SttConfig = cfg()
    ) = LiveSttStream(c, onInterim, onFinal, log = null)

    @Test fun `query parameters are appended and escaped`() {
        val u = stream().url()
        assertTrue(u, u.startsWith("wss://example.test/v1/listen?"))
        assertTrue(u, u.contains("encoding=linear16"))
        assertTrue(u, u.contains("sample_rate=16000"))
        assertTrue("must percent-escape: $u", u.contains("a+b=c%26d") || u.contains("a%20b=c%26d"))
    }

    @Test fun `an interim message replaces the tail, a final one settles it`() {
        val interim = ArrayList<String>()
        val fin = ArrayList<String>()
        val s = stream({ interim.add(it) }, { fin.add(it) })

        s.handle("""{"is_final":false,"channel":{"alternatives":[{"transcript":"so I thin"}]}}""")
        s.handle("""{"is_final":false,"channel":{"alternatives":[{"transcript":"so I think so"}]}}""")
        s.handle("""{"is_final":true,"channel":{"alternatives":[{"transcript":"So I think so."}]}}""")

        assertEquals(listOf("so I thin", "so I think so"), interim)
        assertEquals(listOf("So I think so."), fin)
    }

    @Test fun `keepalive and empty transcripts are dropped, not painted as blank lines`() {
        var calls = 0
        val s = stream({ calls++ }, { calls++ })
        s.handle("""{"type":"Metadata","request_id":"x"}""")
        s.handle("""{"is_final":false,"channel":{"alternatives":[{"transcript":""}]}}""")
        s.handle("""{"is_final":false,"channel":{"alternatives":[{"transcript":"   "}]}}""")
        s.handle("not json at all")
        assertEquals(0, calls)
    }

    @Test fun `the final flag is read wherever the config says it lives`() {
        val fin = ArrayList<String>()
        val s = stream({}, { fin.add(it) }, cfg().copy(
            streamTextPath = "result.text",
            streamFinalPath = "result.done"
        ))
        s.handle("""{"result":{"text":"hello","done":false}}""")
        assertEquals(emptyList<String>(), fin)
        s.handle("""{"result":{"text":"hello there","done":true}}""")
        assertEquals(listOf("hello there"), fin)
    }

    @Test fun `feeding before start is a no-op, not a crash`() {
        val s = stream()
        s.feed(ShortArray(800) { 1 }, 800)   // never started: must not throw
        s.stop()                              // idempotent
    }

    @Test fun `an empty streamUrl disables streaming`() {
        assertTrue(!SttConfig.NONE.streamingEnabled)
        assertTrue(cfg().streamingEnabled)
        assertTrue(!stream(c = cfg().copy(streamUrl = "")).start())
    }

    @Test fun `streaming config survives a json round trip`() {
        val c = cfg().copy(streamChunkMs = 60, streamFinalPath = "done")
        val back = SttConfig.fromJson(c.toJson())
        assertEquals(c.streamUrl, back.streamUrl)
        assertEquals(c.streamParams, back.streamParams)
        assertEquals(c.streamChunkMs, back.streamChunkMs)
        assertEquals(c.streamFinalPath, back.streamFinalPath)
        assertEquals(c.streamCloseMessage, back.streamCloseMessage)
    }
}
