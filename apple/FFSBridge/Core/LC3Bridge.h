#ifndef FFS_LC3_BRIDGE_H
#define FFS_LC3_BRIDGE_H
#include <stdint.h>
void *ffs_lc3_create(void);
void ffs_lc3_destroy(void *decoder);
int ffs_lc3_frame(void *decoder, const uint8_t *bytes, int16_t *samples);
#endif
