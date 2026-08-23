package expo.modules.ffsble.voice

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The durable worker: does it lose work, and does the backlog drain when a provider finally
 * appears?
 *
 * [backlogAccumulatesWithNoProviderThenDrainsWhenOneIsConfigured] is the one that matters most
 * after the headline test. It encodes the product decision that the phone SHIPS with no
 * provider, keeps listening anyway, and transcribes retroactively -- so "I haven't picked an
 * STT vendor yet" costs the user nothing except a delay.
 */
@RunWith(RobolectricTestRunner::class)
// ⚠️ Robolectric 4.13 ships android-all jars up to SDK 34, while the app targets 36; without
// this pin every test here dies at initialization with "targetSdkVersion=36 > maxSdkVersion=34".
// SDK 34 exercises the same android.database.sqlite FTS4 code path, so nothing is lost.
@Config(sdk = [34])
class SttQueueTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var root: java.io.File
    private lateinit var index: SqliteTranscriptIndex
    private lateinit var store: SttConfigStore
    private lateinit var providers: SttProviderFactory

    /** Fake clock, so backoff is asserted rather than slept through. */
    private var now = 1_000_000L

    @Before
    fun setUp() {
        root = tmp.newFolder("voice")
        index = SqliteTranscriptIndex(ApplicationProvider.getApplicationContext(), null)
        store = SttConfigStore(SttConfigStore.defaultFile(root))
        providers = SttProviderFactory(store)
        index.upsertSession(VoiceSession("s", 5_000L, null, "/tmp/s.g2a", 1, 1_000))
    }

    @After
    fun tearDown() = index.close()

    private fun newQueue() = SttQueue(root, providers, index, clock = { now })

    private fun audio(seed: Int, n: Int = 1600) =
        ShortArray(n) { i -> (4000 * Math.sin(seed + i * 0.02)).toInt().toShort() }

    // ─────────────────────────────────────────────────────────────────────────────────────────

    @Test
    fun backlogAccumulatesWithNoProviderThenDrainsWhenOneIsConfigured() {
        val q = newQueue()

        // 1. NO PROVIDER. Audio still arrives and is still kept.
        assertFalse(providers.isConfigured())
        val clips = (1..3).map { audio(it) }
        clips.forEachIndexed { i, pcm -> q.enqueue("s", i * 1000L, i * 1000L + 1000, pcm) }

        assertEquals(0, q.drainOnce())
        assertEquals("nothing may be dropped while unconfigured", 3, q.pendingCount())
        assertEquals(0L, index.stats()["segments"])
        assertTrue(q.stats().waitingForProvider > 0)

        // 2. A provider appears. The mock is taught what each backlogged clip means.
        store.save(SttConfig.MOCK)
        store.invalidate()
        providers.mock.teach(clips[0], "the first thing that was ever said out loud")
        providers.mock.teach(clips[1], "the second remark about the weather in autumn")
        providers.mock.teach(clips[2], "and a third about the price of replacement lenses")
        q.poke()

        // 3. The WHOLE backlog transcribes.
        assertEquals(3, q.drainOnce())
        assertEquals(0, q.pendingCount())
        assertEquals(3L, index.stats()["segments"])
        assertEquals(1, index.search("replacement lenses").size)
        assertEquals(1, index.search("weather autumn").size)
    }

    @Test
    fun pendingWorkSurvivesAProcessRestart() {
        val q1 = newQueue()
        val pcm = audio(11)
        val id = q1.enqueue("s", 0, 1000, pcm)
        assertTrue(q1.queueFile.exists())

        // A brand-new SttQueue over the same directory == the app was killed and restarted.
        val q2 = newQueue()
        assertEquals(1, q2.pendingCount())
        val recovered = q2.pendingSnapshot().first()
        assertEquals(id, recovered.id)
        assertEquals("s", recovered.sessionId)
        assertTrue("the clip itself must have survived too",
            java.io.File(recovered.pcmPath).exists())

        store.save(SttConfig.MOCK)
        providers.mock.teach(pcm, "a sentence that outlived the process that recorded it")
        assertEquals(1, q2.drainOnce())
        assertEquals(1, index.search("outlived the process").size)
    }

    @Test
    fun aTornQueueFileCostsOneItemNotTheWholeBacklog() {
        val q1 = newQueue()
        q1.enqueue("s", 0, 1000, audio(1))
        q1.enqueue("s", 1000, 2000, audio(2))
        // Simulate a kill mid-write: truncate the last line.
        val text = q1.queueFile.readText()
        q1.queueFile.writeText(text.substring(0, text.length - 12))

        val q2 = newQueue()
        assertEquals(1, q2.pendingCount())
    }

    @Test
    fun aPermanentlyFailingItemStaysPendingForever() {
        store.save(SttConfig.MOCK)
        // A provider that never succeeds. Not a vendor -- a deliberate always-fail stub.
        providers.override = object : SttProvider {
            override val name = "always-fails"
            override fun isConfigured() = true
            override fun transcribe(request: SttRequest) =
                SttResult(false, "", null, name, error = "synthetic-failure")
        }
        val q = newQueue()
        q.enqueue("s", 0, 1000, audio(3))

        repeat(5) {
            q.drainOnce()
            now += 10_000_000L // past any backoff
        }
        assertEquals("a failing item is NEVER discarded", 1, q.pendingCount())
        assertEquals("synthetic-failure", q.pendingSnapshot().first().lastError)
        assertTrue(q.stats().failures > 0)
        assertEquals(0L, index.stats()["segments"])

        // And the clip is still on disk, so it can be transcribed once the problem is fixed.
        assertTrue(java.io.File(q.pendingSnapshot().first().pcmPath).exists())
    }

    @Test
    fun failureSchedulesABackoffAndTheItemIsSkippedUntilItElapses() {
        store.save(SttConfig.MOCK)
        var calls = 0
        providers.override = object : SttProvider {
            override val name = "counting"
            override fun isConfigured() = true
            override fun transcribe(request: SttRequest): SttResult {
                calls++
                return SttResult(false, "", null, name, error = "synthetic-failure")
            }
        }
        val q = newQueue()
        q.enqueue("s", 0, 1000, audio(4))

        q.drainOnce()
        val afterFirstPass = calls
        assertTrue("default retryAttempts is 3", afterFirstPass >= 3)
        assertTrue(q.pendingSnapshot().first().nextAttemptAtMs > now)

        // Immediately again: the item is not due, so the provider is not called at all.
        q.drainOnce()
        assertEquals(afterFirstPass, calls)

        // Once the backoff elapses it is retried.
        now = q.pendingSnapshot().first().nextAttemptAtMs
        q.drainOnce()
        assertTrue(calls > afterFirstPass)
    }

    @Test
    fun enqueueFileDoesNotCopyAndDoesNotDelete() {
        store.save(SttConfig.MOCK)
        val pcm = audio(5)
        val f = tmp.newFile("external.pcm")
        f.writeBytes(HttpSttProvider.pcmToLeBytes(pcm))
        providers.mock.teach(pcm, "audio that came from somebody else's file")

        val q = newQueue()
        q.enqueueFile("s", 0, 1000, f)
        assertEquals(1, q.drainOnce())
        assertTrue("we never delete a file we did not create", f.exists())
        assertEquals(1, index.search("somebody file").size)
    }

    @Test
    fun statsAreCountsOnly() {
        store.save(SttConfig.MOCK)
        val q = newQueue()
        val pcm = audio(6)
        providers.mock.teach(pcm, "confidential sounding words that must not appear in stats")
        q.enqueue("s", 0, 1000, pcm)
        q.drainOnce()
        val rendered = q.stats().toString()
        assertFalse(rendered.contains("confidential"))
        assertEquals(1L, q.stats().transcribed)
    }

    @Test
    fun theWorkerThreadDrainsWithoutBeingPushed() {
        store.save(SttConfig.MOCK)
        val pcm = audio(8)
        providers.mock.teach(pcm, "the background worker picked this up on its own")
        val q = SttQueue(root, providers, index) // real clock for this one
        q.enqueue("s", 0, 1000, pcm)
        q.start()
        val deadline = System.currentTimeMillis() + 10_000
        while (q.pendingCount() > 0 && System.currentTimeMillis() < deadline) Thread.sleep(25)
        q.stop()
        assertEquals(0, q.pendingCount())
        assertNotNull(index.search("background worker").firstOrNull())
    }
}
