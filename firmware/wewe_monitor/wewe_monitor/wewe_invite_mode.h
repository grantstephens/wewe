#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * C port of src/domain/inviteMode.ts (InviteMode + decideListener). Tracks
 * who currently holds a Monitor's invite mode open as a set, not a single
 * boolean, so one holder closing its own invite screen can never
 * incorrectly close another holder's still-open one. Holder ids: "local"
 * for the device's own pairing screen, or a Parent's deviceId for one
 * opened remotely.
 */

#define WEWE_INVITE_MODE_MAX_HOLDERS 4
#define WEWE_INVITE_MODE_HOLDER_LEN 33 /* 32 hex chars + null, or "local" */
#define WEWE_INVITE_MODE_LOCAL_HOLDER "local"

typedef struct {
    char holders[WEWE_INVITE_MODE_MAX_HOLDERS][WEWE_INVITE_MODE_HOLDER_LEN];
    int count;
} wewe_invite_mode_t;

void wewe_invite_mode_init(wewe_invite_mode_t *mode);
void wewe_invite_mode_open(wewe_invite_mode_t *mode, const char *holder);
void wewe_invite_mode_close(wewe_invite_mode_t *mode, const char *holder);
bool wewe_invite_mode_is_open(const wewe_invite_mode_t *mode);

typedef enum {
    WEWE_LISTENER_ACCEPT_KNOWN,
    WEWE_LISTENER_ACCEPT_NEW,
    WEWE_LISTENER_REJECT,
} wewe_listener_decision_t;

/* accept-new means both "let it in" and "the caller should now persist it as authorized". */
wewe_listener_decision_t wewe_decide_listener(bool is_authorized, bool invite_mode_open);

#ifdef __cplusplus
}
#endif
