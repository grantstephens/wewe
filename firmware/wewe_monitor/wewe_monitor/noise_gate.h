#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Line-for-line C port of src/domain/noiseGate.ts. See that file's doc
 * comment for the full rationale (frozen-EMA-while-open, the
 * reset-on-any-variation stationarity window). Any change here must
 * preserve both invariants — see AGENTS.md.
 */

typedef struct {
    double open_margin_db;         /* dB above the adaptive floor a sample must reach to open the gate. */
    double floor_time_constant_ms; /* Time constant (ms) of the noise-floor EMA. */
    double close_hold_ms;          /* Continuous quiet duration (ms) required before an open gate closes again. */
    double initial_floor_db;       /* Noise floor (dBFS) assumed before any quiet sample has been observed. */
    double stationary_hold_ms;     /* Continuous duration (ms), while open, before a steady level is classified as constant background noise. */
    double stationary_range_db;    /* Max level swing (dB) allowed within the current streak for it to still count as stationary. */
} noise_gate_options_t;

extern const noise_gate_options_t NOISE_GATE_DEFAULT_OPTIONS;

typedef struct {
    noise_gate_options_t options;
    double floor_db;
    bool open_state;

    bool has_last_active;
    int64_t last_active_at_ms;

    bool has_last_sample;
    int64_t last_sample_at_ms;

    bool has_stationary;
    double stationary_min_db;
    double stationary_max_db;
    int64_t stationary_start_ms;
} noise_gate_t;

/* Pass NULL for `options` to use NOISE_GATE_DEFAULT_OPTIONS. */
void noise_gate_init(noise_gate_t *gate, const noise_gate_options_t *options);

/* Feeds one level reading (dBFS) at `timestamp_ms` (any monotonic ms clock); returns the gate's state after it. */
bool noise_gate_push(noise_gate_t *gate, double level_db, int64_t timestamp_ms);

bool noise_gate_is_open(const noise_gate_t *gate);
double noise_gate_floor_db(const noise_gate_t *gate);

#ifdef __cplusplus
}
#endif
