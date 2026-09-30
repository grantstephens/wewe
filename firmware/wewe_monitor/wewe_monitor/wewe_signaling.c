#include "wewe_signaling.h"

#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"

static const char *TAG = "wewe_signaling";

/* Singleton: this firmware runs exactly one signaling connection (one
 * Monitor, one WebSocket to signal-server), same as MonitorSession.ts
 * owning exactly one SignalingClient. */
static struct {
    esp_websocket_client_handle_t ws;
    char room[64];
    wewe_signaling_callbacks_t callbacks;
    /* Re-sent on reconnect — see the WEBSOCKET_EVENT_CONNECTED handler's
     * comment for why this specifically must be re-registered, not just
     * the join. */
    char current_alias[16];
    bool has_alias;
    /* Real, reproduced bug: a tap arriving while the socket is mid-
     * reconnect (e.g. recovering from the stale-connection "role-taken"
     * collision a same-persistent-room reflash causes) called set_alias
     * while disconnected — esp_websocket_client silently drops the send
     * ("Websocket client is not connected"), so the code shown on screen
     * never actually became live. Tracked so set_alias can skip the dead
     * send and let it ride on the *next* CONNECTED event instead, which
     * already resends current_alias for exactly this reason. */
    bool connected;
    /* Set from WEBSOCKET_EVENT_CLOSED, serviced by wewe_signaling_poll().
     * See that event's case below for why the restart can't happen
     * synchronously in the event callback itself. */
    bool needs_restart;
    /* Real, reproduced bug: the already-known, already-accepted "role-taken"
     * transient (a stale session's registration hasn't expired server-side
     * yet after a reflash) used to just sit there quietly once — the old
     * client had no auto-recovery after a clean close, so a rejected join
     * was a dead end until something else intervened. Now that a clean
     * close auto-restarts, the relay closing the connection right after
     * rejecting a join turns that into a tight ~2s reconnect loop, which
     * hammered wewe-api.hub13.xyz hard enough to trip its own
     * "rate-limited" response — a real, observed self-inflicted retry
     * storm, not hypothetical. Cooldown-gate restarts so this settles into
     * the relay's own stale-session expiry timing instead of fighting it. */
    int64_t last_restart_ms;
} g_sig;

#define RESTART_COOLDOWN_MS (10 * 1000)

static void send_json(cJSON *json) {
    char *payload = cJSON_PrintUnformatted(json);
    if (payload == NULL) {
        return;
    }
    esp_websocket_client_send_text(g_sig.ws, payload, (int)strlen(payload), portMAX_DELAY);
    free(payload);
}

static void send_join(void) {
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "type", "join");
    cJSON_AddStringToObject(json, "room", g_sig.room);
    cJSON_AddStringToObject(json, "role", "monitor");
    send_json(json);
    cJSON_Delete(json);
}

void wewe_signaling_set_alias(const char *alias) {
    strncpy(g_sig.current_alias, alias, sizeof(g_sig.current_alias) - 1);
    g_sig.current_alias[sizeof(g_sig.current_alias) - 1] = '\0';
    g_sig.has_alias = true;

    if (!g_sig.connected) {
        ESP_LOGW(TAG, "set_alias while disconnected — will resend once reconnected");
        return;
    }

    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "type", "set-alias");
    cJSON_AddStringToObject(json, "alias", alias);
    send_json(json);
    cJSON_Delete(json);
}

void wewe_signaling_send(const char *to_device_id, const cJSON *payload) {
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "type", "signal");
    cJSON_AddItemToObject(json, "payload", cJSON_Duplicate(payload, true));
    cJSON_AddStringToObject(json, "to", to_device_id);
    send_json(json);
    cJSON_Delete(json);
}

