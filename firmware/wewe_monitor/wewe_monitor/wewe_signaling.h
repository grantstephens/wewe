#pragma once

#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * signal-server client for this firmware's Monitor role, ported from
 * src/webrtc/signalingClient.ts + the deviceId-routing multi-listener
 * protocol in
 * docs/superpowers/specs/2026-09-24-multi-listener-invite-gated-pairing-design.md.
 *
 * Deliberately NOT built on esp_peer_signaling_impl_t (esp_peer_signaling.h,
 * vendored elsewhere in this component): that interface has no concept of
 * "which peer" a message is about — it was shaped for esp_webrtc's
 * single-Monitor-single-Parent model. A room here can hold multiple
 * Parents, so every callback below carries a device_id, mirroring
 * MonitorSession.ts's own onPeerJoined(deviceId)/onPeerLeft(deviceId)/
 * onSignal(payload, from) shape directly.
 */

typedef struct {
    /* The relay has acked our own `join` — the WebSocket is genuinely
     * connected and ready to send on, not just "wewe_signaling_start has
     * returned" (that call only kicks off an async connection; sending
     * before this fires hits esp_websocket_client with "not connected",
     * a real, reproduced bug on first boot). Arm/re-arm pairing mode from
     * here, not eagerly after wewe_signaling_start(). */
    void (*on_joined)(void *ctx);
    /* peer-joined; device_id is the Parent's persistent deviceId. */
    void (*on_peer_joined)(const char *device_id, void *ctx);
    /* peer-left. */
    void (*on_peer_left)(const char *device_id, void *ctx);
    /* An incoming `signal` message. `payload` is owned by the caller
     * (wewe_signaling) and only valid for the duration of this call —
     * copy anything you need to keep. from_device_id is never NULL (a
     * Parent always sends its deviceId; there is only ever one Monitor,
     * so a signal reaching this callback always has a definite sender). */
    void (*on_signal)(const char *from_device_id, cJSON *payload, void *ctx);
    /* A relay-reported error (e.g. "room-expired") or socket failure. */
    void (*on_error)(const char *message, void *ctx);
    void *ctx;
} wewe_signaling_callbacks_t;

/* Connects and joins `room` (this install's persistent room id) as role "monitor". */
int wewe_signaling_start(const char *signal_url, const char *room, const wewe_signaling_callbacks_t *callbacks);

/* Registers `alias` (the displayed pairing code) as a relay alias for this room. */
void wewe_signaling_set_alias(const char *alias);

/* Sends a `signal` message addressed to a specific Parent. Does not take ownership of payload. */
void wewe_signaling_send(const char *to_device_id, const cJSON *payload);

void wewe_signaling_stop(void);

/* Call periodically (e.g. from Component::loop()) to service a pending
 * restart after a clean server-initiated close — see ws_event_handler's
 * WEBSOCKET_EVENT_CLOSED case in wewe_signaling.c for why this can't just
 * call esp_websocket_client_start() directly from the event callback. */
void wewe_signaling_poll(void);

#ifdef __cplusplus
}
#endif
