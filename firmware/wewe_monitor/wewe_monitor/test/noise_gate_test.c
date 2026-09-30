/*
 * Host-compilable test harness for noise_gate.c — no ESP-IDF required, mirrors
 * src/domain/noiseGate.test.ts's cases so the C port is checked against the
 * same fixtures the TS version uses. Build/run:
 *
 *   cc -std=c11 -I.. -o /tmp/noise_gate_test noise_gate_test.c ../noise_gate.c -lm && /tmp/noise_gate_test
 */

#include "../noise_gate.h"

#include <stdio.h>
#include <stdlib.h>

static int failures = 0;

#define EXPECT_TRUE(cond, msg)                                       \
    do {                                                             \
        if (!(cond)) {                                               \
            printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__);   \
            failures++;                                              \
        }                                                            \
    } while (0)

#define EXPECT_EQ_BOOL(actual, expected, msg) EXPECT_TRUE((actual) == (expected), msg)
#define EXPECT_GT(actual, bound, msg) EXPECT_TRUE((actual) > (bound), msg)
#define EXPECT_LT(actual, bound, msg) EXPECT_TRUE((actual) < (bound), msg)

/* Feeds `levels` samples `step_ms` apart, starting at `start_ms`; returns gate state after the last one. */
static bool feed(noise_gate_t *gate, const double *levels, int count, int64_t step_ms, int64_t start_ms) {
    bool open = noise_gate_is_open(gate);
    int64_t t = start_ms;
    for (int i = 0; i < count; i++) {
        open = noise_gate_push(gate, levels[i], t);
        t += step_ms;
    }
    return open;
}

static void test_stays_closed_at_initial_floor(void) {
    noise_gate_t gate;
    noise_gate_init(&gate, NULL);
    double levels[50];
    for (int i = 0; i < 50; i++) levels[i] = -50;
    bool open = feed(&gate, levels, 50, 100, 0);
    EXPECT_EQ_BOOL(open, false, "stays closed while readings sit at the initial floor");
}

static void test_opens_past_margin(void) {
    noise_gate_options_t opts = NOISE_GATE_DEFAULT_OPTIONS;
    opts.initial_floor_db = -50;
    opts.open_margin_db = 12;
    noise_gate_t gate;
    noise_gate_init(&gate, &opts);
    EXPECT_EQ_BOOL(noise_gate_push(&gate, -50, 0), false, "opens as soon as a sample clears floor + openMarginDb (t0)");
    EXPECT_EQ_BOOL(noise_gate_push(&gate, -30, 100), true, "opens as soon as a sample clears floor + openMarginDb (t1)");
}

static void test_close_hold_hysteresis(void) {
    noise_gate_options_t opts = NOISE_GATE_DEFAULT_OPTIONS;
    opts.initial_floor_db = -50;
    opts.open_margin_db = 12;
    opts.close_hold_ms = 3000;
    noise_gate_t gate;
    noise_gate_init(&gate, &opts);
    noise_gate_push(&gate, -20, 0); /* opens */
    EXPECT_EQ_BOOL(noise_gate_push(&gate, -55, 1000), true,
                   "does not close immediately on a brief dip below threshold (closeHoldMs hysteresis)");
}

static void test_closes_past_close_hold(void) {
    noise_gate_options_t opts = NOISE_GATE_DEFAULT_OPTIONS;
    opts.initial_floor_db = -50;
    opts.open_margin_db = 12;
    opts.close_hold_ms = 3000;
    noise_gate_t gate;
    noise_gate_init(&gate, &opts);
    noise_gate_push(&gate, -20, 0); /* opens */
    noise_gate_push(&gate, -55, 1000);
    EXPECT_EQ_BOOL(noise_gate_push(&gate, -55, 4001), false, "closes once quiet persists past closeHoldMs");
}

static void test_floor_adapts_upward(void) {
    noise_gate_options_t opts = NOISE_GATE_DEFAULT_OPTIONS;
    opts.initial_floor_db = -50;
    opts.floor_time_constant_ms = 1000;
    noise_gate_t gate;
    noise_gate_init(&gate, &opts);
    double levels[200];
    for (int i = 0; i < 200; i++) levels[i] = -40;
    feed(&gate, levels, 200, 100, 0);
    EXPECT_GT(noise_gate_floor_db(&gate), -45, "adapts the floor upward toward a sustained quieter-than-initial ambient level (lower bound)");
    EXPECT_LT(noise_gate_floor_db(&gate), -39, "adapts the floor upward toward a sustained quieter-than-initial ambient level (upper bound)");
}

