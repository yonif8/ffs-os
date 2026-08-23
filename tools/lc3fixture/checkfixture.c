/*
 * checkfixture.c — decode a .g2a fixture the way the Kotlin framer must, and MEASURE whether it
 * came out right.
 *
 * This tool exists to settle one question with numbers instead of opinion:
 *
 *     Are the 200 payload bytes of a mic packet FIVE 40-byte LC3 frames, or one 200-byte frame?
 *
 * Run it normally and it decodes five-frames-per-packet through ONE persistent decoder. Run it
 * with --wrong and it hands all 200 bytes to `lc3_decode` as a single frame, which is the mistake
 * that has cost other implementations days. Both paths are then compared against the reference
 * PCM the fixture was generated from, and the report prints the contrast. The contrast IS the
 * evidence: the correct path correlates strongly with the reference, the wrong path is noise.
 *
 * It is also the reference implementation of gap handling. Packets carry a mod-256 counter; a
 * jump means the firmware dropped packets (normal — it drops when its tx queue is half full).
 * Small gaps are filled with LC3 packet-loss concealment from the SAME persistent decoder; a gap
 * too large to conceal is a resync, where concealment would just smear, so the remainder is
 * written as silence and counted. Either way the output stays time-aligned with the reference,
 * which is what keeps the correlation number meaningful.
 *
 * Usage:
 *   checkfixture FIXTURE.g2a [--ref REF.wav] [--out OUT.wav] [--wrong] [--max-conceal N]
 */

#include <math.h>
#include "fixcommon.h"
#include "lc3.h"

/* Frames we are willing to synthesise before calling it a resync. Five frames = one whole lost
 * packet = 50 ms; ten frames = 100 ms, past which LC3 concealment has nothing left to model. */
#define DEFAULT_MAX_CONCEAL 10

typedef struct {
    int packets, malformed, duplicates, lostPackets, concealed, silenceFrames, resyncs;
    int decodeErrors, plcReturns;
} report_t;

static double rms_of(const int16_t *x, size_t n)
{
    double s = 0.0;
    size_t i;
    if (!n) return 0.0;
    for (i = 0; i < n; i++) { double v = x[i] / 32768.0; s += v * v; }
    return sqrt(s / n);
}

/* Zero-crossing rate — a blunt but very effective noise detector. Speech-like audio at 16 kHz
 * sits well under 0.2; white noise sits near 0.5. */
static double zcr_of(const int16_t *x, size_t n)
{
    size_t i, c = 0;
    if (n < 2) return 0.0;
    for (i = 1; i < n; i++) if ((x[i] < 0) != (x[i - 1] < 0)) c++;
    return (double)c / (double)(n - 1);
}

