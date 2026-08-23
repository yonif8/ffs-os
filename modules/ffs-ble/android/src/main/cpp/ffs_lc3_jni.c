/*
 * ffs_lc3_jni.c — JNI shim over google/liblc3 for the FFS Glasses S-VOICE pipeline.
 *
 * The vendored liblc3 under third_party/ is Apache-2.0, Copyright 2022 Google LLC
 * (see third_party/liblc3/LICENSE). This shim is original FFS Glasses code.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS IS
 *
 * The glasses notify 205-byte microphone packets:
 *
 *     [0  ..199]  FIVE 40-byte LC3 frames — 16 kHz mono, 10 ms each
 *     [200..201]  ssr   int16 LE
 *     [202..203]  tdoa  int16 LE
 *     [204]       counter u8
 *
 * The 200 bytes are NOT one LC3 frame. They are five frames pushed through ONE persistent
 * decoder. This shim therefore exposes a *per-frame* decode call and leaves framing to Kotlin
 * (VoiceFramer), so there is exactly one place that can get the framing wrong.
 *
 * PRIVACY, STRUCTURALLY: this file NEVER logs a buffer. Not a byte of LC3, not a PCM sample, not
 * a length-plus-hexdump "just for debugging". These packets are a recording of the wearer. Only
 * integer status codes ever leave this file, as return values.
 *
 * ---------------------------------------------------------------------------------------------
 * LIFETIME / MEMORY
 *
 * liblc3 is static-allocation only: lc3_{decoder,encoder}_size() says how much pointer-aligned
 * memory the codec needs, lc3_setup_{decoder,encoder}() places the codec inside it, and there is
 * NO free function — the caller frees its own malloc. We wrap that memory in a small handle
 * struct so the Java side gets one opaque jlong, and so a stale/garbage pointer is caught by a
 * magic word instead of by a segfault.
 *
 * RETURN CODES
 *   >= 0  liblc3's own result:  0 = decoded/encoded, 1 = PLC operated (VALID AUDIO, not an error)
 *   < 0   this shim's own errors, see FFS_LC3_E_* below. liblc3's own -1 is normalised to
 *         FFS_LC3_E_CODEC so it can never be confused with a shim error.
 */

#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lc3.h"

/* --- error codes (all negative; kept in sync with NativeLc3Decoder.kt) --------------------- */
#define FFS_LC3_E_HANDLE   (-10)  /* null / stale / wrong-kind handle                          */
#define FFS_LC3_E_ARGS     (-11)  /* null array, negative offset/length, bad frame size         */
#define FFS_LC3_E_BOUNDS   (-12)  /* offset+length would run past the end of a Java array       */
#define FFS_LC3_E_CODEC    (-14)  /* liblc3 itself rejected the call                            */

/* Largest PCM frame liblc3 can produce: 10 ms @ 48 kHz. We only use 160 (10 ms @ 16 kHz), but
 * sizing for the worst case keeps the stack buffers honest if the format ever changes. */
#define FFS_LC3_MAX_SAMPLES 480
/* Largest LC3 frame liblc3 accepts. */
#define FFS_LC3_MAX_BYTES   400

#define FFS_LC3_MAGIC_DEC 0x4C433344u /* "LC3D" */
#define FFS_LC3_MAGIC_ENC 0x4C433345u /* "LC3E" */

typedef struct {
    uint32_t magic;
    void    *mem;      /* the malloc'd codec arena — ours to free, liblc3 has no free()        */
    int      dt_us;
    int      sr_hz;
    int      samples;  /* lc3_frame_samples(dt_us, sr_hz) — cached for bounds checks           */
    union {
        lc3_decoder_t dec;
        lc3_encoder_t enc;
    } h;
} ffs_lc3_ctx;

static ffs_lc3_ctx *ctx_of(jlong ptr, uint32_t magic)
{
    ffs_lc3_ctx *c = (ffs_lc3_ctx *)(intptr_t)ptr;
    if (c == NULL || c->magic != magic)
        return NULL;
    return c;
}

/* Checks that off/len describe a real, in-bounds window of a Java array of arrayLen elements.
 * Written to be immune to signed overflow: no (off + len) is ever computed. */
static int window_ok(jint arrayLen, jint off, jint len)
{
    if (off < 0 || len < 0)   return 0;
    if (off > arrayLen)       return 0;
    if (len > arrayLen - off) return 0;
    return 1;
}

/* --- open / close ------------------------------------------------------------------------- */

