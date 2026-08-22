package expo.modules.ffsnotify

import android.content.ComponentName
import android.content.Context
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.SystemClock

/**
 * MediaHub — now-playing + transport control, read from the phone's active media sessions.
 *
 * ── PROVENANCE (MIT — attribution required) ──────────────────────────────────────────────────
 * Ported from **takemotions-media-bridge** (`MediaHub.kt`), MIT-licensed:
 *
 *     takemotions-media-bridge — Copyright (c) r-tkbyc — MIT License
 *     https://github.com/r-tkbyc/takemotions-media-bridge
 *
 * The technique — `MediaSessionManager.getActiveSessions(listenerComponent)` behind an (otherwise
 * empty) NotificationListenerService, `MediaController` for metadata + transport controls — is
 * that project's. Our re-expression keeps this native side a THIN surface over the framework: it
 * emits the raw `PlaybackState`/`MediaMetadata` fields and applies transport commands. The three
 * fixes media-bridge is valued for (playhead projection, paused-vs-dead selection, seek de-dup)
 * live as pure, tested functions in `src/data/sources/media.ts`, so the interpretation is testable
 * off-device.
 *
 * ── WHY IT LIVES IN ffs-notify ───────────────────────────────────────────────────────────────
 * Reading active media sessions requires an enabled NotificationListenerService component name —
 * the same grant `FfsNotificationListener` already holds. One listener, several readers.
 *
 * ⛔ NO LOGGING. A track title/artist is content; `src/data/__tests__/media.test.ts` fails if this
 *    file gains a Log/println call. Metadata leaves only through the explicit pull below.
 */
object MediaHub {

    /** Sessions WE last touched (elapsedRealtime), so a track the wearer paused reads as recent. */
    private val touchedAt = HashMap<String, Long>()

    private fun manager(ctx: Context): MediaSessionManager? =
        ctx.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager

    private fun listenerComponent(ctx: Context) =
        ComponentName(ctx, FfsNotificationListener::class.java)

    private fun controllers(ctx: Context): List<MediaController> = try {
        manager(ctx)?.getActiveSessions(listenerComponent(ctx)) ?: emptyList()
    } catch (_: Throwable) {
        // SecurityException when the listener is not enabled, or any transient framework failure.
        emptyList()
    }

    /**
     * One snapshot per active session, raw. The consumer (`media.ts`) decides which is "now
     * playing" and where the playhead really is. `lastActiveMs` folds in the moment we last touched
     * the session so a user-paused track ranks as recent for the paused-vs-dead choice.
     */
    fun sessions(ctx: Context): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        for (c in controllers(ctx)) {
            val pkg = c.packageName ?: continue
            val state: PlaybackState? = c.playbackState
            val meta: MediaMetadata? = c.metadata

            val pbState = state?.state ?: PlaybackState.STATE_NONE
            val position = state?.position ?: 0L
            val lastUpdate = state?.lastPositionUpdateTime ?: 0L
            val speed = state?.playbackSpeed ?: 0f
            val duration = meta?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L

            val touched = touchedAt[pkg] ?: 0L
            val lastActive = maxOf(lastUpdate, touched)

            out.add(
                mapOf(
                    "pkg" to pkg,
                    "title" to (meta?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: ""),
                    "artist" to (meta?.getString(MediaMetadata.METADATA_KEY_ARTIST)
                        ?: meta?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: ""),
                    "album" to (meta?.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: ""),
                    "state" to pbState.toLong(),
                    "positionMs" to position,
                    "lastUpdateMs" to lastUpdate,
                    "speed" to speed.toDouble(),
                    "durationMs" to duration,
                    "lastActiveMs" to lastActive
                )
            )
        }
        return out
    }

    /** The elapsedRealtime clock, so the TS projection uses the SAME basis as `lastUpdateMs`. */
    fun nowElapsedMs(): Long = SystemClock.elapsedRealtime()

    /**
     * Apply a transport control to the session owned by `pkg`. `argMs` is the absolute seek target
     * for action "seek" (the caller computes it with `seekTarget`), ignored otherwise. Returns true
     * if a matching session accepted the command.
     */
    fun control(ctx: Context, pkg: String, action: String, argMs: Long): Boolean {
        val c = controllers(ctx).firstOrNull { it.packageName == pkg } ?: return false
        val t = c.transportControls
        when (action) {
            "play" -> t.play()
            "pause" -> { t.pause(); touchedAt[pkg] = SystemClock.elapsedRealtime() }
            "playpause" -> {
                if (c.playbackState?.state == PlaybackState.STATE_PLAYING) {
                    t.pause(); touchedAt[pkg] = SystemClock.elapsedRealtime()
                } else t.play()
            }
            "next" -> t.skipToNext()
            "prev" -> t.skipToPrevious()
            "seek" -> t.seekTo(argMs)
            else -> return false
        }
        return true
    }
}
