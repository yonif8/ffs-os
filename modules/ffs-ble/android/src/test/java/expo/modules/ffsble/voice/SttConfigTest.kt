package expo.modules.ffsble.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The config model and its store.
 *
 * The load-bearing test here is [toStringRedactsCredentials]: a Kotlin data class leaks its
 * fields by default, and [SttConfig.headers] is where an API key lives. One careless
 * `Log.d(TAG, "$cfg")` would put a bearer token in logcat, which is the same class of mistake
 * that once put 3,281 base64 audio frames in the driver log (see `G2MicStats`). The redaction
 * has to be a tested property, not a convention.
 *
 * ⛔ Every value in this file is synthetic. `example.invalid` is reserved by RFC 2606 and can
 * never be a real provider; the "keys" are obvious nonsense.
 */
class SttConfigTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun sample() = SttConfig(
        providerKind = SttConfig.KIND_HTTP,
        displayName = "Some Provider",
        endpointUrl = "https://stt.example.invalid/v1/recognize",
        headers = mapOf("Authorization" to "Bearer NOT-A-REAL-KEY-0123456789"),
        queryParams = mapOf("apiKey" to "ALSO-NOT-REAL-abcdef"),
        extraParams = mapOf("language" to "en-US", "sample_rate" to "16000"),
        audioEncoding = SttConfig.AUDIO_WAV,
        textPath = "results.0.alternatives.0.transcript",
        confidencePath = "results.0.alternatives.0.confidence",
        maxClipSeconds = 45
    )

    @Test
    fun toStringRedactsCredentials() {
        val cfg = sample()
        val rendered = "$cfg" + cfg.redactedSummary()
        assertFalse("header value leaked", rendered.contains("NOT-A-REAL-KEY"))
        assertFalse("query value leaked", rendered.contains("ALSO-NOT-REAL"))
        assertFalse("full URL leaked", rendered.contains("/v1/recognize"))
        // The host is fine to show and is what makes the summary useful at all.
        assertTrue(rendered.contains("stt.example.invalid"))
        assertTrue(rendered.contains("REDACTED"))
    }

    @Test
    fun jsonRoundTripPreservesEverything() {
        val cfg = sample()
        val back = SttConfig.fromJson(cfg.toJson())
        assertEquals(cfg, back)
    }

    @Test
    fun defaultIsNoneAndNoneIsNotUsable() {
        assertEquals(SttConfig.KIND_NONE, SttConfig().providerKind)
        assertFalse(SttConfig.NONE.isUsable())
        assertTrue(SttConfig.MOCK.isUsable())
    }

    @Test
    fun validationNamesFieldsWithoutEchoingValues() {
        val bad = SttConfig(providerKind = SttConfig.KIND_HTTP, endpointUrl = "", textPath = "")
        val problems = bad.validationProblems()
        assertTrue(problems.any { it.startsWith("endpointUrl") })
        assertTrue(problems.any { it.startsWith("textPath") })
        // No problem string may carry a value; here that means no scheme fragments etc.
        assertTrue(problems.none { it.contains("Bearer") })
    }

    @Test
    fun unimplementedEncodingIsRejectedByValidation() {
        val cfg = sample().copy(audioEncoding = "flac")
        assertTrue(cfg.validationProblems().any { it.startsWith("audioEncoding") })
    }

    // -- store ---------------------------------------------------------------------------------

    @Test
    fun absentFileMeansArchiveButDoNotTranscribe() {
        val store = SttConfigStore(SttConfigStore.defaultFile(tmp.newFolder("files")))
        assertEquals(SttConfig.KIND_NONE, store.load().providerKind)
        assertFalse(store.isConfigured())
    }

    @Test
    fun saveThenLoadRoundTrips() {
        val f = SttConfigStore.defaultFile(tmp.newFolder("files"))
        val store = SttConfigStore(f)
        store.save(sample())
        assertTrue(f.exists())
        val reread = SttConfigStore(f).load()
        assertEquals(sample(), reread)
    }

    @Test
    fun corruptFileFallsBackToNoneAndKeepsTheFile() {
        val f = SttConfigStore.defaultFile(tmp.newFolder("files"))
        f.parentFile!!.mkdirs()
        f.writeText("{ this is not json")
        val store = SttConfigStore(f)
        assertEquals(SttConfig.KIND_NONE, store.load().providerKind)
        assertTrue("a corrupt config must not be deleted", f.exists())
    }

    @Test
    fun clearReturnsToNone() {
        val f = SttConfigStore.defaultFile(tmp.newFolder("files"))
        val store = SttConfigStore(f)
        store.save(SttConfig.MOCK)
        assertTrue(store.isConfigured())
        store.clear()
        assertFalse(store.isConfigured())
        assertFalse(f.exists())
    }
}
