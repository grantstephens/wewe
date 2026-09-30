#include "wewe_mic.h"

#include <stdint.h>

#include "driver/i2s_common.h"
#include "driver/i2s_pdm.h"
#include "esp_log.h"

static const char *TAG = "wewe_mic";
static i2s_chan_handle_t s_rx_handle = NULL;

// Real hardware complaint: the SPM1423 PDM mic reads quiet at normal
// room-speech distance. No driver-level gain exists for this on classic
// ESP32 — i2s_pdm_rx_slot_config_t's amplify_num field looks like exactly
// this knob, but checking the actual driver source (not just its header
// comment) shows it's only ever read by the LP I2S PDM variant
// (lp_i2s_pdm.c, S3/C-series chips with a dedicated low-power core);
// the standard PDM RX driver this chip uses (i2s_pdm.c) never touches it.
// 4x (~+12dB) is a moderate boost, not a specific measured target —
// retune here if it's still too quiet or starts clipping on loud sounds.
#define WEWE_MIC_GAIN 4

int wewe_mic_init(int sample_rate_hz, int clk_gpio, int din_gpio) {
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &s_rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel failed: %d", err);
        return -1;
    }

    i2s_pdm_rx_config_t pdm_cfg = {
        .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG((uint32_t)sample_rate_hz),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg =
            {
                .clk = (gpio_num_t)clk_gpio,
                .din = (gpio_num_t)din_gpio,
                .invert_flags = {.clk_inv = false},
            },
    };
    err = i2s_channel_init_pdm_rx_mode(s_rx_handle, &pdm_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_pdm_rx_mode failed: %d", err);
        return -1;
    }

    err = i2s_channel_enable(s_rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_enable failed: %d", err);
        return -1;
    }

    ESP_LOGI(TAG, "PDM mic initialized at %d Hz (clk=GPIO%d, din=GPIO%d)", sample_rate_hz, clk_gpio, din_gpio);
    return 0;
}

int wewe_mic_read(int16_t *buf, int num_samples, int timeout_ms) {
    if (s_rx_handle == NULL) {
        return -1;
    }
    size_t bytes_wanted = (size_t)num_samples * sizeof(int16_t);
    size_t bytes_read = 0;
    esp_err_t err = i2s_channel_read(s_rx_handle, buf, bytes_wanted, &bytes_read, (uint32_t)timeout_ms);
    if (err != ESP_OK || bytes_read != bytes_wanted) {
        return -1;
    }
    for (int i = 0; i < num_samples; i++) {
        int32_t scaled = (int32_t)buf[i] * WEWE_MIC_GAIN;
        if (scaled > INT16_MAX) {
            scaled = INT16_MAX;
        } else if (scaled < INT16_MIN) {
            scaled = INT16_MIN;
        }
        buf[i] = (int16_t)scaled;
    }
    return 0;
}
