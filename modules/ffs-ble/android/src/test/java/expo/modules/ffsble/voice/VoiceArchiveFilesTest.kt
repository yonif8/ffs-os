package expo.modules.ffsble.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile

/**
 * The master archive: does a session survive being written, killed, reopened and re-decoded?
 *
 * WHY A `TemporaryFolder` IS A COMPLETE SUBSTITUTE FOR THE PHONE
 * --------------------------------------------------------------
 * [VoiceArchiveFiles] takes its root as a plain [File] and imports no Android, so everything it
 * does is exercisable here -- including the one behaviour that CANNOT be tested on a device on
 * demand: a process killed mid-write. Truncating a file by a few bytes is a one-line simulation
 * of exactly what a force-stop leaves behind, and the repair path is the difference between
 * losing 50 ms and losing the rest of the recording to permanent misalignment.
 *
 * ⛔ Every packet here is synthetic ([VoiceTestPackets]). `ffs_os` is PUBLIC and a real mic
 * packet is a recording of the wearer.
 */
class VoiceArchiveFilesTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun archive() = VoiceArchiveFiles(File(tmp.root, "voice"))

    private fun writeSession(a: VoiceArchiveFiles, id: String, counters: IntRange): File {
        a.open(id, 1_700_000_000_000L).use { w ->
            for (c in counters) w.append(VoiceTestPackets.packet(c and 0xFF, seed = c))
        }
        return a.masterFile(id)
    }

    // -- layout ------------------------------------------------------------------------------

    @Test
    fun `a session lays out master and meta under sessions`() {
        val a = archive()
        writeSession(a, "s1", 1..10)
        assertTrue(a.masterFile("s1").isFile)
        assertTrue(a.metaFile("s1").isFile)
        assertEquals(listOf("s1"), a.listSessionIds())
        assertEquals(
            File(tmp.root, "voice/sessions/s1/master.g2a").canonicalPath,
            a.masterFile("s1").canonicalPath
        )
    }

    @Test
    fun `the master is exactly 205 bytes per packet, verbatim`() {
        val a = archive()
        val master = writeSession(a, "s1", 1..10)
        assertEquals(10L * VoiceFormat.PACKET_BYTES, master.length())
        assertEquals(10L, a.packetCount(master))
        val bytes = master.readBytes()
        assertArrayEquals(
            VoiceTestPackets.packet(3, seed = 3),
            bytes.copyOfRange(2 * VoiceFormat.PACKET_BYTES, 3 * VoiceFormat.PACKET_BYTES)
        )
    }

    @Test
    fun `readPackets round-trips every packet in order`() {
        val a = archive()
        val master = writeSession(a, "s1", 1..64)
        val back = a.readPackets(master).toList()
        assertEquals(64, back.size)
        for ((i, p) in back.withIndex()) {
            assertArrayEquals("packet $i", VoiceTestPackets.packet(i + 1, seed = i + 1), p)
        }
    }

    @Test
    fun `readPackets yields distinct arrays, not one reused buffer`() {
        val a = archive()
        val master = writeSession(a, "s1", 1..3)
        val back = a.readPackets(master).toList()
        assertFalse(back[0] === back[1])
        assertFalse(back[0].contentEquals(back[1]))
    }

    @Test
    fun `a wrong-length packet is refused rather than misaligning the file`() {
        val a = archive()
        a.open("s1", 0L).use { w ->
            assertTrue(w.append(VoiceTestPackets.packet(1)))
            assertFalse(w.append(ByteArray(100)))
            assertFalse(w.append(ByteArray(400)))
            assertTrue(w.append(VoiceTestPackets.packet(2)))
        }
        assertEquals(2L * VoiceFormat.PACKET_BYTES, a.masterFile("s1").length())
    }

    @Test
    fun `reopening a session appends rather than truncating`() {
        val a = archive()
        writeSession(a, "s1", 1..5)
        a.open("s1", 0L).use { w ->
            assertEquals(5L, w.packets)
            w.append(VoiceTestPackets.packet(6, seed = 6))
        }
        assertEquals(6L, a.packetCount(a.masterFile("s1")))
    }

    // -- crash recovery ----------------------------------------------------------------------

    @Test
    fun `a torn tail is detected on reopen and truncated to the last whole packet`() {
        val a = archive()
        val master = writeSession(a, "s1", 1..10)

        // Simulate a process killed mid-write: 73 bytes of an 11th packet made it to disk.
        RandomAccessFile(master, "rw").use { raf ->
            raf.seek(raf.length())
            raf.write(ByteArray(73) { it.toByte() })
        }
        assertEquals(10L * VoiceFormat.PACKET_BYTES + 73, master.length())

        val w = a.open("s1", 0L)
        assertEquals("the repair must report what it removed", 73L, w.repairedBytes)
        assertEquals(10L, w.packets)
        // And appending after the repair stays aligned -- the whole point.
        w.append(VoiceTestPackets.packet(11, seed = 11))
        w.close()

        assertEquals(11L * VoiceFormat.PACKET_BYTES, master.length())
        val back = a.readPackets(master).toList()
        assertEquals(11, back.size)
        assertArrayEquals(VoiceTestPackets.packet(11, seed = 11), back[10])
    }

    @Test
    fun `repairing a whole file is a no-op`() {
        val a = archive()
        val master = writeSession(a, "s1", 1..4)
        assertEquals(0L, a.repairMaster(master))
        assertEquals(4L * VoiceFormat.PACKET_BYTES, master.length())
    }

    @Test
    fun `repairing a missing file is a no-op`() {
        val a = archive()
        assertEquals(0L, a.repairMaster(File(tmp.root, "nope.g2a")))
    }

    @Test
    fun `a file that is nothing but a torn packet repairs to empty, not to garbage`() {
        val a = archive()
        val master = a.masterFile("s1")
        master.parentFile!!.mkdirs()
        master.writeBytes(ByteArray(40))
        assertEquals(40L, a.repairMaster(master))
        assertEquals(0L, master.length())
    }

    @Test
    fun `readPackets stops cleanly at a torn tail instead of throwing`() {
        val a = archive()
        val master = writeSession(a, "s1", 1..3)
        RandomAccessFile(master, "rw").use { it.setLength(master.length() - 20) }
        assertEquals(2, a.readPackets(master).toList().size)
    }

    // -- meta --------------------------------------------------------------------------------

    @Test
    fun `meta json is written before the first flush so a killed session is identifiable`() {
        val a = archive()
        val w = a.open("s1", 1_700_000_000_000L)
        // Not closed, nothing appended -- exactly what a session killed immediately looks like.
        assertTrue(a.metaFile("s1").isFile)
        val m = a.readMeta("s1")!!
        assertEquals("s1", m.sessionId)
        assertEquals(1_700_000_000_000L, m.startedAtEpochMs)
        assertNull(m.endedAtEpochMs)
        w.close()
    }

    @Test
    fun `meta json round-trips the counts, the clock and the framer stats`() {
        val a = archive()
        val w = a.open("sess-2026", 1_700_000_000_000L)
        w.stats = VoiceFramerStats(
            received = 120, duplicates = 60, malformed = 2,
            concealed = 15, resyncs = 1, lostPackets = 22
        )
        for (c in 1..40) w.append(VoiceTestPackets.packet(c and 0xFF, seed = c))
        w.close(1_700_000_100_000L)

        val m = a.readMeta("sess-2026")!!
        assertEquals(VoiceArchiveFiles.FORMAT_VERSION, m.formatVersion)
        assertEquals("sess-2026", m.sessionId)
        assertEquals(1_700_000_000_000L, m.startedAtEpochMs)
        assertEquals(1_700_000_100_000L, m.endedAtEpochMs)
        assertEquals(40L, m.packets)
        assertEquals(40L * VoiceFormat.PACKET_MS, m.durationMs)
        assertEquals(VoiceFormat.PACKET_BYTES, m.packetBytes)
        assertEquals(VoiceFormat.SAMPLE_RATE, m.sampleRate)
        assertEquals(120, m.stats.received)
        assertEquals(60, m.stats.duplicates)
        assertEquals(2, m.stats.malformed)
        assertEquals(15, m.stats.concealed)
        assertEquals(1, m.stats.resyncs)
        assertEquals(22, m.stats.lostPackets)
    }

    @Test
    fun `meta json carries no audio and no text`() {
        val a = archive()
        writeSession(a, "s1", 1..5)
        val text = a.metaFile("s1").readText()
        // The document is a flat object whose ONLY string VALUE is the session id -- everything
        // else is a count or a clock reading. Anything else appearing here would mean something
        // derived from the recording had leaked into a file we treat as safe to hand over.
        val stringValues = Regex(":\\s*\"([^\"]*)\"").findAll(text).map { it.groupValues[1] }.toList()
        assertEquals(listOf("s1"), stringValues)
        assertTrue(text.contains("\"packets\": 5"))
    }

    @Test
    fun `a missing meta reads as null rather than throwing`() {
        assertNull(archive().readMeta("never-existed"))
    }

    @Test
    fun `a corrupt meta reads as null -- it must never take the master down with it`() {
        val a = archive()
        writeSession(a, "s1", 1..3)
        a.metaFile("s1").writeText("{ this is not json")
        assertNull(a.readMeta("s1"))
        // The master is untouched and still readable, which is the whole point.
        assertEquals(3, a.readPackets(a.masterFile("s1")).toList().size)
    }

    @Test
    fun `toSession bridges meta into the shared VoiceSession contract`() {
        val a = archive()
        val w = a.open("s9", 1_700_000_000_000L)
        for (c in 1..8) w.append(VoiceTestPackets.packet(c, seed = c))
        w.close(1_700_000_000_400L)
        val s = a.toSession("s9")!!
        assertEquals("s9", s.id)
        assertEquals(8, s.packets)
        assertEquals(400L, s.durationMs)
        assertEquals(a.masterFile("s9").absolutePath, s.masterPath)
        assertEquals(1_700_000_000_400L, s.endedAtEpochMs)
    }

    // -- derived wav -------------------------------------------------------------------------

    @Test
    fun `deriveWav re-decodes a master into a valid wav`() {
        val a = archive()
        val master = writeSession(a, "s1", 1..20)
        val wav = File(tmp.root, "derived/s1.wav")
        val result = a.deriveWav(master, wav, FakeLc3Decoder())

        assertEquals(20L, result.packetsRead)
        assertEquals(20L, result.chunksWritten)
        assertEquals(20L * VoiceFormat.SAMPLES_PER_PACKET, result.samplesWritten)
        assertEquals(1_000L, result.durationMs)
        assertEquals(0, result.stats.resyncs)
        assertEquals(0, result.stats.concealed)

        val expectedData = 20 * VoiceFormat.SAMPLES_PER_PACKET * 2
        assertEquals((44 + expectedData).toLong(), wav.length())
        assertArrayEquals(WavWriter.header(expectedData), wav.readBytes().copyOfRange(0, 44))
    }

    @Test
    fun `deriveWav applies the SAME framer rules -- a gap becomes PLC in the wav too`() {
        val a = archive()
        a.open("s1", 0L).use { w ->
            w.append(VoiceTestPackets.packet(1, seed = 1))
            // Counter jumps to 4: two packets lost, so ten PLC frames must be synthesised.
            w.append(VoiceTestPackets.packet(4, seed = 4))
        }
        val wav = File(tmp.root, "s1.wav")
        val decoder = FakeLc3Decoder()
        val result = a.deriveWav(a.masterFile("s1"), wav, decoder)

        assertEquals(2L, result.packetsRead)
        assertEquals("two real chunks plus two concealed ones", 4L, result.chunksWritten)
        assertEquals(10, decoder.framesConcealed)
        assertEquals(10, result.stats.concealed)
        assertEquals(2, result.stats.lostPackets)
        assertEquals(
            (44 + 4 * VoiceFormat.SAMPLES_PER_PACKET * 2).toLong(),
            wav.length()
        )
    }

    @Test
    fun `deriveWav drops archived duplicates rather than doubling the audio`() {
        val a = archive()
        a.open("s1", 0L).use { w ->
            for (c in 1..5) {
                w.append(VoiceTestPackets.packet(c, seed = c))
                w.append(VoiceTestPackets.packet(c, seed = c))
            }
        }
        val result = a.deriveWav(a.masterFile("s1"), File(tmp.root, "s1.wav"), FakeLc3Decoder())
        assertEquals(10L, result.packetsRead)
        assertEquals(5L, result.chunksWritten)
        assertEquals(5, result.stats.duplicates)
    }

    @Test
    fun `deriveWav of an empty master produces an empty but valid wav`() {
        val a = archive()
        a.open("s1", 0L).close()
        val wav = File(tmp.root, "s1.wav")
        val result = a.deriveWav(a.masterFile("s1"), wav, FakeLc3Decoder())
        assertEquals(0L, result.packetsRead)
        assertEquals(44L, wav.length())
        assertArrayEquals(WavWriter.header(0), wav.readBytes())
    }

    @Test
    fun `the pipeline feeds the archive end to end`() {
        // The real wiring: BLE bytes -> pipeline -> a sink that archives the RAW packets, then
        // the master is re-decoded offline. It is the one test that proves the two halves of
        // this stream fit together.
        val a = archive()
        val writer = a.open("live", 1_700_000_000_000L)
        val raws = ArrayList<ByteArray>()
        val sink = object : VoiceSink {
            override fun onChunk(chunk: VoiceAudioChunk) {}
            override fun onStats(stats: VoiceFramerStats) { writer.stats = stats }
        }
        val pipeline = VoicePipeline({ FakeLc3Decoder() }, sink, 64)
        pipeline.start()
        for (c in 1..30) {
            val raw = VoiceTestPackets.packet(c, seed = c)
            raws.add(raw)
            pipeline.submit(raw, "R")
            pipeline.submit(raw, "L")
        }
        pipeline.stop()
        // The archive stores the DEDUPED stream -- one copy per 50 ms, not one per lens.
        for (raw in raws) writer.append(raw)
        writer.close(1_700_000_001_500L)

        assertEquals(30L, a.packetCount(a.masterFile("live")))
        val m = a.readMeta("live")!!
        assertEquals(30L, m.packets)
        assertEquals(60, m.stats.received)
        assertEquals(30, m.stats.duplicates)

        val result = a.deriveWav(a.masterFile("live"), File(tmp.root, "live.wav"), FakeLc3Decoder())
        assertEquals(30L, result.chunksWritten)
        assertNotNull(a.toSession("live"))
    }
}
