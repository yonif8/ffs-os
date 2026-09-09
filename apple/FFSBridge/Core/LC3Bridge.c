#include "LC3Bridge.h"
#include "lc3.h"
#include <stdlib.h>
struct decoder { void *memory; lc3_decoder_t state; };
void *ffs_lc3_create(void) {
    struct decoder *d = calloc(1, sizeof(*d));
    if (!d) return NULL;
    d->memory = malloc(lc3_decoder_size(10000, 16000));
    if (!d->memory) { free(d); return NULL; }
    d->state = lc3_setup_decoder(10000, 16000, 16000, d->memory);
    if (!d->state) { free(d->memory); free(d); return NULL; }
    return d;
}
void ffs_lc3_destroy(void *ptr) {
    struct decoder *d = ptr;
    if (d) { free(d->memory); free(d); }
}
int ffs_lc3_frame(void *ptr, const uint8_t *bytes, int16_t *samples) {
    struct decoder *d = ptr;
    if (!d || !samples) return -1;
    return lc3_decode(d->state, bytes, bytes ? 40 : 0, LC3_PCM_FORMAT_S16, samples, 1);
}