static void on_ws_text(const char *text, size_t len) {
    if (len == 0) {
        return;
    }
    cJSON *root = cJSON_ParseWithLength(text, len);
    if (root == NULL) {
        ESP_LOGW(TAG, "Bad JSON from signaling server");
        return;
    }
    cJSON *type = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type)) {
        cJSON_Delete(root);
        return;
    }

    if (strcmp(type->valuestring, "joined") == 0) {
        ESP_LOGI(TAG, "Joined room");
        if (g_sig.callbacks.on_joined) {
            g_sig.callbacks.on_joined(g_sig.callbacks.ctx);
        }
    } else if (strcmp(type->valuestring, "peer-joined") == 0) {
        cJSON *device_id = cJSON_GetObjectItem(root, "deviceId");
        if (cJSON_IsString(device_id) && g_sig.callbacks.on_peer_joined) {
            g_sig.callbacks.on_peer_joined(device_id->valuestring, g_sig.callbacks.ctx);
        }
    } else if (strcmp(type->valuestring, "peer-left") == 0) {
        cJSON *device_id = cJSON_GetObjectItem(root, "deviceId");
        if (cJSON_IsString(device_id) && g_sig.callbacks.on_peer_left) {
            g_sig.callbacks.on_peer_left(device_id->valuestring, g_sig.callbacks.ctx);
        }
    } else if (strcmp(type->valuestring, "signal") == 0) {
        cJSON *from = cJSON_GetObjectItem(root, "from");
        cJSON *payload = cJSON_GetObjectItem(root, "payload");
        if (cJSON_IsString(from) && payload != NULL && g_sig.callbacks.on_signal) {
            g_sig.callbacks.on_signal(from->valuestring, payload, g_sig.callbacks.ctx);
        }
    } else if (strcmp(type->valuestring, "error") == 0) {
        cJSON *message = cJSON_GetObjectItem(root, "message");
        const char *msg = cJSON_IsString(message) ? message->valuestring : "?";
        ESP_LOGE(TAG, "Signaling error: %s", msg);
        if (g_sig.callbacks.on_error) {
            g_sig.callbacks.on_error(msg, g_sig.callbacks.ctx);
        }
    }
    cJSON_Delete(root);
}

static void ws_event_handler(void *ctx, esp_event_base_t base, int32_t event_id, void *event_data) {
    (void)ctx;
    (void)base;
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED:
            ESP_LOGI(TAG, "WebSocket connected, joining room");
            g_sig.connected = true;
            send_join();
            /* A reconnect (network blip, relay restart) is a brand-new
             * socket that never sent set-alias — the relay's alias map
             * entry from before is orphaned. Re-registering the same
             * still-displayed code (not a fresh one) keeps the on-screen
             * countdown meaningful — same fix MonitorSession.ts's own
             * onReconnected makes, for the same real, reproduced bug. Also
             * how a tap that arrived while disconnected (set_alias's own
             * guard skipped its send) actually goes live once we're back. */
            if (g_sig.has_alias) {
                wewe_signaling_set_alias(g_sig.current_alias);
            }
            break;
        case WEBSOCKET_EVENT_DATA:
            if (data->op_code == 0x1 /* text frame */) {
                on_ws_text(data->data_ptr, data->data_len);
            }
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_ERROR:
            g_sig.connected = false;
            ESP_LOGW(TAG, "WebSocket disconnected/error: type=%d status=%d sock_errno=%d",
                     (int)data->error_handle.error_type, (int)data->error_handle.esp_ws_handshake_status_code,
                     (int)data->error_handle.esp_transport_sock_errno);
            break;
        case WEBSOCKET_EVENT_CLOSED:
            /* Real, reproduced bug: after hours idle, whatever sits in
             * front of the relay (a proxy/load balancer's idle-connection
             * timeout) sends a clean WebSocket CLOSE rather than an
             * error/RST. That's WEBSOCKET_EVENT_CLOSED, not DISCONNECTED —
             * a distinct event this handler didn't subscribe to at all, so
             * g_sig.connected stayed stuck "true" forever and a tap's
             * set_alias tried to send on a socket the library itself
             * already considered dead ("Websocket client is not
             * connected"), which is exactly what left the Monitor
             * unreachable until a manual reflash.
             *
             * Unlike WEBSOCKET_EVENT_DISCONNECTED/ERROR (where the
             * client's own task stays alive and reconnects itself
             * internally), a clean close is unrecoverable in the installed
             * esp_websocket_client version (1.4.0, confirmed by reading
             * its actual esp_websocket_client_task() — the CLOSING state
             * handler sets client->run = false and the task vTaskDelete()s
             * itself; there is no enable_close_reconnect option in this
             * version, that's a newer upstream addition). Recovering means
             * calling esp_websocket_client_start() again ourselves — but
             * NOT from here: this callback runs on the client's own
             * dedicated esp_event loop task (esp_event_loop_create() in
             * esp_websocket_client.c), concurrently with the *other* task
             * (the one that dispatched this event) still tearing itself
             * down (closing the transport, then vTaskDelete()ing). Calling
             * start() here would race that teardown. Flag it and let
             * wewe_signaling_poll() (driven by our own Component::loop(),
             * a different task entirely, on its next tick — comfortably
             * after the old task has finished exiting) do the actual
             * restart. */
            g_sig.connected = false;
            g_sig.needs_restart = true;
            ESP_LOGW(TAG, "WebSocket closed cleanly (idle timeout upstream) — restarting");
            break;
        default:
            break;
    }
}