static jlong open_codec(int sampleRate, int frameUs, int isEncoder)
{
    ffs_lc3_ctx *c;
    unsigned     need;
    int          samples;

    samples = lc3_frame_samples(frameUs, sampleRate);
    if (samples <= 0 || samples > FFS_LC3_MAX_SAMPLES)
        return 0;

    need = isEncoder ? lc3_encoder_size(frameUs, sampleRate)
                     : lc3_decoder_size(frameUs, sampleRate);
    if (need == 0)
        return 0;

    c = (ffs_lc3_ctx *)calloc(1, sizeof(*c));
    if (c == NULL)
        return 0;

    /* malloc is aligned for any fundamental type, which satisfies liblc3's "aligned to pointer
     * type" requirement for the codec arena. */
    c->mem = malloc(need);
    if (c->mem == NULL) {
        free(c);
        return 0;
    }

    if (isEncoder) {
        c->h.enc = lc3_setup_encoder(frameUs, sampleRate, 0, c->mem);
        if (c->h.enc == NULL) { free(c->mem); free(c); return 0; }
        c->magic = FFS_LC3_MAGIC_ENC;
    } else {
        c->h.dec = lc3_setup_decoder(frameUs, sampleRate, 0, c->mem);
        if (c->h.dec == NULL) { free(c->mem); free(c); return 0; }
        c->magic = FFS_LC3_MAGIC_DEC;
    }

    c->dt_us   = frameUs;
    c->sr_hz   = sampleRate;
    c->samples = samples;
    return (jlong)(intptr_t)c;
}

static void close_codec(jlong ptr, uint32_t magic)
{
    ffs_lc3_ctx *c = ctx_of(ptr, magic);
    if (c == NULL)
        return;
    c->magic = 0;          /* poison first: a double close now fails the magic check           */
    free(c->mem);
    c->mem = NULL;
    free(c);
}

JNIEXPORT jlong JNICALL
Java_expo_modules_ffsble_voice_NativeLc3Decoder_nativeOpenDecoder(
        JNIEnv *env, jclass clazz, jint sampleRate, jint frameUs)
{
    (void)env; (void)clazz;
    return open_codec((int)sampleRate, (int)frameUs, 0);
}

JNIEXPORT void JNICALL
Java_expo_modules_ffsble_voice_NativeLc3Decoder_nativeCloseDecoder(
        JNIEnv *env, jclass clazz, jlong ptr)
{
    (void)env; (void)clazz;
    close_codec(ptr, FFS_LC3_MAGIC_DEC);
}

JNIEXPORT jlong JNICALL
Java_expo_modules_ffsble_voice_NativeLc3Decoder_nativeOpenEncoder(
        JNIEnv *env, jclass clazz, jint sampleRate, jint frameUs)
{
    (void)env; (void)clazz;
    return open_codec((int)sampleRate, (int)frameUs, 1);
}

JNIEXPORT void JNICALL
Java_expo_modules_ffsble_voice_NativeLc3Decoder_nativeCloseEncoder(
        JNIEnv *env, jclass clazz, jlong ptr)
{
    (void)env; (void)clazz;
    close_codec(ptr, FFS_LC3_MAGIC_ENC);
}

/* --- decode one frame --------------------------------------------------------------------- */

JNIEXPORT jint JNICALL
Java_expo_modules_ffsble_voice_NativeLc3Decoder_nativeDecodeFrame(
        JNIEnv *env, jclass clazz, jlong ptr,
        jbyteArray src, jint off, jint len,
        jshortArray out, jint outOff)
{
    ffs_lc3_ctx *c = ctx_of(ptr, FFS_LC3_MAGIC_DEC);
    uint8_t  in[FFS_LC3_MAX_BYTES];
    int16_t  pcm[FFS_LC3_MAX_SAMPLES];
    jint     srcLen, outLen;
    int      rc;

    (void)clazz;
    if (c == NULL)                           return FFS_LC3_E_HANDLE;
    if (src == NULL || out == NULL)          return FFS_LC3_E_ARGS;
    if (len <= 0 || len > FFS_LC3_MAX_BYTES) return FFS_LC3_E_ARGS;

    srcLen = (*env)->GetArrayLength(env, src);
    outLen = (*env)->GetArrayLength(env, out);
    if (!window_ok(srcLen, off, len))           return FFS_LC3_E_BOUNDS;
    if (!window_ok(outLen, outOff, c->samples)) return FFS_LC3_E_BOUNDS;

    (*env)->GetByteArrayRegion(env, src, off, len, (jbyte *)in);
    if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); return FFS_LC3_E_BOUNDS; }

    rc = lc3_decode(c->h.dec, in, (int)len, LC3_PCM_FORMAT_S16, pcm, 1);
    if (rc < 0)
        return FFS_LC3_E_CODEC;

    (*env)->SetShortArrayRegion(env, out, outOff, c->samples, (const jshort *)pcm);
    if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); return FFS_LC3_E_BOUNDS; }

    return (jint)rc; /* 0 = decoded, 1 = PLC operated (still valid audio) */
}

