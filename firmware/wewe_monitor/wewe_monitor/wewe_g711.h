#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Standard ITU-T G.711 A-law encoder (the textbook segment-search
 * algorithm used by, e.g., BSD/Sun's g711.c). Hand-rolled rather than
 * pulled from a registry dependency: A-law is a simple enough, unchanged-
 * for-decades algorithm that adding a codec library for it isn't worth
 * the dependency weight. G711A (PCMA) is this firmware's interim codec —
 * see wewe_monitor.cpp's comment on why, ahead of an Opus upgrade.
 */
uint8_t wewe_linear_to_alaw(int16_t pcm_val);

#ifdef __cplusplus
}
#endif
