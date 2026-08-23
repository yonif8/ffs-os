/*
 * mkfixture.c — generate SYNTHETIC S-VOICE fixtures for the FFS Glasses voice pipeline.
 *
 * ⛔ THERE IS NO HUMAN VOICE ANYWHERE IN THIS TOOL OR ITS OUTPUT. The signal is a deterministic,
 * closed-form "speech-like" waveform: a swept glottal buzz (harmonic stack) shaped by three swept
 * formant resonances, gated into syllables and pauses, with a trace of seeded pseudo-random noise
 * for fricative texture. Same seed, same bytes, forever. This matters because `ffs_os` is a PUBLIC
 * repository and the real signal this pipeline carries is a recording of the wearer.
 *
 * What it writes, for prefix P:
 *   P.g2a      the raw 205-byte packet stream, byte-identical in shape to what the glasses notify
 *              and to what the phone archives as the session master
 *   P.ref.wav  the ORIGINAL pre-encode PCM, 16 kHz mono s16le — the ground truth checkfixture
 *              correlates a decode against
 *   P.json     a manifest: parameters, packet count, per-packet counter/ssr/tdoa, sha256 of P.g2a
 *
 * Packet layout (see voice/VoiceFormat.kt):
 *   [0..199]  five 40-byte LC3 frames, 16 kHz mono, 10 ms each, ONE persistent encoder
 *   [200..201] ssr int16 LE   [202..203] tdoa int16 LE   [204] counter u8 (mod 256)
 *
 * Usage:
 *   mkfixture --out PREFIX [--seconds 2.0] [--seed 20260823] [--drop 7,13,14,15,...] [--no-ref]
 *
 * `--drop` omits those packet indices from the .g2a entirely while the counter keeps advancing —
 * exactly what the firmware does when its tx queue is half full. That is what makes the gap
 * fixture exercise PLC and resync.
 */

#include <math.h>
#include "fixcommon.h"
#include "lc3.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define MAX_DROPS 256

/* ── deterministic PRNG (xorshift32 — identical output on every platform) ────────────────── */

static uint32_t rng_state;
static void  rng_seed(uint32_t s) { rng_state = s ? s : 0x9E3779B9u; }
static double rng_bipolar(void)
{
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return ((double)rng_state / 2147483648.0) - 1.0;   /* -1 .. 1 */
}

/* ── the synthetic "speech-like" signal ─────────────────────────────────────────────────── */
/*
 * One deterministic closed form, no filters, no state to get wrong:
 *
 *   f0(t)    pitch, sweeping 105..165 Hz over a slow contour — makes the LTPF pitch path in LC3
 *            actually do something, which is the point of using a buzz rather than a pure tone.
 *   H(k)     12 harmonics of f0 at 1/k amplitude = a glottal-ish source.
 *   G(f)     three swept formant resonances (F1 ~500-800, F2 ~1100-1900, F3 ~2400-2700 Hz),
 *            applied as a per-harmonic gain, so the spectrum has speech-shaped peaks.
 *   env(t)   syllable gating: 190 ms voiced, 80 ms silent, with raised-cosine edges, plus two
 *            long pauses so a decoder's silence handling is exercised too.
 *   noise    -42 dBFS seeded noise, gated up during the "fricative" third of each syllable.
 */
static void synth(int16_t *pcm, size_t n, int rate, uint32_t seed)
{
    size_t i;
    rng_seed(seed);
    for (i = 0; i < n; i++) {
        double t = (double)i / (double)rate;
        double f0 = 105.0 + 60.0 * (0.5 + 0.5 * sin(2.0 * M_PI * 0.37 * t + 0.9));
        double f1 = 500.0 + 300.0 * (0.5 + 0.5 * sin(2.0 * M_PI * 0.53 * t));
        double f2 = 1100.0 + 800.0 * (0.5 + 0.5 * sin(2.0 * M_PI * 0.31 * t + 2.1));
        double f3 = 2400.0 + 300.0 * (0.5 + 0.5 * sin(2.0 * M_PI * 0.19 * t + 4.2));
        double phase0 = 0.0, s = 0.0, env, ns, v;
        double cyc, pos, syl;
        int k;

        /* Integrated pitch phase: sum of a constant-ish f0 is fine at this sweep rate, and
         * computing it in closed form keeps the generator stateless and reproducible. */
        phase0 = 2.0 * M_PI * (105.0 * t
                 - (60.0 / (2.0 * M_PI * 0.37)) * 0.5 * cos(2.0 * M_PI * 0.37 * t + 0.9)
                 + 30.0 * t);

        for (k = 1; k <= 12; k++) {
            double fk = f0 * k;
            double g, d1, d2, d3;
            if (fk > 0.45 * rate) break;
            d1 = (fk - f1) / 110.0;
            d2 = (fk - f2) / 160.0;
            d3 = (fk - f3) / 220.0;
            g = 1.0 / (1.0 + d1 * d1) + 0.65 / (1.0 + d2 * d2) + 0.35 / (1.0 + d3 * d3);
            s += (g / (double)k) * sin(phase0 * k);
        }
        s *= 0.28;

        /* syllable envelope: 270 ms period, 190 ms voiced with 12 ms raised-cosine edges */
        cyc = fmod(t, 0.270);
        if (cyc < 0.190) {
            if (cyc < 0.012)       syl = 0.5 - 0.5 * cos(M_PI * cyc / 0.012);
            else if (cyc > 0.178)  syl = 0.5 - 0.5 * cos(M_PI * (0.190 - cyc) / 0.012);
            else                   syl = 1.0;
        } else {
            syl = 0.0;
        }
        pos = cyc / 0.190;

        /* two long pauses, so the fixture contains real silence as well as gaps between words */
        env = syl;
        if ((t > 0.62 && t < 0.86) || (t > 1.44 && t < 1.62)) env = 0.0;

        /* fricative burst in the last third of each syllable */
        ns = rng_bipolar() * 0.008;
        if (syl > 0.0 && pos > 0.66) ns *= 6.0;

        v = env * s + ns * (env > 0.0 ? 1.0 : 0.15);
        if (v > 0.98) v = 0.98;
        if (v < -0.98) v = -0.98;
        pcm[i] = (int16_t)lrint(v * 32767.0);
    }
}