/* Pearson correlation of a[lag..] against b[..], over the overlapping span. */
static double corr_at(const int16_t *a, size_t na, const int16_t *b, size_t nb, int lag)
{
    size_t n, i;
    double sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, den;
    if (lag < 0 || (size_t)lag >= na) return 0.0;
    n = na - (size_t)lag;
    if (n > nb) n = nb;
    if (n < 64) return 0.0;
    for (i = 0; i < n; i++) {
        double x = a[i + (size_t)lag] / 32768.0;
        double y = b[i] / 32768.0;
        sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    den = sqrt((saa - sa * sa / n) * (sbb - sb * sb / n));
    if (den <= 1e-12) return 0.0;
    return (sab - sa * sb / n) / den;
}

/* Segmental SNR of `out` (already lag-aligned) against `ref`, in dB, averaged over 20 ms
 * segments that actually contain signal. Silence segments are skipped because an SNR against
 * silence is meaningless and would swamp the average. */
static double seg_snr(const int16_t *out, size_t no, const int16_t *ref, size_t nr,
                      int lag, int *segCount)
{
    const size_t seg = 320;                 /* 20 ms @ 16 kHz */
    size_t i, n;
    double total = 0.0;
    int used = 0;
    if (lag < 0 || (size_t)lag >= no) { if (segCount) *segCount = 0; return -99.0; }
    n = no - (size_t)lag;
    if (n > nr) n = nr;
    for (i = 0; i + seg <= n; i += seg) {
        double sig = 0.0, err = 0.0;
        size_t k;
        for (k = 0; k < seg; k++) {
            double r = ref[i + k] / 32768.0;
            double o = out[i + k + (size_t)lag] / 32768.0;
            sig += r * r;
            err += (r - o) * (r - o);
        }
        if (sig / seg < 1e-6) continue;     /* skip silence */
        {
            double v = 10.0 * log10(sig / (err + 1e-12));
            if (v > 40.0) v = 40.0;
            if (v < -20.0) v = -20.0;
            total += v; used++;
        }
    }
    if (segCount) *segCount = used;
    return used ? (total / used) : -99.0;
}

int main(int argc, char **argv)
{
    const char *inPath = NULL, *refPath = NULL, *outPath = "out.wav";
    int wrong = 0, maxConceal = DEFAULT_MAX_CONCEAL;
    int i;

    FILE *f;
    long fileBytes;
    uint8_t *raw = NULL;
    size_t nRaw, nPkt, p;

    unsigned decSize;
    void *decMem;
    lc3_decoder_t dec;

    int16_t *out = NULL, *ref = NULL;
    size_t outCap = 0, outN = 0, refN = 0;
    int refRate = 0;
    report_t r;
    int prevCounter = -1;
    int failed = 0;

    memset(&r, 0, sizeof(r));

    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--ref") && i + 1 < argc)              refPath = argv[++i];
        else if (!strcmp(argv[i], "--out") && i + 1 < argc)         outPath = argv[++i];
        else if (!strcmp(argv[i], "--wrong"))                       wrong = 1;
        else if (!strcmp(argv[i], "--max-conceal") && i + 1 < argc) maxConceal = atoi(argv[++i]);
        else if (argv[i][0] != '-' && !inPath)                      inPath = argv[i];
        else {
            fprintf(stderr,
                "usage: checkfixture FIXTURE.g2a [--ref REF.wav] [--out OUT.wav] [--wrong]"
                " [--max-conceal N]\n");
            return 2;
        }
    }
    if (!inPath) { fprintf(stderr, "checkfixture: no input\n"); return 2; }

    f = fopen(inPath, "rb");
    if (!f) { fprintf(stderr, "checkfixture: cannot open %s\n", inPath); return 1; }
    fseek(f, 0, SEEK_END); fileBytes = ftell(f); fseek(f, 0, SEEK_SET);
    raw = (uint8_t *)malloc((size_t)fileBytes);
    if (!raw || fread(raw, 1, (size_t)fileBytes, f) != (size_t)fileBytes) {
        fprintf(stderr, "checkfixture: read failed\n"); return 1;
    }
    fclose(f);
    nRaw = (size_t)fileBytes;

    /* ── framing assertion #1: the stream is a whole number of 205-byte packets ─────────── */
    if (nRaw % FX_PACKET_BYTES != 0) {
        fprintf(stderr,
            "checkfixture: %s is %d bytes, not a multiple of %d — this is not a mic stream\n",
            inPath, (int)nRaw, FX_PACKET_BYTES);
        return 1;
    }
    nPkt = nRaw / FX_PACKET_BYTES;

    /* ── ONE persistent decoder for the whole stream ───────────────────────────────────── */
    decSize = lc3_decoder_size(FX_FRAME_US, FX_SAMPLE_RATE);
    if (!decSize) { fprintf(stderr, "checkfixture: lc3_decoder_size failed\n"); return 1; }
    decMem = malloc(decSize);
    dec = lc3_setup_decoder(FX_FRAME_US, FX_SAMPLE_RATE, 0, decMem);
    if (!dec) { fprintf(stderr, "checkfixture: lc3_setup_decoder failed\n"); return 1; }

    outCap = (nPkt + 64) * FX_SAMPLES_PER_PACKET * 4;
    out = (int16_t *)calloc(outCap, sizeof(int16_t));
    if (!out) { fprintf(stderr, "checkfixture: oom\n"); return 1; }

    for (p = 0; p < nPkt; p++) {
        const uint8_t *pkt = raw + p * FX_PACKET_BYTES;
        int counter = pkt[FX_OFF_COUNTER];
        int f5, gap;

        r.packets++;

        /* ── gap accounting from the mod-256 counter ──────────────────────────────────── */
        if (prevCounter >= 0) {
            gap = (counter - prevCounter) & 0xFF;
            if (gap == 0) {
                /* Both lenses notify the same audio; a repeat of the same counter is the other
                 * eye's copy, not a stall. Drop it. */
                r.duplicates++;
                continue;
            }
            if (gap > 1) {
                int lost = gap - 1;
                int lostFrames = lost * FX_FRAMES_PER_PACKET;
                int concealNow = lostFrames < maxConceal ? lostFrames : maxConceal;
                int k;
                r.lostPackets += lost;
                for (k = 0; k < concealNow && outN + FX_SAMPLES_PER_FRAME <= outCap; k++) {
                    int rc = lc3_decode(dec, NULL, 0, LC3_PCM_FORMAT_S16, out + outN, 1);
                    if (rc < 0) { r.decodeErrors++; }
                    else if (rc == 1) { r.plcReturns++; }
                    outN += FX_SAMPLES_PER_FRAME;
                    r.concealed++;
                }
                if (lostFrames > concealNow) {
                    /* Too big to conceal: this is genuinely missing audio. Emit silence so the
                     * timeline stays true rather than pretending the gap did not happen. */
                    int rest = lostFrames - concealNow;
                    r.resyncs++;
                    for (k = 0; k < rest && outN + FX_SAMPLES_PER_FRAME <= outCap; k++) {
                        memset(out + outN, 0, FX_SAMPLES_PER_FRAME * sizeof(int16_t));
                        outN += FX_SAMPLES_PER_FRAME;
                        r.silenceFrames++;
                    }
                }
            }
        }
        prevCounter = counter;

        /* ── the payload ──────────────────────────────────────────────────────────────── */
        if (wrong) {
            /* THE MISTAKE, on purpose: all 200 bytes handed over as one frame. liblc3 accepts
             * the size (20..400 is legal) and dutifully decodes 160 samples of garbage. Note
             * that it also produces FIVE TIMES TOO FEW SAMPLES — the timeline collapses. */
            int rc;
            if (outN + FX_SAMPLES_PER_FRAME > outCap) break;
            rc = lc3_decode(dec, pkt, FX_LC3_BYTES, LC3_PCM_FORMAT_S16, out + outN, 1);
            if (rc < 0) r.decodeErrors++;
            else if (rc == 1) r.plcReturns++;
            outN += FX_SAMPLES_PER_FRAME;
        } else {
            for (f5 = 0; f5 < FX_FRAMES_PER_PACKET; f5++) {
                int rc;
                if (outN + FX_SAMPLES_PER_FRAME > outCap) break;
                rc = lc3_decode(dec, pkt + f5 * FX_FRAME_BYTES, FX_FRAME_BYTES,
                                LC3_PCM_FORMAT_S16, out + outN, 1);
                if (rc < 0) r.decodeErrors++;
                else if (rc == 1) r.plcReturns++;
                outN += FX_SAMPLES_PER_FRAME;
            }
        }
    }

    if (fx_wav_write(outPath, out, outN, FX_SAMPLE_RATE) != 0)
        fprintf(stderr, "checkfixture: warning — could not write %s\n", outPath);

    /* ── report ────────────────────────────────────────────────────────────────────────── */
    printf("── checkfixture ──────────────────────────────────────────────────────────────\n");
    printf("  input            %s (%d bytes)\n", inPath, (int)nRaw);
    printf("  reading          %s\n",
           wrong ? "*** WRONG: 200 bytes as ONE lc3 frame ***"
                 : "five 40-byte frames per packet, one persistent decoder");
    printf("  packets          %d\n", r.packets);
    printf("  duplicates       %d\n", r.duplicates);
    printf("  lost packets     %d   (from the mod-256 counter)\n", r.lostPackets);
    printf("  concealed frames %d   (PLC; lc3_decode returned 1 on %d calls total)\n",
           r.concealed, r.plcReturns);
    printf("  silence frames   %d   (gap too large to conceal)\n", r.silenceFrames);
    printf("  resyncs          %d\n", r.resyncs);
    printf("  decode errors    %d\n", r.decodeErrors);
    printf("  pcm samples      %d  (%.3f s)  -> %s\n",
           (int)outN, (double)outN / FX_SAMPLE_RATE, outPath);
    printf("  pcm rms          %.5f\n", rms_of(out, outN));
    printf("  zero-cross rate  %.4f\n", zcr_of(out, outN));

    if (refPath) {
        ref = fx_wav_read(refPath, &refN, &refRate);
        if (!ref) {
            fprintf(stderr, "checkfixture: cannot read reference %s\n", refPath);
        } else {
            int lag, bestLag = 0;
            double best = -2.0, snr;
            int segs = 0;
            /* LC3 has an algorithmic delay, so search rather than assume alignment. 0..960
             * samples = 0..60 ms, comfortably more than the codec's delay. */
            for (lag = 0; lag <= 960; lag++) {
                double c = corr_at(out, outN, ref, refN, lag);
                if (c > best) { best = c; bestLag = lag; }
            }
            snr = seg_snr(out, outN, ref, refN, bestLag, &segs);
            printf("  ── vs reference %s (%d samples @ %d Hz)\n", refPath, (int)refN, refRate);
            printf("  reference rms    %.5f      zcr %.4f\n",
                   rms_of(ref, refN), zcr_of(ref, refN));
            printf("  best lag         %d samples (%.2f ms)  <- LC3 algorithmic delay\n",
                   bestLag, bestLag / 16.0);
            printf("  correlation      %.4f\n", best);
            printf("  segmental SNR    %.2f dB over %d voiced segments\n", snr, segs);
            printf("  sample ratio     %.3f  (decoded / reference; 1.000 = timeline intact)\n",
                   refN ? (double)outN / (double)refN : 0.0);
            {
                /* A fixture with deliberate gaps cannot hit the lossless bar and should not be
                 * judged against it: concealed and silenced audio is missing audio. Slide the
                 * bar with the measured loss instead, so the verdict answers the question this
                 * tool exists for -- "is this the reference signal?" -- rather than "was the
                 * link perfect?". Loss is measured, not declared, so --wrong (which loses
                 * nothing and simply misreads the frames) still faces the full bar. */
                double lossFrac = (r.packets + r.lostPackets)
                        ? (double)r.lostPackets / (double)(r.packets + r.lostPackets) : 0.0;
                double corrBar = 0.80 - 0.60 * lossFrac;
                double snrBar  = 5.00 - 8.00 * lossFrac;
                double ratio   = refN ? (double)outN / (double)refN : 0.0;
                int pass = (best > corrBar) && (snr > snrBar) && (ratio > 0.98) && (ratio < 1.02);
                printf("  bar             corr > %.2f, segSNR > %.2f dB, ratio ~ 1.00"
                       "   (loss %.0f%%)\n", corrBar, snrBar, lossFrac * 100.0);
                printf("  VERDICT          %s\n",
                       pass ? "PASS — this is the reference signal, decoded"
                            : "FAIL — this does not track the reference");
                if (!pass) failed = 1;
            }
            free(ref);
        }
    } else {
        printf("  (no --ref given; correlation not computed)\n");
    }
    printf("──────────────────────────────────────────────────────────────────────────────\n");

    free(out);
    free(raw);
    free(decMem);
    /* Exit non-zero on a FAIL so this is usable as a CI gate, not just a thing to read. */
    return failed ? 1 : 0;
}