int wewe_signaling_start(const char *signal_url, const char *room, const wewe_signaling_callbacks_t *callbacks) {
    if (signal_url == NULL || room == NULL || callbacks == NULL) {
        return -1;
    }
    memset(&g_sig, 0, sizeof(g_sig));
    g_sig.callbacks = *callbacks;
    strncpy(g_sig.room, room, sizeof(g_sig.room) - 1);

    esp_websocket_client_config_t ws_cfg = {
        .uri = signal_url,
        .task_stack = 8 * 1024,
        .reconnect_timeout_ms = 10 * 1000,
        .network_timeout_ms = 10 * 1000,
        .buffer_size = 8 * 1024,
        .crt_bundle_attach = esp_crt_bundle_attach,
        /* Force-detect a half-open connection (server never sends a close
         * frame, ping/pongs just stop) faster than relying on the OS's own
         * TCP-level timeout, which can take far longer than this. Confirmed
         * present in the installed esp_websocket_client (1.4.0) — unlike
         * enable_close_reconnect, which is a newer upstream field this
         * version doesn't have (see WEBSOCKET_EVENT_CLOSED's case for how
         * a clean close is actually recovered in this version). */
        .pingpong_timeout_sec = 30,
    };
    g_sig.ws = esp_websocket_client_init(&ws_cfg);
    if (g_sig.ws == NULL) {
        return -1;
    }
    esp_websocket_register_events(g_sig.ws, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);
    if (esp_websocket_client_start(g_sig.ws) != ESP_OK) {
        esp_websocket_client_destroy(g_sig.ws);
        g_sig.ws = NULL;
        return -1;
    }
    return 0;
}

void wewe_signaling_stop(void) {
    if (g_sig.ws) {
        esp_websocket_client_stop(g_sig.ws);
        esp_websocket_client_destroy(g_sig.ws);
        g_sig.ws = NULL;
    }
}

void wewe_signaling_poll(void) {
    if (!g_sig.needs_restart || g_sig.ws == NULL) {
        return;
    }
    int64_t now_ms = esp_timer_get_time() / 1000;
    if (now_ms - g_sig.last_restart_ms < RESTART_COOLDOWN_MS) {
        return;  /* still cooling down — needs_restart stays true */
    }
    g_sig.last_restart_ms = now_ms;
    g_sig.needs_restart = false;
    /* Real, reproduced crash: calling esp_websocket_client_start() alone
     * here — even from this separate task, even a full loop() tick after
     * the CLOSED event — still raced the old client task's own post-dispatch
     * cleanup (esp_transport_close() + vTaskDelete(), both happening on
     * *that* task, unsynchronized with either the event dispatch or with
     * us). start()'s internal esp_websocket_client_create_transport() then
     * tore down the same transport the old task was still closing,
     * double-freeing an esp-tls tracker (tlsf_free: "block already marked
     * as free"). esp_websocket_client_stop() is the library's own
     * synchronization primitive for exactly this — it blocks
     * (xEventGroupWaitBits(..., portMAX_DELAY)) until the task has actually
     * set STOPPED_BIT, and explicitly refuses to run from the client's own
     * task (confirmed in the installed 1.4.0 source), which this call
     * site — ESPHome's main loop task, not the websocket client's task —
     * satisfies. If the old task already finished (likely, since some time
     * has passed since the CLOSED event), this returns quickly with an
     * ESP_FAIL "Client was not started" warning, which is harmless and
     * expected, not an error to act on. */
    esp_websocket_client_stop(g_sig.ws);
    esp_err_t err = esp_websocket_client_start(g_sig.ws);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Restart after clean close failed: %d — will retry", err);
        g_sig.needs_restart = true;  /* try again next poll */
    }
}
