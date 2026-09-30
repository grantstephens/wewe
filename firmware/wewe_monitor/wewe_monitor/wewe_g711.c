#include "wewe_g711.h"

#define SEG_SHIFT 4
#define QUANT_MASK 0xf

static const int16_t seg_end[8] = {0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF};

static int search(int16_t val, const int16_t *table, int size) {
    for (int i = 0; i < size; i++) {
        if (val <= table[i]) {
            return i;
        }
    }
    return size;
}

uint8_t wewe_linear_to_alaw(int16_t pcm_val) {
    int16_t mask;
    int16_t seg;
    uint8_t aval;

    pcm_val = (int16_t)(pcm_val >> 3);

    if (pcm_val >= 0) {
        mask = 0xD5;
    } else {
        mask = 0x55;
        pcm_val = (int16_t)(-pcm_val - 1);
    }

    seg = (int16_t)search(pcm_val, seg_end, 8);

    if (seg >= 8) {
        return (uint8_t)(0x7F ^ mask);
    }
    aval = (uint8_t)(seg << SEG_SHIFT);
    if (seg < 2) {
        aval |= (pcm_val >> 1) & QUANT_MASK;
    } else {
        aval |= (pcm_val >> seg) & QUANT_MASK;
    }
    return (uint8_t)(aval ^ mask);
}
