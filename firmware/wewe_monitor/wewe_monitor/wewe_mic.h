#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * I2S PDM RX capture for the Core2's onboard SPM1423 PDM microphone.
 * Pin mapping (CLK=GPIO0, DATA=GPIO34) confirmed via M5Stack community
 * documentation (no official pin table in M5Stack's own docs) — not
 * derivable from the chip alone. GPIO0 is also the boot-mode strapping pin;
 * fine to drive as PDM clock at runtime (strapping only matters across
 * reset), but do not repurpose it for anything boot-sensitive.
 *
 * Uses ESP-IDF's hardware PDM-to-PCM filter (SOC_I2S_SUPPORTS_PDM2PCM),
 * so this hands back real 16-bit PCM directly — no manual PDM decimation.
 */

/* Sets up I2S0 in PDM RX mode at the given sample rate, mono, 16-bit PCM. */
int wewe_mic_init(int sample_rate_hz);

/* Blocking read of exactly num_samples 16-bit PCM samples. Returns 0 on success. */
int wewe_mic_read(int16_t *buf, int num_samples, int timeout_ms);

#ifdef __cplusplus
}
#endif
