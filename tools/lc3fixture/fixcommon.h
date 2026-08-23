/*
 * fixcommon.h — shared bits for the S-VOICE host fixture tools.
 *
 * Deliberately header-only and dependency-free: these tools must build with nothing but a C
 * compiler and the vendored liblc3 sources, on a Windows box with mingw-w64 and no clang.
 */

#ifndef FFS_FIXCOMMON_H
#define FFS_FIXCOMMON_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── the S-VOICE wire format (mirrors voice/VoiceFormat.kt) ─────────────────────────────── */

#define FX_PACKET_BYTES      205
#define FX_LC3_BYTES         200
#define FX_FRAME_BYTES        40
#define FX_FRAMES_PER_PACKET   5
#define FX_SAMPLE_RATE     16000
#define FX_FRAME_US        10000
#define FX_SAMPLES_PER_FRAME 160
#define FX_SAMPLES_PER_PACKET (FX_FRAMES_PER_PACKET * FX_SAMPLES_PER_FRAME)
#define FX_OFF_SSR           200
#define FX_OFF_TDOA          202
#define FX_OFF_COUNTER       204

/* ── tiny helpers ───────────────────────────────────────────────────────────────────────── */

static inline void fx_put_i16le(uint8_t *p, int v)
{
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

static inline int fx_get_i16le(const uint8_t *p)
{
    return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

/* ── 16 kHz mono s16le WAV ──────────────────────────────────────────────────────────────── */

static inline int fx_wav_write(const char *path, const int16_t *pcm, size_t n, int rate)
{
    FILE *f = fopen(path, "wb");
    uint8_t h[44];
    uint32_t dataBytes = (uint32_t)(n * 2);
    uint32_t riff = 36 + dataBytes;
    uint32_t byteRate = (uint32_t)rate * 2;

    if (!f) return -1;

    memcpy(h + 0, "RIFF", 4);
    h[4] = (uint8_t)(riff); h[5] = (uint8_t)(riff >> 8);
    h[6] = (uint8_t)(riff >> 16); h[7] = (uint8_t)(riff >> 24);
    memcpy(h + 8, "WAVEfmt ", 8);
    h[16] = 16; h[17] = h[18] = h[19] = 0;             /* fmt chunk size          */
    h[20] = 1; h[21] = 0;                              /* PCM                     */
    h[22] = 1; h[23] = 0;                              /* mono                    */
    h[24] = (uint8_t)rate; h[25] = (uint8_t)(rate >> 8);
    h[26] = (uint8_t)(rate >> 16); h[27] = (uint8_t)(rate >> 24);
    h[28] = (uint8_t)byteRate; h[29] = (uint8_t)(byteRate >> 8);
    h[30] = (uint8_t)(byteRate >> 16); h[31] = (uint8_t)(byteRate >> 24);
    h[32] = 2; h[33] = 0;                              /* block align             */
    h[34] = 16; h[35] = 0;                             /* bits per sample         */
    memcpy(h + 36, "data", 4);
    h[40] = (uint8_t)(dataBytes); h[41] = (uint8_t)(dataBytes >> 8);
    h[42] = (uint8_t)(dataBytes >> 16); h[43] = (uint8_t)(dataBytes >> 24);

    if (fwrite(h, 1, 44, f) != 44) { fclose(f); return -1; }
    if (n && fwrite(pcm, 2, n, f) != n) { fclose(f); return -1; }
    fclose(f);
    return 0;
}

/* Minimal reader: accepts the canonical 44-byte header this tool writes, and skips unknown
 * chunks so a WAV from elsewhere still loads. Mono s16 only. */
static inline int16_t *fx_wav_read(const char *path, size_t *outN, int *outRate)
{
    FILE *f = fopen(path, "rb");
    uint8_t hdr[12], ch[8];
    int16_t *pcm = NULL;
    int rate = 0, channels = 0, bits = 0;

    if (!f) return NULL;
    if (fread(hdr, 1, 12, f) != 12 || memcmp(hdr, "RIFF", 4) || memcmp(hdr + 8, "WAVE", 4)) {
        fclose(f); return NULL;
    }
    for (;;) {
        uint32_t sz;
        if (fread(ch, 1, 8, f) != 8) break;
        sz = (uint32_t)ch[4] | ((uint32_t)ch[5] << 8) | ((uint32_t)ch[6] << 16) |
             ((uint32_t)ch[7] << 24);
        if (!memcmp(ch, "fmt ", 4)) {
            uint8_t fmt[16];
            if (sz < 16 || fread(fmt, 1, 16, f) != 16) break;
            channels = (int)((uint16_t)fmt[2] | ((uint16_t)fmt[3] << 8));
            rate = (int)((uint32_t)fmt[4] | ((uint32_t)fmt[5] << 8) |
                         ((uint32_t)fmt[6] << 16) | ((uint32_t)fmt[7] << 24));
            bits = (int)((uint16_t)fmt[14] | ((uint16_t)fmt[15] << 8));
            if (sz > 16) fseek(f, (long)(sz - 16), SEEK_CUR);
        } else if (!memcmp(ch, "data", 4)) {
            size_t n = sz / 2;
            if (channels != 1 || bits != 16) break;
            pcm = (int16_t *)malloc(n ? n * 2 : 2);
            if (!pcm) break;
            if (fread(pcm, 2, n, f) != n) { free(pcm); pcm = NULL; break; }
            *outN = n;
            if (outRate) *outRate = rate;
            break;
        } else {
            fseek(f, (long)(sz + (sz & 1)), SEEK_CUR);
        }
    }
    fclose(f);
    return pcm;
}

/* ── SHA-256 (FIPS 180-4), so a manifest can pin its .g2a ───────────────────────────────── */

typedef struct {
    uint32_t s[8];
    uint64_t len;
    uint8_t  buf[64];
    size_t   n;
} fx_sha256;

static const uint32_t fx_sha_k[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};

static uint32_t fx_ror(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void fx_sha_block(fx_sha256 *c, const uint8_t *p)
{
    uint32_t w[64], a, b, cc, d, e, f, g, h;
    int i;
    for (i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i*4] << 24) | ((uint32_t)p[i*4+1] << 16) |
               ((uint32_t)p[i*4+2] << 8) | (uint32_t)p[i*4+3];
    for (i = 16; i < 64; i++) {
        uint32_t s0 = fx_ror(w[i-15], 7) ^ fx_ror(w[i-15], 18) ^ (w[i-15] >> 3);
        uint32_t s1 = fx_ror(w[i-2], 17) ^ fx_ror(w[i-2], 19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    a=c->s[0]; b=c->s[1]; cc=c->s[2]; d=c->s[3]; e=c->s[4]; f=c->s[5]; g=c->s[6]; h=c->s[7];
    for (i = 0; i < 64; i++) {
        uint32_t S1 = fx_ror(e,6) ^ fx_ror(e,11) ^ fx_ror(e,25);
        uint32_t chv = (e & f) ^ ((~e) & g);
        uint32_t t1 = h + S1 + chv + fx_sha_k[i] + w[i];
        uint32_t S0 = fx_ror(a,2) ^ fx_ror(a,13) ^ fx_ror(a,22);
        uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
        uint32_t t2 = S0 + maj;
        h=g; g=f; f=e; e=d+t1; d=cc; cc=b; b=a; a=t1+t2;
    }
    c->s[0]+=a; c->s[1]+=b; c->s[2]+=cc; c->s[3]+=d;
    c->s[4]+=e; c->s[5]+=f; c->s[6]+=g; c->s[7]+=h;
}

static void fx_sha_init(fx_sha256 *c)
{
    c->s[0]=0x6a09e667u; c->s[1]=0xbb67ae85u; c->s[2]=0x3c6ef372u; c->s[3]=0xa54ff53au;
    c->s[4]=0x510e527fu; c->s[5]=0x9b05688cu; c->s[6]=0x1f83d9abu; c->s[7]=0x5be0cd19u;
    c->len = 0; c->n = 0;
}

static void fx_sha_update(fx_sha256 *c, const void *data, size_t len)
{
    const uint8_t *p = (const uint8_t *)data;
    c->len += (uint64_t)len * 8;
    while (len) {
        size_t take = 64 - c->n;
        if (take > len) take = len;
        memcpy(c->buf + c->n, p, take);
        c->n += take; p += take; len -= take;
        if (c->n == 64) { fx_sha_block(c, c->buf); c->n = 0; }
    }
}

static void fx_sha_hex(fx_sha256 *c, char out[65])
{
    uint8_t pad[72];
    size_t padLen;
    uint64_t bits = c->len;
    int i;
    pad[0] = 0x80;
    padLen = ((c->n < 56) ? (56 - c->n) : (120 - c->n));
    memset(pad + 1, 0, padLen - 1);
    for (i = 0; i < 8; i++) pad[padLen + i] = (uint8_t)(bits >> (56 - 8 * i));
    { uint64_t save = c->len; fx_sha_update(c, pad, padLen + 8); c->len = save; }
    for (i = 0; i < 8; i++)
        sprintf(out + i * 8, "%08x", c->s[i]);
    out[64] = 0;
}

static inline int fx_sha256_file(const char *path, char out[65])
{
    FILE *f = fopen(path, "rb");
    fx_sha256 c;
    uint8_t buf[4096];
    size_t r;
    if (!f) return -1;
    fx_sha_init(&c);
    while ((r = fread(buf, 1, sizeof(buf), f)) > 0) fx_sha_update(&c, buf, r);
    fclose(f);
    fx_sha_hex(&c, out);
    return 0;
}

#endif /* FFS_FIXCOMMON_H */
