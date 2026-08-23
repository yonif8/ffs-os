package expo.modules.ffsble.voice

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * The permanent, searchable half of the S-VOICE archive: sessions, transcript segments, and a
 * full-text index over the text.
 *
 * ⛔ **NOTHING IS EVER DELETED, EVICTED OR EXPIRED.** There is no retention policy here, no
 * TTL, no row cap, no vacuum-by-age, and no code path that issues a `DELETE` other than
 * [deleteSessionByUserRequest], which exists solely so a human can remove one session they
 * chose. That is the whole point of the feature: the value of an archive of everything you
 * heard is that it is an archive of EVERYTHING you heard. A background policy that quietly
 * drops last spring is a bug, not a housekeeping nicety. If size ever becomes a problem, the
 * answer is a bigger card or an explicit export, never an automatic trim.
 *
 * WHY SQLite + FTS4 AND NOT A FILE SCAN, LUCENE, OR FTS5
 * ------------------------------------------------------
 * * **Not a file scan.** "Find the sentence" over years of speech has to be an index lookup;
 *   grepping a growing pile of JSON gets slower exactly as the archive gets more valuable.
 * * **Not an embedded search library.** SQLite with FTS is already on every Android device.
 *   Zero dependencies, zero APK weight, and `snippet()` gives us highlighted context for free.
 * * **FTS4, not FTS5.** `[mapped]` FTS5 was compiled into Android's bundled SQLite only from
 *   API 30 or so onward, and even then availability has historically varied by OEM build;
 *   FTS4 has been present since API 11 and is not going anywhere. The feature set we need --
 *   `MATCH`, prefix queries, `snippet()`, `offsets()` -- is in both. Choosing FTS4 costs some
 *   ranking sophistication we do not use and buys "it works on whatever the phone has".
 *   ⚠️ `[hypothesis]` on this specific test phone; the fallback if FTS4 were ever missing is a
 *   `LIKE` scan, which we deliberately have NOT written, because a silent downgrade to a
 *   different matching semantics is worse than a loud failure.
 * * **Not a contentless/external-content FTS table.** A plain FTS4 table duplicates the text.
 *   That doubles the smallest part of the archive (text, next to audio) in exchange for
 *   `snippet()` working without a join back to the content table and for the index surviving
 *   a schema change to `segments`. Worth it.
 *
 * SYNC STRATEGY: **explicit writes, not triggers.** Every mutation of `segments` goes through
 * [addSegment], which writes both tables inside one transaction. Triggers would be fewer lines
 * but they hide the coupling from anyone reading [addSegment], and an FTS row that silently
 * failed to be written is invisible until a search comes back empty -- the exact failure mode
 * this class exists to prevent.
 *
 * QUERY SAFETY: [search] passes the user's string as a BOUND ARGUMENT to `MATCH` (so there is
 * no SQL injection surface) after [sanitizeMatchQuery] strips the FTS meta-characters that
 * would otherwise make a perfectly reasonable human query -- one with an apostrophe, a quote
 * or a stray `*` -- throw `SQLiteException: malformed MATCH expression`. Proven by
 * `TranscriptIndexSearchTest`.
 *
 * THREADING: `SQLiteDatabase` is internally synchronised, and the writers here are single-
 * threaded in practice (the [SttQueue] worker). Reads may come from the UI thread.
 */
