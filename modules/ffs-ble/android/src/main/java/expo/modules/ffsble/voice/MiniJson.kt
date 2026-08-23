package expo.modules.ffsble.voice

/**
 * A small hand-rolled JSON reader/writer.
 *
 * WHY NOT `org.json`
 * ------------------
 * `org.json.JSONObject` ships with Android, but under a plain-JVM unit test it is a stub whose
 * every method throws `RuntimeException("Stub!")`. The S-VOICE transcription seam has to be
 * provable on the desktop JVM -- config round-trip, HTTP response parsing, the durable queue
 * file -- and half of those tests would otherwise need Robolectric purely to read a `{}`.
 * Adding Gson/Moshi to a module that currently has zero runtime dependencies is a worse trade
 * than a couple hundred lines we can read in one sitting. `[proven]` by `SttMiniJsonTest`.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a fast parser and not a lenient one. It rejects trailing commas, NaN and unquoted
 * keys. That strictness is a feature here: a malformed STT response should surface as a clean
 * [SttResult] failure, not as a silently-wrong transcript.
 *
 * VALUE MODEL: `Map<String, Any?>`, `List<Any?>`, `String`, `Double`, `Boolean`, `null`.
 * Every number parses to a [Double] -- JSON has one number type and pretending otherwise
 * invites `1.0` != `1` bugs in config round-trips.
 *
 * MUTATION: none. Parsed trees are read-only by convention.
 *
 * PRIVACY: parsed values may contain transcript text or credentials. Never log a parsed tree.
 */
internal object MiniJson {

    // -- Reading ---------------------------------------------------------------------------

    class JsonException(message: String) : RuntimeException(message)

    /** Parse a complete JSON document. Throws [JsonException] on anything malformed. */
    fun parse(text: String): Any? {
        val p = Parser(text)
        p.skipWs()
        val v = p.readValue()
        p.skipWs()
        if (!p.atEnd()) throw JsonException("trailing data at ${p.pos}")
        return v
    }

    /** Parse, returning null instead of throwing. Use where a bad file must not crash boot. */
    fun parseOrNull(text: String): Any? = try { parse(text) } catch (_: Throwable) { null }

    private class Parser(private val s: String) {
        var pos = 0

        fun atEnd() = pos >= s.length

        fun skipWs() {
            while (pos < s.length && s[pos].isWhitespace()) pos++
        }

        fun readValue(): Any? {
            if (atEnd()) throw JsonException("unexpected end")
            val c = s[pos]
            return when {
                c == '{' -> readObject()
                c == '[' -> readArray()
                c == '"' -> readString()
                c == 't' -> readLiteral("true", true)
                c == 'f' -> readLiteral("false", false)
                c == 'n' -> readLiteral("null", null)
                c == '-' || c.isDigit() -> readNumber()
                else -> throw JsonException("unexpected char at $pos")
            }
        }

        private fun readLiteral(lit: String, value: Any?): Any? {
            if (!s.startsWith(lit, pos)) throw JsonException("bad literal at $pos")
            pos += lit.length
            return value
        }

        private fun readNumber(): Double {
            val start = pos
            if (pos < s.length && s[pos] == '-') pos++
            while (pos < s.length && (s[pos].isDigit() || s[pos] == '.' ||
                        s[pos] == 'e' || s[pos] == 'E' || s[pos] == '+' || s[pos] == '-')) pos++
            return s.substring(start, pos).toDoubleOrNull()
                ?: throw JsonException("bad number at $start")
        }

        fun readString(): String {
            if (atEnd() || s[pos] != '"') throw JsonException("expected string at $pos")
            pos++
            val sb = StringBuilder()
            while (true) {
                if (atEnd()) throw JsonException("unterminated string")
                val c = s[pos]
                if (c == '"') { pos++; return sb.toString() }
                if (c != '\\') { sb.append(c); pos++; continue }
                pos++
                if (atEnd()) throw JsonException("unterminated escape")
                when (s[pos]) {
                    '"' -> sb.append('"')
                    '\\' -> sb.append('\\')
                    '/' -> sb.append('/')
                    'b' -> sb.append('\b')
                    'f' -> sb.append(12.toChar())
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    'u' -> {
                        if (pos + 4 >= s.length) throw JsonException("short unicode escape")
                        val hex = s.substring(pos + 1, pos + 5)
                        val code = hex.toIntOrNull(16) ?: throw JsonException("bad unicode escape")
                        sb.append(code.toChar())
                        pos += 4
                    }
                    else -> throw JsonException("bad escape at $pos")
                }
                pos++
            }
        }

