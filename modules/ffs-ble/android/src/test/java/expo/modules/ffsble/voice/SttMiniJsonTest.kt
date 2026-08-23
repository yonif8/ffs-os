package expo.modules.ffsble.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [MiniJson] is the parser the whole STT seam depends on -- config round-trip, provider
 * response, durable queue file. If it is wrong, every other test in this package is lying.
 * Plain JVM: no Robolectric needed, which is the point of not using `org.json`.
 */
class SttMiniJsonTest {

    @Test
    fun parsesNestedObjectsAndArrays() {
        val v = MiniJson.parse("""{"a":[1,2,{"b":"c"}],"d":true,"e":null}""")
        val m = v as Map<*, *>
        assertEquals(true, m["d"])
        assertNull(m["e"])
        assertEquals("c", MiniJson.pathString(v, "a.2.b"))
    }

    @Test
    fun resolvesTheKindOfPathAnSttResponseNeeds() {
        // A shape with a list-of-alternatives, which is the common cloud-STT response idiom.
        // ⛔ Synthetic: no provider is named and this is not any vendor's real schema.
        val body = """{"results":[{"alternatives":[{"transcript":"hello there","conf":0.87}]}]}"""
        val root = MiniJson.parse(body)
        assertEquals("hello there", MiniJson.pathString(root, "results.0.alternatives.0.transcript"))
        assertEquals(0.87, MiniJson.pathDouble(root, "results.0.alternatives.0.conf")!!, 1e-9)
    }

    @Test
    fun missingPathIsNullNotAnException() {
        val root = MiniJson.parse("""{"a":{"b":1}}""")
        assertNull(MiniJson.pathString(root, "a.c"))
        assertNull(MiniJson.pathString(root, "a.b.c"))
        assertNull(MiniJson.pathString(root, "x.9.y"))
    }

    @Test
    fun escapesRoundTrip() {
        val original = mapOf("k" to "quote \" backslash \\ newline \n tab \t unicode é")
        val text = MiniJson.write(original)
        val back = MiniJson.parse(text) as Map<*, *>
        assertEquals(original["k"], back["k"])
    }

    @Test
    fun wholeNumbersWriteWithoutADecimalPoint() {
        assertEquals("""{"n":16000}""", MiniJson.write(mapOf("n" to 16000.0)))
    }

    @Test
    fun malformedInputIsRejectedNotGuessed() {
        assertNull(MiniJson.parseOrNull("""{"a":1,}"""))
        assertNull(MiniJson.parseOrNull("""{a:1}"""))
        assertNull(MiniJson.parseOrNull("""{"a":1"""))
        assertNull(MiniJson.parseOrNull("""not json at all"""))
        assertTrue(MiniJson.parseOrNull("""{"a":1}""") is Map<*, *>)
    }
}
