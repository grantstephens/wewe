#pragma once

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * NVS-backed persistence, mirroring src/domain/deviceId.ts's
 * getOrCreateMonitorRoomId and the Store.isListenerAuthorized/
 * authorizeListener pair this project's phone app already has (see
 * docs/superpowers/specs/2026-09-24-multi-listener-invite-gated-pairing-design.md).
 * Room id and device ids are 32 lowercase hex chars (16 random bytes),
 * matching generateDeviceId()'s shape exactly — an already-paired phone's
 * deviceId must compare byte-for-byte equal against what's stored here.
 */

#define WEWE_ID_HEX_LEN 32 /* not including the null terminator */

/* out must be at least WEWE_ID_HEX_LEN+1 bytes. Generates and persists one on first call. */
int wewe_storage_get_or_create_room_id(char *out, size_t out_size);

bool wewe_storage_is_listener_authorized(const char *device_id);

/* No-ops (returns 0) if device_id is already authorized or the authorized-list is full. */
int wewe_storage_authorize_listener(const char *device_id);

#ifdef __cplusplus
}
#endif