        private fun readObject(): Map<String, Any?> {
            pos++ // consume '{'
            val out = LinkedHashMap<String, Any?>()
            skipWs()
            if (!atEnd() && s[pos] == '}') { pos++; return out }
            while (true) {
                skipWs()
                val k = readString()
                skipWs()
                if (atEnd() || s[pos] != ':') throw JsonException("expected ':' at $pos")
                pos++
                skipWs()
                out[k] = readValue()
                skipWs()
                if (atEnd()) throw JsonException("unterminated object")
                when (s[pos]) {
                    ',' -> pos++
                    '}' -> { pos++; return out }
                    else -> throw JsonException("expected ',' or '}' at $pos")
                }
            }
        }

        private fun readArray(): List<Any?> {
            pos++ // consume '['
            val out = ArrayList<Any?>()
            skipWs()
            if (!atEnd() && s[pos] == ']') { pos++; return out }
            while (true) {
                skipWs()
                out.add(readValue())
                skipWs()
                if (atEnd()) throw JsonException("unterminated array")
                when (s[pos]) {
                    ',' -> pos++
                    ']' -> { pos++; return out }
                    else -> throw JsonException("expected ',' or ']' at $pos")
                }
            }
        }
    }

    // -- Writing ---------------------------------------------------------------------------

    /** Serialise a value tree. Maps keep insertion order, so output is byte-stable. */
    fun write(value: Any?): String = StringBuilder().also { writeTo(it, value) }.toString()

    private fun writeTo(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is String -> writeString(sb, v)
            is Boolean -> sb.append(if (v) "true" else "false")
            is Int, is Long -> sb.append(v.toString())
            is Double -> {
                // A whole Double writes as `3`, not `3.0`, so a round-tripped sample rate or
                // timeout still reads as an integer to anything else that opens the file.
                if (v.isNaN() || v.isInfinite()) sb.append("null")
                else if (v == Math.floor(v) && Math.abs(v) < 1e15) sb.append(v.toLong().toString())
                else sb.append(v.toString())
            }
            is Number -> sb.append(v.toString())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, item) in v) {
                    if (!first) sb.append(',')
                    first = false
                    writeString(sb, k.toString())
                    sb.append(':')
                    writeTo(sb, item)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (item in v) {
                    if (!first) sb.append(',')
                    first = false
                    writeTo(sb, item)
                }
                sb.append(']')
            }
            else -> writeString(sb, v.toString())
        }
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        sb.append('"')
    }

    // -- Path lookup -----------------------------------------------------------------------

    /**
     * Resolve a dotted/indexed path such as `results.0.alternatives.0.transcript` against a
     * parsed tree. A numeric segment indexes a list; anything else keys a map. Returns null
     * for any miss rather than throwing -- "the provider answered in a shape we did not
     * expect" is a normal [SttResult] failure, not an exception.
     *
     * This is the ONLY provider-specific knowledge the HTTP client has, and it lives in
     * config rather than in code. That is the entire point of the seam.
     */
    fun path(root: Any?, path: String): Any? {
        if (path.isBlank()) return root
        var cur = root
        for (seg in path.split('.')) {
            if (seg.isEmpty()) continue
            val node = cur
            cur = when (node) {
                is List<*> -> {
                    val i = seg.toIntOrNull() ?: return null
                    if (i < 0 || i >= node.size) return null else node[i]
                }
                is Map<*, *> -> node[seg]
                else -> return null
            }
        }
        return cur
    }

    /** [path], coerced to a String. Numbers and booleans stringify; maps/lists yield null. */
    fun pathString(root: Any?, path: String): String? = when (val v = path(root, path)) {
        null -> null
        is String -> v
        is Double -> if (v == Math.floor(v)) v.toLong().toString() else v.toString()
        is Boolean -> v.toString()
        else -> null
    }

    /** [path], coerced to a Double. */
    fun pathDouble(root: Any?, path: String): Double? = when (val v = path(root, path)) {
        is Double -> v
        is String -> v.toDoubleOrNull()
        else -> null
    }

    /** Convenience: read a String field off a parsed object, with a default. */
    fun str(map: Map<*, *>?, key: String, def: String): String =
        (map?.get(key) as? String) ?: def

    /** Convenience: read an Int field off a parsed object, with a default. */
    fun int(map: Map<*, *>?, key: String, def: Int): Int = when (val v = map?.get(key)) {
        is Double -> v.toInt()
        is Number -> v.toInt()
        is String -> v.toIntOrNull() ?: def
        else -> def
    }

    /** Convenience: read a Long field off a parsed object, with a default. */
    fun long(map: Map<*, *>?, key: String, def: Long): Long = when (val v = map?.get(key)) {
        is Double -> v.toLong()
        is Number -> v.toLong()
        is String -> v.toLongOrNull() ?: def
        else -> def
    }

    /** Convenience: read a `Map<String,String>` field, dropping non-string entries. */
    fun strMap(map: Map<*, *>?, key: String): LinkedHashMap<String, String> {
        val out = LinkedHashMap<String, String>()
        val v = map?.get(key) as? Map<*, *> ?: return out
        for ((k, item) in v) {
            if (k is String && item != null) out[k] = item as? String ?: item.toString()
        }
        return out
    }
}
