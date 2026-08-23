package expo.modules.ffsble.voice

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The searchable archive itself: real `android.database.sqlite`, real FTS4, real `snippet()`,
 * running on the desktop JVM under Robolectric.
 *
 * WHY ROBOLECTRIC RATHER THAN AN INTERFACE FAKE: "full-text search finds the sentence" is the
 * definition of done, and a hand-written in-memory `TranscriptIndex` would prove that MY
 * matching logic works, not that SQLite's does. The thing that ships is the SQL, so the thing
 * that gets tested has to be the SQL.
 *
 * ⛔ All text here is synthetic and obviously non-personal.
 */
@RunWith(RobolectricTestRunner::class)
// ⚠️ Robolectric 4.13 ships android-all jars up to SDK 34, while the app targets 36; without
// this pin every test here dies at initialization with "targetSdkVersion=36 > maxSdkVersion=34".
// SDK 34 exercises the same android.database.sqlite FTS4 code path, so nothing is lost.
@Config(sdk = [34])
class TranscriptIndexSearchTest {

    private lateinit var index: SqliteTranscriptIndex

    @Before
    fun setUp() {
        // dbName = null -> in-memory database, fresh per test.
        index = SqliteTranscriptIndex(ApplicationProvider.getApplicationContext(), null)
    }

    @After
    fun tearDown() {
        index.close()
    }

    private fun session(id: String, startedAt: Long) = VoiceSession(
        id = id, startedAtEpochMs = startedAt, endedAtEpochMs = startedAt + 60_000,
        masterPath = "/tmp/$id.g2a", packets = 1200, durationMs = 60_000
    )

    @Test
    fun sessionRoundTrips() {
        index.upsertSession(session("sess-a", 1_000_000L))
        val back = index.getSession("sess-a")!!
        assertEquals("sess-a", back.id)
        assertEquals(1_000_000L, back.startedAtEpochMs)
        assertEquals(1_060_000L, back.endedAtEpochMs)
        assertEquals(1200, back.packets)
        assertEquals(1, index.listSessions().size)
    }

    @Test
    fun segmentIsSearchableAndSnippetUsesSquareBrackets() {
        index.upsertSession(session("sess-a", 1_000_000L))
        index.addSegment(
            "sess-a", 0, 4000,
            "the quick brown fox jumps over the lazy dog by the riverbank",
            0.91, "mock"
        )
        val hits = index.search("brown fox")
        assertEquals(1, hits.size)
        assertTrue(hits[0].snippet.contains("[brown]"))
        assertTrue(hits[0].snippet.contains("[fox]"))
        assertEquals("sess-a", hits[0].segment.sessionId)
        assertEquals(1_000_000L, hits[0].sessionStartedAtEpochMs)
        assertEquals(0.91, hits[0].segment.confidence!!, 1e-9)
    }

    @Test
    fun resultsAreOrderedByMostRecentSession() {
        index.upsertSession(session("old", 1_000L))
        index.upsertSession(session("new", 9_000L))
        index.addSegment("old", 0, 100, "compass bearing was mentioned here", null, "mock")
        index.addSegment("new", 0, 100, "compass bearing again, later", null, "mock")
        val hits = index.search("compass")
        assertEquals(2, hits.size)
        assertEquals("new", hits[0].segment.sessionId)
        assertEquals("old", hits[1].segment.sessionId)
    }

    @Test
    fun allTermsMustMatch() {
        index.upsertSession(session("s", 1L))
        index.addSegment("s", 0, 1, "alpha bravo charlie", null, "mock")
        index.addSegment("s", 1, 2, "alpha delta echo", null, "mock")
        assertEquals(2, index.search("alpha").size)
        assertEquals(1, index.search("alpha bravo").size)
        assertEquals(0, index.search("alpha foxtrot").size)
    }

    /**
     * The crash-resistance test. FTS4's parser throws on a bare `*`, an unbalanced `"` or a
     * leading `-`; a search box will produce all three within a week of shipping.
     */
    @Test
    fun punctuationAndQuotesNeitherCrashNorInject() {
        index.upsertSession(session("s", 1L))
        index.addSegment("s", 0, 1, "dinner reservation at seven o'clock", null, "mock")

        assertEquals(1, index.search("o'clock").size)
        assertEquals(1, index.search("\"reservation\"").size)
        assertEquals(1, index.search("reservation*").size)
        assertEquals(1, index.search("-reservation").size)
        assertEquals(1, index.search("reservation) OR (").size)

        // A query of pure punctuation matches NOTHING rather than everything.
        assertEquals(0, index.search("***").size)
        assertEquals(0, index.search("   ").size)
        assertEquals(0, index.search("\"\"").size)

        // The classic injection payload must not drop the table.
        index.search("x'; DROP TABLE segments; --")
        assertEquals(1L, index.stats()["segments"])
    }

    @Test
    fun statsCountSessionsSegmentsAndWords() {
        index.upsertSession(session("s", 1L))
        index.addSegment("s", 0, 1, "one two three", null, "mock")
        index.addSegment("s", 1, 2, "four five", null, "http")
        val st = index.stats()
        assertEquals(1L, st["sessions"])
        assertEquals(2L, st["segments"])
        assertEquals(5L, st["words"])
        // Mock-produced text stays distinguishable forever.
        assertEquals(1L, st["mockSegments"])
    }

    @Test
    fun segmentsOfASessionComeBackInTimeOrder() {
        index.upsertSession(session("s", 1L))
        index.addSegment("s", 2000, 3000, "second thing said", null, "mock")
        index.addSegment("s", 0, 1000, "first thing said", null, "mock")
        val segs = index.segmentsOf("s")
        assertEquals(2, segs.size)
        assertEquals(0L, segs[0].startMs)
        assertEquals(2000L, segs[1].startMs)
    }

    /**
     * There is no retention policy, and the only removal is the explicitly-named user path.
     * This test exists so that anyone who later adds a background trim has to delete a test
     * whose name says what they are doing.
     */
    @Test
    fun nothingIsRemovedExceptByTheExplicitUserRequestPath() {
        index.upsertSession(session("s", 1L))
        index.addSegment("s", 0, 1, "keep me forever please", null, "mock")
        // Re-opening, re-querying, collecting stats: none of it evicts anything.
        repeat(5) { index.stats(); index.search("keep"); index.listSessions() }
        assertEquals(1, index.search("forever").size)

        index.deleteSessionByUserRequest("s")
        assertEquals(0, index.search("forever").size)
        assertEquals(0L, index.stats()["segments"])
    }
}
