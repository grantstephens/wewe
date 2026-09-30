#include "wewe_invite_mode.h"

#include <string.h>

void wewe_invite_mode_init(wewe_invite_mode_t *mode) {
    memset(mode, 0, sizeof(*mode));
}

void wewe_invite_mode_open(wewe_invite_mode_t *mode, const char *holder) {
    for (int i = 0; i < mode->count; i++) {
        if (strcmp(mode->holders[i], holder) == 0) {
            return; /* already a holder */
        }
    }
    if (mode->count >= WEWE_INVITE_MODE_MAX_HOLDERS) {
        return; /* full; a nursery monitor realistically has far fewer than 4 simultaneous inviters */
    }
    strncpy(mode->holders[mode->count], holder, WEWE_INVITE_MODE_HOLDER_LEN - 1);
    mode->holders[mode->count][WEWE_INVITE_MODE_HOLDER_LEN - 1] = '\0';
    mode->count++;
}

void wewe_invite_mode_close(wewe_invite_mode_t *mode, const char *holder) {
    for (int i = 0; i < mode->count; i++) {
        if (strcmp(mode->holders[i], holder) == 0) {
            /* Swap-remove: order among holders doesn't matter. */
            mode->holders[i][0] = '\0';
            memcpy(mode->holders[i], mode->holders[mode->count - 1], WEWE_INVITE_MODE_HOLDER_LEN);
            mode->count--;
            return;
        }
    }
}

bool wewe_invite_mode_is_open(const wewe_invite_mode_t *mode) {
    return mode->count > 0;
}

wewe_listener_decision_t wewe_decide_listener(bool is_authorized, bool invite_mode_open) {
    if (is_authorized) {
        return WEWE_LISTENER_ACCEPT_KNOWN;
    }
    if (invite_mode_open) {
        return WEWE_LISTENER_ACCEPT_NEW;
    }
    return WEWE_LISTENER_REJECT;
}
