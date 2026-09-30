#include "noise_gate.h"

#include <math.h>
#include <string.h>

const noise_gate_options_t NOISE_GATE_DEFAULT_OPTIONS = {
    .open_margin_db = 12,
    .floor_time_constant_ms = 5000,
    .close_hold_ms = 3000,
    .initial_floor_db = -50,
    .stationary_hold_ms = 15000,
    .stationary_range_db = 3,
};

void noise_gate_init(noise_gate_t *gate, const noise_gate_options_t *options) {
    memset(gate, 0, sizeof(*gate));
    gate->options = options != NULL ? *options : NOISE_GATE_DEFAULT_OPTIONS;
    gate->floor_db = gate->options.initial_floor_db;
}

bool noise_gate_push(noise_gate_t *gate, double level_db, int64_t timestamp_ms) {
    double dt_ms = gate->has_last_sample ? (double)(timestamp_ms - gate->last_sample_at_ms) : 0;
    if (dt_ms < 0) {
        dt_ms = 0;
    }
    gate->last_sample_at_ms = timestamp_ms;
    gate->has_last_sample = true;

    bool is_active = level_db >= gate->floor_db + gate->options.open_margin_db;

    if (is_active) {
        gate->last_active_at_ms = timestamp_ms;
        gate->has_last_active = true;
        gate->open_state = true;

        if (!gate->has_stationary) {
            gate->stationary_min_db = level_db;
            gate->stationary_max_db = level_db;
            gate->stationary_start_ms = timestamp_ms;
            gate->has_stationary = true;
        } else {
            double proposed_min = fmin(gate->stationary_min_db, level_db);
            double proposed_max = fmax(gate->stationary_max_db, level_db);
            if (proposed_max - proposed_min <= gate->options.stationary_range_db) {
                gate->stationary_min_db = proposed_min;
                gate->stationary_max_db = proposed_max;
            } else {
                gate->stationary_min_db = level_db;
                gate->stationary_max_db = level_db;
                gate->stationary_start_ms = timestamp_ms;
            }
        }

        if ((double)(timestamp_ms - gate->stationary_start_ms) >= gate->options.stationary_hold_ms) {
            gate->floor_db = (gate->stationary_min_db + gate->stationary_max_db) / 2.0;
            gate->open_state = false;
            gate->has_stationary = false;
        }

        return gate->open_state;
    }

    /* Any dip below floor + margin is direct evidence the sound isn't
     * constant, so it always resets the stationary streak — even a brief
     * one that close_hold_ms hysteresis papers over for the gate itself. */
    gate->has_stationary = false;

    /* Only a quiet sample, and only while the gate is closed, moves the floor. */
    if (!gate->open_state && dt_ms > 0) {
        double alpha = 1.0 - exp(-dt_ms / gate->options.floor_time_constant_ms);
        gate->floor_db += (level_db - gate->floor_db) * alpha;
    }

    if (gate->open_state && gate->has_last_active &&
        (double)(timestamp_ms - gate->last_active_at_ms) >= gate->options.close_hold_ms) {
        gate->open_state = false;
    }

    return gate->open_state;
}

bool noise_gate_is_open(const noise_gate_t *gate) {
    return gate->open_state;
}

double noise_gate_floor_db(const noise_gate_t *gate) {
    return gate->floor_db;
}