/* ── main ───────────────────────────────────────────────────────────────────────────────── */

static int is_dropped(const int *drops, int nDrops, int idx)
{
    int i;
    for (i = 0; i < nDrops; i++) if (drops[i] == idx) return 1;
    return 0;
}

static void usage(void)
{
    fprintf(stderr,
        "usage: mkfixture --out PREFIX [--seconds S] [--seed N] [--drop a,b,c] [--no-ref]\n");
}

int main(int argc, char **argv)
{
    const char *prefix = NULL;
    double seconds = 2.0;
    uint32_t seed = 20260823u;
    int drops[MAX_DROPS], nDrops = 0;
    int writeRef = 1;
    int i;

    char pathG2a[512], pathWav[512], pathJson[512], hex[65];
    size_t nSamples, nPackets, p;
    int16_t *pcm = NULL;
    unsigned encSize;
    void *encMem = NULL;
    lc3_encoder_t enc;
    FILE *fg = NULL, *fj = NULL;
    double energyHist[10];
    int    histN = 0;
    int    written = 0;

    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--out") && i + 1 < argc)          prefix = argv[++i];
        else if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = atof(argv[++i]);
        else if (!strcmp(argv[i], "--seed") && i + 1 < argc)    seed = (uint32_t)strtoul(argv[++i], NULL, 10);
        else if (!strcmp(argv[i], "--no-ref"))                  writeRef = 0;
        else if (!strcmp(argv[i], "--drop") && i + 1 < argc) {
            char *tok = strtok(argv[++i], ",");
            while (tok && nDrops < MAX_DROPS) { drops[nDrops++] = atoi(tok); tok = strtok(NULL, ","); }
        } else { usage(); return 2; }
    }
    if (!prefix) { usage(); return 2; }

    nPackets = (size_t)(seconds * 1000.0 / 50.0 + 0.5);
    if (nPackets == 0) { fprintf(stderr, "mkfixture: zero packets\n"); return 2; }
    nSamples = nPackets * FX_SAMPLES_PER_PACKET;

    pcm = (int16_t *)malloc(nSamples * sizeof(int16_t));
    if (!pcm) { fprintf(stderr, "mkfixture: oom\n"); return 1; }
    synth(pcm, nSamples, FX_SAMPLE_RATE, seed);

    /* ONE persistent encoder for the whole stream — the mirror image of the decode rule. */
    encSize = lc3_encoder_size(FX_FRAME_US, FX_SAMPLE_RATE);
    if (!encSize) { fprintf(stderr, "mkfixture: lc3_encoder_size failed\n"); free(pcm); return 1; }
    encMem = malloc(encSize);
    enc = lc3_setup_encoder(FX_FRAME_US, FX_SAMPLE_RATE, 0, encMem);
    if (!enc) { fprintf(stderr, "mkfixture: lc3_setup_encoder failed\n"); free(encMem); free(pcm); return 1; }

    snprintf(pathG2a, sizeof(pathG2a), "%s.g2a", prefix);
    snprintf(pathWav, sizeof(pathWav), "%s.ref.wav", prefix);
    snprintf(pathJson, sizeof(pathJson), "%s.json", prefix);

    fg = fopen(pathG2a, "wb");
    fj = fopen(pathJson, "wb");
    if (!fg || !fj) { fprintf(stderr, "mkfixture: cannot open outputs\n"); return 1; }

    fprintf(fj, "{\n");
    fprintf(fj, "  \"generator\": \"ffs_os/tools/lc3fixture/mkfixture.c\",\n");
    fprintf(fj, "  \"synthetic\": true,\n");
    fprintf(fj, "  \"contains_human_voice\": false,\n");
    fprintf(fj, "  \"signal\": \"deterministic swept-formant glottal buzz, syllable-gated, seeded noise\",\n");
    fprintf(fj, "  \"seed\": %u,\n", seed);
    fprintf(fj, "  \"sample_rate\": %d,\n", FX_SAMPLE_RATE);
    fprintf(fj, "  \"frame_us\": %d,\n", FX_FRAME_US);
    fprintf(fj, "  \"frame_bytes\": %d,\n", FX_FRAME_BYTES);
    fprintf(fj, "  \"frames_per_packet\": %d,\n", FX_FRAMES_PER_PACKET);
    fprintf(fj, "  \"packet_bytes\": %d,\n", FX_PACKET_BYTES);
    fprintf(fj, "  \"duration_ms\": %d,\n", (int)(nPackets * 50));
    fprintf(fj, "  \"packets_generated\": %d,\n", (int)nPackets);
    fprintf(fj, "  \"dropped_indices\": [");
    for (i = 0; i < nDrops; i++) fprintf(fj, "%s%d", i ? ", " : "", drops[i]);
    fprintf(fj, "],\n");
    fprintf(fj, "  \"packets\": [\n");

    for (p = 0; p < nPackets; p++) {
        uint8_t pkt[FX_PACKET_BYTES];
        const int16_t *src = pcm + p * FX_SAMPLES_PER_PACKET;
        double energy = 0.0, mean = 0.0;
        int ssr, tdoa, f, dropped;

        /* Encode five frames through the ONE encoder. Note that even the dropped packets are
         * encoded: the encoder state must advance exactly as the glasses' would, or the frames
         * after a gap would not be the frames a real stream produces after that gap. */
        for (f = 0; f < FX_FRAMES_PER_PACKET; f++) {
            int rc = lc3_encode(enc, LC3_PCM_FORMAT_S16,
                                src + f * FX_SAMPLES_PER_FRAME, 1,
                                FX_FRAME_BYTES, pkt + f * FX_FRAME_BYTES);
            if (rc < 0) { fprintf(stderr, "mkfixture: lc3_encode failed at packet %d\n", (int)p); return 1; }
        }

        /* Synthetic ssr: the firmware computes a speech-presence proxy as this packet's energy
         * against a ~10-packet running mean, so we do the same and scale it into an int16. */
        for (f = 0; f < FX_SAMPLES_PER_PACKET; f++) {
            double s = (double)src[f] / 32768.0;
            energy += s * s;
        }
        energy = energy / FX_SAMPLES_PER_PACKET + 1e-9;
        for (f = 0; f < histN; f++) mean += energyHist[f];
        mean = histN ? (mean / histN) : energy;
        {
            double ratio = 10.0 * log10(energy / (mean + 1e-9));
            if (ratio > 30.0) ratio = 30.0;
            if (ratio < -30.0) ratio = -30.0;
            ssr = (int)lrint(ratio * 100.0);       /* centi-dB, comfortably inside int16 */
        }
        energyHist[p % 10] = energy;
        if (histN < 10) histN++;

        /* Synthetic tdoa: eighths of a sample, a slow head-turn-ish sweep of about ±3 samples. */
        tdoa = (int)lrint(8.0 * 3.0 * sin(2.0 * M_PI * 0.11 * (double)p * 0.05));

        fx_put_i16le(pkt + FX_OFF_SSR, ssr);
        fx_put_i16le(pkt + FX_OFF_TDOA, tdoa);
        pkt[FX_OFF_COUNTER] = (uint8_t)(p & 0xFF);

        dropped = is_dropped(drops, nDrops, (int)p);
        if (!dropped) {
            if (fwrite(pkt, 1, FX_PACKET_BYTES, fg) != FX_PACKET_BYTES) {
                fprintf(stderr, "mkfixture: short write\n"); return 1;
            }
            written++;
        }

        fprintf(fj, "    {\"index\": %d, \"counter\": %d, \"ssr\": %d, \"tdoa\": %d, \"present\": %s}%s\n",
                (int)p, (int)(p & 0xFF), ssr, tdoa, dropped ? "false" : "true",
                (p + 1 < nPackets) ? "," : "");
    }
    fprintf(fj, "  ],\n");
    fclose(fg);
    fg = NULL;

    if (writeRef && fx_wav_write(pathWav, pcm, nSamples, FX_SAMPLE_RATE) != 0) {
        fprintf(stderr, "mkfixture: cannot write %s\n", pathWav);
        return 1;
    }

    if (fx_sha256_file(pathG2a, hex) != 0) { fprintf(stderr, "mkfixture: sha256 failed\n"); return 1; }
    fprintf(fj, "  \"packets_written\": %d,\n", written);
    fprintf(fj, "  \"g2a_bytes\": %d,\n", written * FX_PACKET_BYTES);
    fprintf(fj, "  \"g2a_sha256\": \"%s\",\n", hex);
    fprintf(fj, "  \"reference_wav\": %s\n", writeRef ? "\"<prefix>.ref.wav\"" : "null");
    fprintf(fj, "}\n");
    fclose(fj);

    printf("mkfixture: %s  %d/%d packets written (%d bytes), %.2fs, sha256=%.16s...\n",
           pathG2a, written, (int)nPackets, written * FX_PACKET_BYTES,
           (double)nSamples / FX_SAMPLE_RATE, hex);

    free(encMem);
    free(pcm);
    return 0;
}
