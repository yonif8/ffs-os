package expo.modules.ffsble.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The mock has one job -- be DETERMINISTIC -- because everything downstream of it is asserted
 * on. A mock that returned anything varying would make the archive tests flaky, and a flaky
 * archive test eventually gets deleted, which is how a feature loses its definition of done.
 */
class SttMockProviderTest {

    private fun tone(samples: Int, amp: Int = 6000, seedPhase: Double = 0.0): ShortArray =
        ShortArray(samples) { i ->
            (amp * Math.sin(seedPhase + i * 0.05)).toInt().toShort()
        }

    private fun request(pcm: ShortArray) = SttRequest(
        pcm = pcm, sessionId = "s-test", startMs = 0, endMs = 1000
    )

    @Test
    fun taughtAudioTranscribesToTheTaughtSentence() {
        val p = MockSttProvider()
        val pcm = tone(16_000)
        p.teach(pcm, "the rain in spain stays mainly on the plain")
        val r = p.transcribe(request(pcm))
        assertTrue(r.ok)
        assertEquals("the rain in spain stays mainly on the plain", r.text)
        assertEquals(MockSttProvider.NAME, r.provider)
    }

    @Test
    fun sameAudioAlwaysGivesTheSameText() {
        val p = MockSttProvider()
        val pcm = tone(8_000)
        val a = p.transcribe(request(pcm)).text
        val b = p.transcribe(request(pcm.copyOf())).text
        assertEquals(a, b)
        // And a second, independent instance agrees -- the key is a specified hash, not
        // whatever the JVM's Object.hashCode happened to be this run.
        assertEquals(a, MockSttProvider().transcribe(request(pcm)).text)
    }

    @Test
    fun differentAudioGivesDifferentSyntheticText() {
        val p = MockSttProvider()
        assertNotEquals(
            p.transcribe(request(tone(8_000))).text,
            p.transcribe(request(tone(4_000, amp = 900))).text
        )
    }

    @Test
    fun syntheticTextIsObviouslyMachineMade() {
        val text = MockSttProvider().transcribe(request(tone(1_600))).text
        assertTrue("fallback must announce itself", text.startsWith("mock clip "))
    }

    @Test
    fun providerNameIsMockSoTheArchiveStaysHonest() {
        assertEquals("mock", MockSttProvider().name)
        assertTrue(MockSttProvider().isConfigured())
    }

    @Test
    fun emptyClipFailsRatherThanInventingWords() {
        val r = MockSttProvider().transcribe(request(ShortArray(0)))
        assertFalse(r.ok)
        assertEquals("empty-clip", r.error)
        assertEquals("", r.text)
    }
}
