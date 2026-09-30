#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * I2S PDM RX capture for a PDM microphone (tested against the Core2's
 * onboard SPM1423; should work with any I2S-PDM-compatible mic). Pins are
 * supplied by the caller via wewe_mic_init() — see wewe_monitor's own
 * clk_pin/din_pin config for how they reach here on a real board.
 *
 * Uses ESP-IDF's hardware PDM-to-PCM filter (SOC_I2S_SUPPORTS_PDM2PCM),
 * so this hands back real 16-bit PCM directly — no manual PDM decimation.
 */

/* Sets up I2S0 in PDM RX mode at the given sample rate, mono, 16-bit PCM.
 * clk_gpio/din_gpio are the board's PDM clock (ESP32 output) and data
 * (ESP32 input) pins — hardcoded to the Core2's wiring (GPIO0/GPIO34)
 * before this became a reusable library; every board wires its mic
 * differently, so these are now the caller's responsibility. */
int wewe_mic_init(int sample_rate_hz, int clk_gpio, int din_gpio);

/* Blocking read of exactly num_samples 16-bit PCM samples. Returns 0 on success. */
int wewe_mic_read(int16_t *buf, int num_samples, int timeout_ms);

#ifdef __cplusplus
}
#endif