static void test_floor_frozen_while_open(void) {
    noise_gate_options_t opts = NOISE_GATE_DEFAULT_OPTIONS;
    opts.initial_floor_db = -50;
    opts.open_margin_db = 12;
    opts.floor_time_constant_ms = 200;
    opts.close_hold_ms = 60000;
    noise_gate_t gate;
    noise_gate_init(&gate, &opts);
    noise_gate_push(&gate, -20, 0); /* opens; a real implementation must freeze the floor here */
    for (int i = 1; i <= 50; i++) {
        noise_gate_push(&gate, -20, (int64_t)i * 100); /* sustained loud cry */
    }
    EXPECT_TRUE(noise_gate_floor_db(&gate) == -50, "never adapts the floor while the gate is open (floor)");
    EXPECT_EQ_BOOL(noise_gate_is_open(&gate), true, "never adapts the floor while the gate is open (still open)");
}

static void test_filters_stationary_noise(void) {
    noise_gate_options_t opts = NOISE_GATE_DEFAULT_OPTIONS;
    opts.initial_floor_db = -50;
    opts.open_margin_db = 12;
    opts.stationary_hold_ms = 5000;
    opts.stationary_range_db = 3;
    noise_gate_t gate;
    noise_gate_init(&gate, &opts);
    double levels[60];
    for (int i = 0; i < 60; i++) levels[i] = -20; /* 5.9s of a perfectly flat "white noise machine" tone */
    bool open = feed(&gate, levels, 60, 100, 0);
    EXPECT_EQ_BOOL(open, false, "filters out a sustained, unmodulating noise source once past stationaryHoldMs (open)");
    EXPECT_GT(noise_gate_floor_db(&gate), -25, "filters out a sustained, unmodulating noise source (floor lower bound)");
    EXPECT_LT(noise_gate_floor_db(&gate), -15, "filters out a sustained, unmodulating noise source (floor upper bound)");
}

static void test_never_filters_modulating_source(void) {
    noise_gate_options_t opts = NOISE_GATE_DEFAULT_OPTIONS;
    opts.initial_floor_db = -50;
    opts.open_margin_db = 12;
    opts.close_hold_ms = 3000;
    opts.stationary_hold_ms = 5000;
    opts.stationary_range_db = 3;
    noise_gate_t gate;
    noise_gate_init(&gate, &opts);

    double levels[6 * 11];
    int n = 0;
    for (int cycle = 0; cycle < 6; cycle++) {
        for (int i = 0; i < 9; i++) levels[n++] = -20; /* sustained wail */
        levels[n++] = -45;                             /* breath between wails, below floor + margin */
        levels[n++] = -45;
    }
    bool open = feed(&gate, levels, n, 100, 0); /* 6.6s total, longer than the 5s hold that would filter a flat tone */
    EXPECT_EQ_BOOL(open, true, "never filters a modulating source — cry-like pattern with breathing gaps stays open");
}

static void test_reopens_after_learned_floor(void) {
    noise_gate_options_t opts = NOISE_GATE_DEFAULT_OPTIONS;
    opts.initial_floor_db = -50;
    opts.open_margin_db = 12;
    opts.stationary_hold_ms = 3000;
    opts.stationary_range_db = 3;
    noise_gate_t gate;
    noise_gate_init(&gate, &opts);
    double levels[35];
    for (int i = 0; i < 35; i++) levels[i] = -30; /* ~3.5s flat tone -> learned as noise, floor snaps to ~-30 */
    feed(&gate, levels, 35, 100, 0);
    EXPECT_EQ_BOOL(noise_gate_is_open(&gate), false, "reopens for a genuine loud event after floor snap (closed after learning)");
    EXPECT_EQ_BOOL(noise_gate_push(&gate, -10, 3600), true,
                   "reopens for a genuine loud event after floor snap (cry above learned floor)");
}

int main(void) {
    test_stays_closed_at_initial_floor();
    test_opens_past_margin();
    test_close_hold_hysteresis();
    test_closes_past_close_hold();
    test_floor_adapts_upward();
    test_floor_frozen_while_open();
    test_filters_stationary_noise();
    test_never_filters_modulating_source();
    test_reopens_after_learned_floor();

    if (failures == 0) {
        printf("PASS: all noise_gate tests passed\n");
        return 0;
    }
    printf("FAIL: %d noise_gate test(s) failed\n", failures);
    return 1;
}
