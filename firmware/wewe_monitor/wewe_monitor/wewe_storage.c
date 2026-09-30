#include "wewe_storage.h"

#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_random.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "wewe_storage";
static const char *NVS_NAMESPACE = "wewe";
static const char *KEY_ROOM_ID = "room_id";

#define MAX_AUTHORIZED 8

static void ensure_nvs_init(void) {
    static bool done = false;
    if (done) {
        return;
    }
    /* ESPHome's wifi: component already initializes NVS for its own
     * credential storage; this call is idempotent (a no-op if already
     * initialized) so it's cheap defensive practice, not a real second
     * init. */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    done = true;
}

static void random_hex_id(char *out) {
    uint8_t bytes[WEWE_ID_HEX_LEN / 2];
    esp_fill_random(bytes, sizeof(bytes));
    for (size_t i = 0; i < sizeof(bytes); i++) {
        snprintf(out + i * 2, 3, "%02x", bytes[i]);
    }
}

int wewe_storage_get_or_create_room_id(char *out, size_t out_size) {
    if (out == NULL || out_size < (size_t)WEWE_ID_HEX_LEN + 1) {
        return -1;
    }
    ensure_nvs_init();

    nvs_handle_t handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed");
        return -1;
    }

    size_t len = out_size;
    esp_err_t err = nvs_get_str(handle, KEY_ROOM_ID, out, &len);
    if (err == ESP_OK && len == (size_t)WEWE_ID_HEX_LEN + 1) {
        nvs_close(handle);
        return 0;
    }

    random_hex_id(out);
    out[WEWE_ID_HEX_LEN] = '\0';
    err = nvs_set_str(handle, KEY_ROOM_ID, out);
    if (err == ESP_OK) {
        nvs_commit(handle);
        ESP_LOGI(TAG, "Generated fresh persistent room id");
    } else {
        ESP_LOGE(TAG, "nvs_set_str(room_id) failed: %d", err);
    }
    nvs_close(handle);
    return err == ESP_OK ? 0 : -1;
}

bool wewe_storage_is_listener_authorized(const char *device_id) {
    if (device_id == NULL) {
        return false;
    }
    ensure_nvs_init();

    nvs_handle_t handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }

    char buf[WEWE_ID_HEX_LEN + 1];
    bool found = false;
    for (int i = 0; i < MAX_AUTHORIZED; i++) {
        char key[8];
        snprintf(key, sizeof(key), "auth%d", i);
        size_t len = sizeof(buf);
        if (nvs_get_str(handle, key, buf, &len) == ESP_OK && strcmp(buf, device_id) == 0) {
            found = true;
            break;
        }
    }
    nvs_close(handle);
    return found;
}

int wewe_storage_authorize_listener(const char *device_id) {
    if (device_id == NULL) {
        return -1;
    }
    ensure_nvs_init();

    nvs_handle_t handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return -1;
    }

    char buf[WEWE_ID_HEX_LEN + 1];
    int free_slot = -1;
    for (int i = 0; i < MAX_AUTHORIZED; i++) {
        char key[8];
        snprintf(key, sizeof(key), "auth%d", i);
        size_t len = sizeof(buf);
        esp_err_t err = nvs_get_str(handle, key, buf, &len);
        if (err == ESP_OK) {
            if (strcmp(buf, device_id) == 0) {
                nvs_close(handle);
                return 0; /* already authorized */
            }
        } else if (free_slot < 0) {
            free_slot = i;
        }
    }
    if (free_slot < 0) {
        /* No LRU eviction: MAX_AUTHORIZED (8) comfortably exceeds any
         * realistic household's simultaneous+remembered listener count for
         * this spike; revisit if that assumption ever breaks. */
        ESP_LOGW(TAG, "Authorized-listener list full, refusing new entry");
        nvs_close(handle);
        return -1;
    }

    char key[8];
    snprintf(key, sizeof(key), "auth%d", free_slot);
    esp_err_t err = nvs_set_str(handle, key, device_id);
    if (err == ESP_OK) {
        nvs_commit(handle);
    }
    nvs_close(handle);
    return err == ESP_OK ? 0 : -1;
}
