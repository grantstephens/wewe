/*
 * Host-compilable test for wewe_invite_mode.c — mirrors
 * src/domain/inviteMode.ts's own logic (InviteMode + decideListener).
 * Build/run:
 *   cc -std=c11 -I.. -o /tmp/t wewe_invite_mode_test.c ../wewe_invite_mode.c && /tmp/t
 */

#include "../wewe_invite_mode.h"

#include <stdio.h>

static int failures = 0;

#define EXPECT_TRUE(cond, msg)                                     \
    do {                                                           \
        if (!(cond)) {                                             \
            printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
            failures++;                                            \
        }                                                          \
    } while (0)

static void test_closed_by_default(void) {
    wewe_invite_mode_t mode;
    wewe_invite_mode_init(&mode);
    EXPECT_TRUE(!wewe_invite_mode_is_open(&mode), "closed by default");
}

static void test_open_close_single_holder(void) {
    wewe_invite_mode_t mode;
    wewe_invite_mode_init(&mode);
    wewe_invite_mode_open(&mode, "local");
    EXPECT_TRUE(wewe_invite_mode_is_open(&mode), "open after one holder opens");
    wewe_invite_mode_close(&mode, "local");
    EXPECT_TRUE(!wewe_invite_mode_is_open(&mode), "closed after the only holder closes");
}

static void test_one_holder_closing_does_not_close_another(void) {
    wewe_invite_mode_t mode;
    wewe_invite_mode_init(&mode);
    wewe_invite_mode_open(&mode, "local");
    wewe_invite_mode_open(&mode, "parent-abc");
    wewe_invite_mode_close(&mode, "local");
    EXPECT_TRUE(wewe_invite_mode_is_open(&mode), "still open: another holder has not closed theirs");
    wewe_invite_mode_close(&mode, "parent-abc");
    EXPECT_TRUE(!wewe_invite_mode_is_open(&mode), "closed once the last holder closes");
}

static void test_opening_same_holder_twice_is_idempotent(void) {
    wewe_invite_mode_t mode;
    wewe_invite_mode_init(&mode);
    wewe_invite_mode_open(&mode, "local");
    wewe_invite_mode_open(&mode, "local");
    wewe_invite_mode_close(&mode, "local");
    EXPECT_TRUE(!wewe_invite_mode_is_open(&mode), "double-open collapses to one holder, one close clears it");
}

static void test_closing_unknown_holder_is_a_noop(void) {
    wewe_invite_mode_t mode;
    wewe_invite_mode_init(&mode);
    wewe_invite_mode_open(&mode, "local");
    wewe_invite_mode_close(&mode, "someone-else");
    EXPECT_TRUE(wewe_invite_mode_is_open(&mode), "closing a holder that was never open does not disturb real holders");
}

static void test_decide_listener(void) {
    EXPECT_TRUE(wewe_decide_listener(true, false) == WEWE_LISTENER_ACCEPT_KNOWN, "authorized always accepts as known, regardless of invite mode");
    EXPECT_TRUE(wewe_decide_listener(true, true) == WEWE_LISTENER_ACCEPT_KNOWN, "authorized + invite open still accepts as known");
    EXPECT_TRUE(wewe_decide_listener(false, true) == WEWE_LISTENER_ACCEPT_NEW, "unauthorized + invite open accepts as new");
    EXPECT_TRUE(wewe_decide_listener(false, false) == WEWE_LISTENER_REJECT, "unauthorized + invite closed rejects");
}

int main(void) {
    test_closed_by_default();
    test_open_close_single_holder();
    test_one_holder_closing_does_not_close_another();
    test_opening_same_holder_twice_is_idempotent();
    test_closing_unknown_holder_is_a_noop();
    test_decide_listener();

    if (failures == 0) {
        printf("PASS: all wewe_invite_mode tests passed\n");
        return 0;
    }
    printf("FAIL: %d wewe_invite_mode test(s) failed\n", failures);
    return 1;
}
