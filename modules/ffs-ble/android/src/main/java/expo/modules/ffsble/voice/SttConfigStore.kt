package expo.modules.ffsble.voice

import java.io.File

/**
 * Where the STT provider configuration lives: ONE JSON file in the app's private storage, at
 * `<filesDir>/voice/stt-config.json`.
 *
 * ⛔ **THE FILE HOLDS A CREDENTIAL.** [SttConfig.headers] is where an API key or bearer token
 * goes, so this file is exactly as sensitive as a password. Three consequences, all enforced
 * here rather than left to callers:
 *
 *   1. It is written under `Context.getFilesDir()`, which is app-private on every Android
 *      version (mode 0700 on the directory) -- NOT external storage, NOT a shared cache dir.
 *   2. [save] additionally calls `setReadable/setWritable(false, false)` then `(true, true)`
 *      to strip group/other bits, because on some older devices a file created with the
 *      default umask inside a private dir is still 0644 within that dir. Belt and braces; the
 *      directory is the real protection. `[hypothesis]` -- the umask behaviour is not verified
 *      on this specific test phone, but the tightening is free.
 *   3. Nothing here ever logs the contents. [describe] returns [SttConfig.redactedSummary].
 *
 * ⛔ **NO PROVIDER IS BAKED IN.** This store NEVER falls back to a constant in source and
 * NEVER reads a bundled asset. If the file is missing or corrupt the effective config is
 * [SttConfig.NONE]: `providerKind=none`, which means **archive but do not transcribe** --
 * audio is still captured and kept, and [SttQueue] holds the work until a provider appears.
 * That is a supported steady state, not a degraded one.
 *
 * THREADING: [load] and [save] are `@Synchronized` on the instance. The settings UI writes on
 * the main thread and the queue worker reads on its own thread, and the whole file is small
 * enough that a lock is cheaper than reasoning about a race.
 *
 * TESTABILITY: the [file] is injected rather than derived from a `Context`, which is what lets
 * `SttConfigStoreTest` run on the plain JVM with a `TemporaryFolder`.
 */
class SttConfigStore(
    /** Absolute path of the JSON file. Use [defaultFile] to derive it from a `Context`. */
    private val file: File,
    /** Optional counts-only log sink. ⛔ Never receives config values. */
    private val log: ((String) -> Unit)? = null
) {

    companion object {
        /** Subdirectory of `filesDir` that the whole voice feature lives under. */
        const val VOICE_DIR = "voice"

        /** Filename. Stable, because a user who pastes a key in wants it to stay put. */
        const val FILE_NAME = "stt-config.json"

        /**
         * The production path: `<context.filesDir>/voice/stt-config.json`.
         *
         * Takes the `File` rather than a `Context` on purpose: this module's unit tests run
         * without an Android runtime, and a `Context` in the signature would drag one into
         * every plain-JVM test that merely constructs a store. Call site does
         * `SttConfigStore(SttConfigStore.defaultFile(context.filesDir))`.
         */
        @JvmStatic
        fun defaultFile(filesDir: File): File = File(File(filesDir, VOICE_DIR), FILE_NAME)
    }

    /** Cached last-loaded value, so the queue worker does not re-read the file per item. */
    private var cached: SttConfig? = null

    /**
     * Read the configuration. Returns [SttConfig.NONE] when the file is absent, unreadable or
     * malformed -- a corrupt config must never crash the app or, worse, cause audio to be
     * dropped. The bad file is LEFT IN PLACE for inspection; nothing here deletes anything.
     */
    @Synchronized
    fun load(): SttConfig {
        cached?.let { return it }
        val cfg = try {
            if (!file.exists()) SttConfig.NONE else SttConfig.fromJson(file.readText(Charsets.UTF_8))
        } catch (t: Throwable) {
            // ⛔ Log the CLASS of failure, never the file contents.
            log?.invoke("stt-config: unreadable (${t.javaClass.simpleName}); staying in 'none'")
            SttConfig.NONE
        }
        cached = cfg
        return cfg
    }

    /**
     * Persist a configuration, creating `<filesDir>/voice/` if needed.
     *
     * Written via a `.tmp` sibling and `renameTo`, so a kill mid-write cannot leave a
     * half-written credential file that then reads as `none` and silently stops transcription.
     */
    @Synchronized
    fun save(config: SttConfig) {
        file.parentFile?.let { dir ->
            if (!dir.exists()) dir.mkdirs()
            // App-private already; narrow it anyway.
            @Suppress("ResultOfMethodCallIgnored") dir.setReadable(false, false)
            @Suppress("ResultOfMethodCallIgnored") dir.setReadable(true, true)
            @Suppress("ResultOfMethodCallIgnored") dir.setExecutable(false, false)
            @Suppress("ResultOfMethodCallIgnored") dir.setExecutable(true, true)
        }
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(config.toJson(), Charsets.UTF_8)
        @Suppress("ResultOfMethodCallIgnored") tmp.setReadable(false, false)
        @Suppress("ResultOfMethodCallIgnored") tmp.setReadable(true, true)
        @Suppress("ResultOfMethodCallIgnored") tmp.setWritable(false, false)
        @Suppress("ResultOfMethodCallIgnored") tmp.setWritable(true, true)
        if (file.exists()) @Suppress("ResultOfMethodCallIgnored") file.delete()
        if (!tmp.renameTo(file)) {
            // Rename across the same directory should never fail; fall back rather than lose
            // the user's key.
            file.writeText(config.toJson(), Charsets.UTF_8)
            @Suppress("ResultOfMethodCallIgnored") tmp.delete()
        }
        cached = config
        log?.invoke("stt-config: saved (${config.redactedSummary()})")
    }

    /**
     * Forget the provider. This is the only removal path, it is user-invoked, and it deletes
     * the CONFIG only -- never audio, never transcripts.
     */
    @Synchronized
    fun clear() {
        if (file.exists()) @Suppress("ResultOfMethodCallIgnored") file.delete()
        cached = SttConfig.NONE
        log?.invoke("stt-config: cleared; back to 'none' (audio still archived)")
    }

    /** Drop the in-memory cache so the next [load] re-reads the file. */
    @Synchronized
    fun invalidate() { cached = null }

    /** True when a usable provider is configured. */
    fun isConfigured(): Boolean = load().isUsable()

    /** Safe-to-log one-liner. */
    fun describe(): String = load().redactedSummary()
}