/* --- packet-loss concealment for one lost frame -------------------------------------------- */

JNIEXPORT jint JNICALL
Java_expo_modules_ffsble_voice_NativeLc3Decoder_nativeConceal(
        JNIEnv *env, jclass clazz, jlong ptr, jshortArray out, jint outOff)
{
    ffs_lc3_ctx *c = ctx_of(ptr, FFS_LC3_MAGIC_DEC);
    int16_t pcm[FFS_LC3_MAX_SAMPLES];
    jint    outLen;
    int     rc;

    (void)clazz;
    if (c == NULL)   return FFS_LC3_E_HANDLE;
    if (out == NULL) return FFS_LC3_E_ARGS;

    outLen = (*env)->GetArrayLength(env, out);
    if (!window_ok(outLen, outOff, c->samples)) return FFS_LC3_E_BOUNDS;

    /* NULL input + 0 length is liblc3's documented "this frame was lost, conceal it" call. It
     * only produces sensible audio because the decoder is persistent and still holds the state
     * left by the frames that DID arrive. */
    rc = lc3_decode(c->h.dec, NULL, 0, LC3_PCM_FORMAT_S16, pcm, 1);
    if (rc < 0)
        return FFS_LC3_E_CODEC;

    (*env)->SetShortArrayRegion(env, out, outOff, c->samples, (const jshort *)pcm);
    if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); return FFS_LC3_E_BOUNDS; }

    return (jint)rc; /* normally 1 */
}

/* --- encode one frame (fixture / on-device self-test only) --------------------------------- */

JNIEXPORT jint JNICALL
Java_expo_modules_ffsble_voice_NativeLc3Decoder_nativeEncodeFrame(
        JNIEnv *env, jclass clazz, jlong ptr,
        jshortArray pcm, jint pcmOff, jint frameBytes,
        jbyteArray out, jint outOff)
{
    ffs_lc3_ctx *c = ctx_of(ptr, FFS_LC3_MAGIC_ENC);
    int16_t in[FFS_LC3_MAX_SAMPLES];
    uint8_t buf[FFS_LC3_MAX_BYTES];
    jint    pcmLen, outLen;
    int     rc;

    (void)clazz;
    if (c == NULL)                  return FFS_LC3_E_HANDLE;
    if (pcm == NULL || out == NULL) return FFS_LC3_E_ARGS;
    if (frameBytes < 20 || frameBytes > FFS_LC3_MAX_BYTES) return FFS_LC3_E_ARGS;

    pcmLen = (*env)->GetArrayLength(env, pcm);
    outLen = (*env)->GetArrayLength(env, out);
    if (!window_ok(pcmLen, pcmOff, c->samples)) return FFS_LC3_E_BOUNDS;
    if (!window_ok(outLen, outOff, frameBytes)) return FFS_LC3_E_BOUNDS;

    (*env)->GetShortArrayRegion(env, pcm, pcmOff, c->samples, (jshort *)in);
    if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); return FFS_LC3_E_BOUNDS; }

    rc = lc3_encode(c->h.enc, LC3_PCM_FORMAT_S16, in, 1, (int)frameBytes, buf);
    if (rc < 0)
        return FFS_LC3_E_CODEC;

    (*env)->SetByteArrayRegion(env, out, outOff, frameBytes, (const jbyte *)buf);
    if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); return FFS_LC3_E_BOUNDS; }

    return (jint)rc;
}

/* --- introspection: lets the Kotlin side assert the codec agrees about frame geometry ------ */

JNIEXPORT jint JNICALL
Java_expo_modules_ffsble_voice_NativeLc3Decoder_nativeFrameSamples(
        JNIEnv *env, jclass clazz, jint sampleRate, jint frameUs)
{
    (void)env; (void)clazz;
    return (jint)lc3_frame_samples((int)frameUs, (int)sampleRate);
}