class SqliteTranscriptIndex(
    context: Context,
    /** Database filename, or null for an in-memory database (tests). */
    dbName: String? = DB_NAME
) : SQLiteOpenHelper(context, dbName, null, DB_VERSION), TranscriptIndex {

    companion object {
        const val DB_NAME = "voice-archive.db"

        /**
         * v1. ⚠️ When this changes, [onUpgrade] must MIGRATE, never `DROP` -- the tables hold
         * the only copy of the transcripts.
         */
        const val DB_VERSION = 1

        const val T_SESSIONS = "sessions"
        const val T_SEGMENTS = "segments"
        const val T_FTS = "segments_fts"

        /**
         * Characters that mean something to the FTS4 query parser. A human typing a search box
         * has no idea about any of them, so they are turned into spaces rather than escaped:
         * the intent of `"don't"` is the two tokens, and matching those is right.
         */
        private val FTS_META = charArrayOf(
            '"', '\'', '*', ':', '(', ')', '^', '-', '{', '}', '[', ']', ',', ';', '\\', '/'
        )
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $T_SESSIONS (
              id           TEXT PRIMARY KEY,
              started_at   INTEGER NOT NULL,
              ended_at     INTEGER,
              master_path  TEXT NOT NULL,
              packets      INTEGER NOT NULL DEFAULT 0,
              duration_ms  INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            CREATE TABLE $T_SEGMENTS (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id  TEXT NOT NULL,
              start_ms    INTEGER NOT NULL,
              end_ms      INTEGER NOT NULL,
              text        TEXT NOT NULL,
              confidence  REAL,
              provider    TEXT NOT NULL,
              created_at  INTEGER NOT NULL
            )
            """.trimIndent()
        )
        // Search results are ordered by session time, and segments are always listed per
        // session, so both access paths get an index.
        db.execSQL("CREATE INDEX idx_seg_session ON $T_SEGMENTS(session_id, start_ms)")
        db.execSQL("CREATE INDEX idx_sess_started ON $T_SESSIONS(started_at DESC)")
        // `docid` is set explicitly to the segment id, which is what lets a MATCH result join
        // straight back to its segment row with no extra column.
        db.execSQL("CREATE VIRTUAL TABLE $T_FTS USING fts4(text)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // ⛔ Intentionally a no-op placeholder. Any future migration ADDS columns/tables.
        // Dropping and recreating would destroy the archive, which is the one thing this
        // class must never do.
    }

    // -- sessions ------------------------------------------------------------------------------

    override fun upsertSession(session: VoiceSession) {
        writableDatabase.execSQL(
            "INSERT OR REPLACE INTO $T_SESSIONS " +
                "(id, started_at, ended_at, master_path, packets, duration_ms) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
            arrayOf(
                session.id, session.startedAtEpochMs, session.endedAtEpochMs,
                session.masterPath, session.packets, session.durationMs
            )
        )
    }

    override fun listSessions(limit: Int): List<VoiceSession> {
        val out = ArrayList<VoiceSession>()
        readableDatabase.rawQuery(
            "SELECT id, started_at, ended_at, master_path, packets, duration_ms " +
                "FROM $T_SESSIONS ORDER BY started_at DESC LIMIT ?",
            arrayOf(limit.toString())
        ).use { c -> while (c.moveToNext()) out.add(readSession(c)) }
        return out
    }

    override fun getSession(id: String): VoiceSession? {
        readableDatabase.rawQuery(
            "SELECT id, started_at, ended_at, master_path, packets, duration_ms " +
                "FROM $T_SESSIONS WHERE id = ?",
            arrayOf(id)
        ).use { c -> return if (c.moveToNext()) readSession(c) else null }
    }

    private fun readSession(c: Cursor) = VoiceSession(
        id = c.getString(0),
        startedAtEpochMs = c.getLong(1),
        endedAtEpochMs = if (c.isNull(2)) null else c.getLong(2),
        masterPath = c.getString(3),
        packets = c.getInt(4),
        durationMs = c.getLong(5)
    )

    // -- segments ------------------------------------------------------------------------------

    /**
     * Write one transcribed span and its FTS row, in ONE transaction. If the FTS insert fails
     * the segment insert rolls back with it -- an unsearchable transcript is a lost transcript,
     * so it is better to fail the queue item (which then retries, keeping the audio) than to
     * end up with a row nobody can ever find.
     */
    override fun addSegment(
        sessionId: String,
        startMs: Long,
        endMs: Long,
        text: String,
        confidence: Double?,
        provider: String
    ): Long {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val stmt = db.compileStatement(
                "INSERT INTO $T_SEGMENTS " +
                    "(session_id, start_ms, end_ms, text, confidence, provider, created_at) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
            stmt.bindString(1, sessionId)
            stmt.bindLong(2, startMs)
            stmt.bindLong(3, endMs)
            stmt.bindString(4, text)
            if (confidence == null) stmt.bindNull(5) else stmt.bindDouble(5, confidence)
            stmt.bindString(6, provider)
            stmt.bindLong(7, System.currentTimeMillis())
            val id = stmt.executeInsert()
            stmt.close()

            // docid == segment id: the MATCH result joins straight back with no extra column.
            db.execSQL(
                "INSERT INTO $T_FTS (docid, text) VALUES (?, ?)",
                arrayOf<Any>(id, text)
            )
            db.setTransactionSuccessful()
            return id
        } finally {
            db.endTransaction()
        }
    }

    override fun segmentsOf(sessionId: String): List<VoiceSegment> {
        val out = ArrayList<VoiceSegment>()
        readableDatabase.rawQuery(
            "SELECT id, session_id, start_ms, end_ms, text, confidence, provider, created_at " +
                "FROM $T_SEGMENTS WHERE session_id = ? ORDER BY start_ms ASC",
            arrayOf(sessionId)
        ).use { c -> while (c.moveToNext()) out.add(readSegment(c)) }
        return out
    }

    private fun readSegment(c: Cursor) = VoiceSegment(
        id = c.getLong(0),
        sessionId = c.getString(1),
        startMs = c.getLong(2),
        endMs = c.getLong(3),
        text = c.getString(4),
        confidence = if (c.isNull(5)) null else c.getDouble(5),
        provider = c.getString(6),
        createdAtEpochMs = c.getLong(7)
    )

    // -- search --------------------------------------------------------------------------------

    /**
     * Full-text search, newest session first.
     *
     * `snippet(segments_fts, '[', ']', '...')` gives the matched terms wrapped in square
     * brackets exactly as [VoiceSearchHit.snippet] specifies, with elision around long text.
     *
     * A query that sanitises down to nothing (all punctuation, or empty) returns an empty list
     * rather than matching everything -- "search for `***`" meaning "show me my entire life"
     * is not what anyone intended.
     */
    override fun search(query: String, limit: Int): List<VoiceSearchHit> {
        val match = sanitizeMatchQuery(query)
        if (match.isEmpty()) return emptyList()
        val out = ArrayList<VoiceSearchHit>()
        try {
            readableDatabase.rawQuery(
                "SELECT s.id, s.session_id, s.start_ms, s.end_ms, s.text, s.confidence, " +
                    "       s.provider, s.created_at, " +
                    // ⚠️ snippet()'s first argument must be the FTS table AS NAMED IN THIS
                    // QUERY, so the FTS table deliberately carries no alias.
                    "       snippet($T_FTS, '[', ']', '...'), sess.started_at " +
                    "FROM $T_FTS " +
                    "JOIN $T_SEGMENTS s ON s.id = $T_FTS.docid " +
                    "LEFT JOIN $T_SESSIONS sess ON sess.id = s.session_id " +
                    "WHERE $T_FTS MATCH ? " +
                    "ORDER BY sess.started_at DESC, s.start_ms ASC " +
                    "LIMIT ?",
                arrayOf(match, limit.toString())
            ).use { c ->
                while (c.moveToNext()) {
                    out.add(
                        VoiceSearchHit(
                            segment = readSegment(c),
                            snippet = if (c.isNull(8)) c.getString(4) else c.getString(8),
                            sessionStartedAtEpochMs = if (c.isNull(9)) 0L else c.getLong(9)
                        )
                    )
                }
            }
        } catch (t: android.database.sqlite.SQLiteException) {
            // ⛔ A malformed MATCH must not crash the app. Sanitising should have prevented
            // this; if it did not, that is a bug to fix, not a reason to lose the screen.
            return emptyList()
        }
        return out
    }

    /**
     * Turn arbitrary human input into something FTS4's parser accepts.
     *
     * The whole point is that the caller may pass a raw search box value containing quotes,
     * apostrophes, `*`, `-`, `(` or a stray `:`; any of those can make FTS4 throw. We replace
     * the meta-characters with spaces and join the surviving tokens with `AND`, which gives
     * the "all of these words" behaviour a search box implies. Bound as a parameter regardless,
     * so even if this function were wrong there is no injection surface.
     *
     * ⚠️ TRADE-OFF: this drops FTS4's phrase (`"..."`) and prefix (`foo*`) syntax. That is
     * deliberate for v1 -- a search that never throws beats a search with a query language
     * nobody was told about. If phrase search is wanted later it should be a separate,
     * explicitly-invoked mode, not a punctuation side effect.
     */
    internal fun sanitizeMatchQuery(query: String): String {
        val sb = StringBuilder(query.length)
        for (c in query) sb.append(if (FTS_META.contains(c)) ' ' else c)
        val tokens = sb.toString().split(' ', '\t', '\n', '\r')
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.equals("AND", true) && !it.equals("OR", true) &&
                      !it.equals("NOT", true) && !it.equals("NEAR", true) }
        if (tokens.isEmpty()) return ""
        return tokens.joinToString(" AND ")
    }

    // -- stats / removal -----------------------------------------------------------------------

    /**
     * `sessions`, `segments` and `words` counts. Counts only, so this is the one thing about
     * the archive that is safe to log or show on a status screen.
     *
     * `words` is computed by summing over the segments rather than kept as a counter, because
     * a counter that drifts is worse than a query that takes a moment; the archive is small
     * enough in rows (one row per utterance) for this to be fine for a long time.
     */
    override fun stats(): Map<String, Long> {
        val db = readableDatabase
        fun scalar(sql: String): Long =
            db.rawQuery(sql, null).use { c -> if (c.moveToNext() && !c.isNull(0)) c.getLong(0) else 0L }

        val words = db.rawQuery("SELECT text FROM $T_SEGMENTS", null).use { c ->
            var n = 0L
            while (c.moveToNext()) {
                n += c.getString(0).split(' ', '\t', '\n').count { it.isNotBlank() }
            }
            n
        }
        return linkedMapOf(
            "sessions" to scalar("SELECT COUNT(*) FROM $T_SESSIONS"),
            "segments" to scalar("SELECT COUNT(*) FROM $T_SEGMENTS"),
            "words" to words,
            "mockSegments" to scalar(
                "SELECT COUNT(*) FROM $T_SEGMENTS WHERE provider = '${MockSttProvider.NAME}'"
            )
        )
    }

    /**
     * The ONLY delete path in this class, and it is named so that it cannot be called by
     * accident from a cleanup routine. Removes one session's rows and its FTS entries.
     *
     * ⛔ Call this only in direct response to a user action on that specific session. It does
     * NOT touch the audio files; deleting those is the archive layer's business and is
     * likewise user-invoked only.
     */
    fun deleteSessionByUserRequest(sessionId: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.execSQL(
                "DELETE FROM $T_FTS WHERE docid IN " +
                    "(SELECT id FROM $T_SEGMENTS WHERE session_id = ?)",
                arrayOf(sessionId)
            )
            db.execSQL("DELETE FROM $T_SEGMENTS WHERE session_id = ?", arrayOf(sessionId))
            db.execSQL("DELETE FROM $T_SESSIONS WHERE id = ?", arrayOf(sessionId))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /**
     * [TranscriptIndex] is `Closeable` and [SQLiteOpenHelper] has its own `close()`, so Kotlin
     * requires this disambiguation. The helper's implementation is the right one.
     */
    override fun close() { super<SQLiteOpenHelper>.close() }
}
