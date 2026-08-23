package expo.modules.ffsble.voice

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * ★ **THE DEFINITION OF DONE FOR THIS HALF OF S-VOICE, IN ONE TEST.**
 *
 * [speakASentenceThenFindItByText] runs a known sentence through the whole transcription and
 * archive path -- [MockSttProvider] -> [SttQueue] (durable, on disk) -> [SqliteTranscriptIndex]
 * (real SQLite, real FTS4) -- and then finds it again by searching for a few words **from the
 * middle** of it, asserting on the returned snippet AND on the link back to the session.
 *
 * Searching for words from the middle matters: matching the first words could be satisfied by a
 * prefix comparison, and matching the whole sentence could be satisfied by string equality.
 * Only an interior phrase proves the text was really tokenised and indexed.
 *
 * ⛔ The sentence is synthetic and obviously non-personal. Nothing here touches the network.
 */
@RunWith(RobolectricTestRunner::class)
// ⚠️ Robolectric 4.13 ships android-all jars up to SDK 34, while the app targets 36; without
// this pin every test here dies at initialization with "targetSdkVersion=36 > maxSdkVersion=34".
// SDK 34 exercises the same android.database.sqlite FTS4 code path, so nothing is lost.
@Config(sdk = [34])
class SttPipelineHeadlineTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var index: SqliteTranscriptIndex
    private lateinit var store: SttConfigStore
    private lateinit var providers: SttProviderFactory
    private lateinit var queue: SttQueue

    /** Deterministic stand-in for a spoken clip: 2 s of a tone at 16 kHz. */
    private fun spokenAudio(seed: Int, seconds: Double = 2.0): ShortArray {
        val n = (VoiceFormat.SAMPLE_RATE * seconds).toInt()
        return ShortArray(n) { i -> (5000 * Math.sin(seed + i * 0.031)).toInt().toShort() }
    }

    @Before
    fun setUp() {
        val root = tmp.newFolder("voice")
        index = SqliteTranscriptIndex(ApplicationProvider.getApplicationContext(), null)
        store = SttConfigStore(SttConfigStore.defaultFile(root))
        providers = SttProviderFactory(store)
        queue = SttQueue(root, providers, index)
    }

    @After
    fun tearDown() {
        queue.stop()
        index.close()
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // ★ THE HEADLINE TEST
    // ─────────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun speakASentenceThenFindItByText() {
        val sentence =
            "remember to collect the spare lens cable from the workshop before friday afternoon"

        // 1. A session was recorded.
        val session = VoiceSession(
            id = "sess-headline",
            startedAtEpochMs = 1_700_000_000_000L,
            endedAtEpochMs = 1_700_000_060_000L,
            masterPath = tmp.newFile("sess-headline.g2a").absolutePath,
            packets = 40,
            durationMs = 2_000
        )
        index.upsertSession(session)

        // 2. Somebody said the sentence. The mock is taught what this clip means, which is what
        //    stands in for a real provider until the user picks one.
        val audio = spokenAudio(seed = 7)
        store.save(SttConfig.MOCK)
        providers.mock.teach(audio, sentence)

        // 3. The clip enters the durable queue and is transcribed.
        queue.enqueue(session.id, startMs = 0, endMs = 2_000, pcm = audio)
        assertEquals(1, queue.pendingCount())
        assertEquals(1, queue.drainOnce())
        assertEquals("queue must empty on success", 0, queue.pendingCount())

        // 4. ★ FIND IT AGAIN -- by words from the MIDDLE of the sentence.
        val hits = index.search("spare lens cable")

        assertEquals("exactly one hit expected", 1, hits.size)
        val hit = hits[0]

        // The snippet came from SQLite's snippet(), with our [ ] delimiters around the matches.
        assertTrue("snippet must highlight the query terms: ${hit.snippet}",
            hit.snippet.contains("[spare]") && hit.snippet.contains("[lens]") &&
                hit.snippet.contains("[cable]"))

        // Session linkage: the hit knows which recording it came from and when that was.
        assertEquals("sess-headline", hit.segment.sessionId)
        assertEquals(1_700_000_000_000L, hit.sessionStartedAtEpochMs)
        assertEquals(0L, hit.segment.startMs)
        assertEquals(2_000L, hit.segment.endMs)

        // The full sentence is preserved, not just the snippet.
        assertEquals(sentence, hit.segment.text)

        // And it is forever marked as having come from the mock, not from a real provider.
        assertEquals(MockSttProvider.NAME, hit.segment.provider)

        // The archive agrees.
        val stats = index.stats()
        assertEquals(1L, stats["sessions"])
        assertEquals(1L, stats["segments"])
        assertEquals(13L, stats["words"])
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Supporting proofs of the same path
    // ─────────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun manySessionsAndTheRightOneComesBack() {
        store.save(SttConfig.MOCK)
        val sentences = listOf(
            "the train to brighton leaves from platform four at half past six",
            "flour eggs butter and a jar of the good marmalade",
            "the compass calibration drifts whenever the left temple gets warm"
        )
        sentences.forEachIndexed { i, text ->
            val id = "sess-$i"
            index.upsertSession(
                VoiceSession(id, 1_000L + i * 1_000L, null, "/tmp/$id.g2a", 10, 1_000)
            )
            val audio = spokenAudio(seed = i + 1, seconds = 1.0)
            providers.mock.teach(audio, text)
            queue.enqueue(id, 0, 1_000, audio)
        }
        assertEquals(3, queue.drainOnce())

        val hits = index.search("marmalade")
        assertEquals(1, hits.size)
        assertEquals("sess-1", hits[0].segment.sessionId)

        // "the" appears in two of the three; both come back, newest session first.
        val compass = index.search("compass calibration")
        assertEquals(1, compass.size)
        assertEquals("sess-2", compass[0].segment.sessionId)
    }
}
