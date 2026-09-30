# wewe_monitor Reusable Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the ESP32 firmware's hardware-agnostic core (currently
`firmware/core2-spike/components/wewe_webrtc_spike/`) as a standalone,
git-importable ESPHome component named `wewe_monitor`, leaving Core2-specific
glue (`wewe_axp192`, the display/touch UI) in `firmware/core2-spike/` as a
reference example that imports the library.

**Architecture:** Move the component files verbatim into
`firmware/wewe_monitor/wewe_monitor/`, renaming the namespace/class/component
key from `wewe_webrtc_spike`/`WeweWebrtcSpike` to `wewe_monitor`/`WeweMonitor`.
Then widen the config surface exactly where it's currently hardcoded in a way
that blocks reuse on different hardware: mic GPIO pins (required, currently
hardcoded to the Core2's wiring), max concurrent listeners and ICE/STUN
servers (both optional, defaulting to today's hardcoded values so behavior is
unchanged unless someone opts in). No functional/protocol changes.

**Tech Stack:** ESPHome external_component (Python `__init__.py` +
C/C++), ESP-IDF, existing host-compilable C test harnesses (plain `gcc`, no
ESP-IDF needed) for the two pure-logic modules.

**Spec:** `docs/superpowers/specs/2026-09-30-wewe-monitor-reusable-esphome-library-design.md`

## Global Constraints

- Component name: `wewe_monitor` (both the YAML key and the C++ namespace).
- Library location: `firmware/wewe_monitor/wewe_monitor/` (the nested
  directory is deliberate — `external_components: source: {type: local/git,
  path: firmware/wewe_monitor}` points at the outer `wewe_monitor/`, and
  ESPHome's own convention is that the actual component directory, named
  after the component key, sits one level inside the path you point at).
- Every optional config default must reproduce today's exact hardcoded
  behavior when omitted — this is a packaging change, not a functional one.
- No change to the wire protocol, pairing model, or noise-gate algorithm.
- Every task that touches C/C++ must be verified with a real `esphome
  compile` (or the host-compilable test harness for pure-logic files) with
  its actual exit code checked from the log, never assumed from a task
  summary — this project's own established, hard-won convention after a
  session that caught a false "success" this way at least once.
- `id: wewe` (or whatever id the reference example's YAML gives the
  component instance) never needs to change — only the top-level YAML key
  (`wewe_webrtc_spike:` → `wewe_monitor:`) does. The display lambda's
  `id(wewe)` references throughout `spike.yaml` are untouched by this plan.

## Review Focus

- `max_listeners` outside its valid range (0, or above the cap) must be
  rejected by config validation, not silently clamped or allowed through to
  a bad compile-time array size — tested in Task 3.
- `ice_servers: []` (an empty list) must be rejected by config validation —
  an empty STUN server list would silently break NAT traversal for anyone
  who typos this — tested in Task 4.
- Stale references to the old `wewe_webrtc_spike` name anywhere under
  `firmware/` after the move (a half-renamed file, a leftover import, a
  comment) — tested in Task 1 via a repo-wide grep.
- The two host-compilable pure-logic test suites (`noise_gate_test.c`,
  `wewe_invite_mode_test.c`) must still pass, unchanged, after the
  mechanical move — confirms the rename didn't accidentally alter the pure-C
  logic itself, not just the surrounding component scaffolding — tested in
  Task 1.
- The README's documented config keys and defaults must match the real
  schema in `__init__.py` exactly — docs written after code are exactly
  where drift creeps in — tested in Task 5 via an explicit cross-check.

---

## Task 1: Move and rename the component to `firmware/wewe_monitor/`

**Files:**
- Move (git mv): every file currently under
  `firmware/core2-spike/components/wewe_webrtc_spike/` to
  `firmware/wewe_monitor/wewe_monitor/`, including the `test/` subdirectory.
  Specifically:
  - `__init__.py`
  - `wewe_webrtc_spike.h` → renamed to `wewe_monitor.h`
  - `wewe_webrtc_spike.cpp` → renamed to `wewe_monitor.cpp`
  - `wewe_signaling.h`, `wewe_signaling.c`
  - `wewe_storage.h`, `wewe_storage.c`
  - `wewe_invite_mode.h`, `wewe_invite_mode.c`
  - `wewe_mic.h`, `wewe_mic.c`
  - `wewe_g711.h`, `wewe_g711.c`
  - `noise_gate.h`, `noise_gate.c`
  - `test/wewe_invite_mode_test.c`
  - `test/noise_gate_test.c`
- Modify: `firmware/core2-spike/spike.yaml` (the `external_components:`
  source and the top-level component key)
- Delete: `firmware/core2-spike/components/wewe_webrtc_spike/__pycache__/`
  (untracked build cruft, not part of the `git mv`)

**Interfaces:**
- Produces: an ESPHome component reachable via `external_components:
  source: {type: local, path: ../wewe_monitor}` (relative from
  `firmware/core2-spike/`) using YAML key `wewe_monitor:`, class
  `esphome::wewe_monitor::WeweMonitor`. Every existing public method on the
  class (`set_signal_url`, `on_pair_tapped`, `current_code`,
  `seconds_remaining`, `connected_listener_count`, `on_screen_touched`,
  `is_screen_on`, `seconds_since_last_sound`) is unchanged in name and
  signature — only the class and namespace names around them change.

- [ ] **Step 1: Move every file with `git mv`, preserving history**

```bash
cd /home/grant/sync/Code/wewe
mkdir -p firmware/wewe_monitor/wewe_monitor/test
git mv firmware/core2-spike/components/wewe_webrtc_spike/__init__.py firmware/wewe_monitor/wewe_monitor/__init__.py
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_webrtc_spike.h firmware/wewe_monitor/wewe_monitor/wewe_monitor.h
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_webrtc_spike.cpp firmware/wewe_monitor/wewe_monitor/wewe_monitor.cpp
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_signaling.h firmware/wewe_monitor/wewe_monitor/wewe_signaling.h
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_signaling.c firmware/wewe_monitor/wewe_monitor/wewe_signaling.c
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_storage.h firmware/wewe_monitor/wewe_monitor/wewe_storage.h
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_storage.c firmware/wewe_monitor/wewe_monitor/wewe_storage.c
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_invite_mode.h firmware/wewe_monitor/wewe_monitor/wewe_invite_mode.h
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_invite_mode.c firmware/wewe_monitor/wewe_monitor/wewe_invite_mode.c
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_mic.h firmware/wewe_monitor/wewe_monitor/wewe_mic.h
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_mic.c firmware/wewe_monitor/wewe_monitor/wewe_mic.c
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_g711.h firmware/wewe_monitor/wewe_monitor/wewe_g711.h
git mv firmware/core2-spike/components/wewe_webrtc_spike/wewe_g711.c firmware/wewe_monitor/wewe_monitor/wewe_g711.c
git mv firmware/core2-spike/components/wewe_webrtc_spike/noise_gate.h firmware/wewe_monitor/wewe_monitor/noise_gate.h
git mv firmware/core2-spike/components/wewe_webrtc_spike/noise_gate.c firmware/wewe_monitor/wewe_monitor/noise_gate.c
git mv firmware/core2-spike/components/wewe_webrtc_spike/test/wewe_invite_mode_test.c firmware/wewe_monitor/wewe_monitor/test/wewe_invite_mode_test.c
git mv firmware/core2-spike/components/wewe_webrtc_spike/test/noise_gate_test.c firmware/wewe_monitor/wewe_monitor/test/noise_gate_test.c
rm -rf firmware/core2-spike/components/wewe_webrtc_spike
```

- [ ] **Step 2: Rename the namespace and class throughout every moved file**

Every moved `.h`/`.c`/`.cpp` file may reference `wewe_webrtc_spike` (as a
namespace) or `WeweWebrtcSpike` (as a class name) or `wewe_webrtc_spike.h`
(as an include). Replace all three, everywhere, under the new directory:

```bash
cd /home/grant/sync/Code/wewe/firmware/wewe_monitor/wewe_monitor
grep -rl 'wewe_webrtc_spike\|WeweWebrtcSpike' . | xargs sed -i \
  -e 's/wewe_webrtc_spike\.h/wewe_monitor.h/g' \
  -e 's/wewe_webrtc_spike/wewe_monitor/g' \
  -e 's/WeweWebrtcSpike/WeweMonitor/g'
```

This also fixes the `#include "wewe_webrtc_spike.h"` at the top of
`wewe_monitor.cpp` (now correctly `#include "wewe_monitor.h"`), the
`namespace wewe_webrtc_spike { ... }` blocks in both the header and cpp, and
the `static const char *TAG = "wewe_webrtc_spike";`-style log tag if one
exists (check with `grep -n 'TAG = ' wewe_monitor.cpp` — if the tag string
is something else, like `"wewe_monitor"` already or a per-module tag such as
`"wewe_signaling"`, leave those alone; this step only touches actual
`wewe_webrtc_spike`/`WeweWebrtcSpike` occurrences).

- [ ] **Step 3: Update `__init__.py`'s component registration**

The `sed` in Step 2 already renamed `wewe_webrtc_spike_ns` →
`wewe_monitor_ns` and `WeweWebrtcSpike` → `WeweMonitor` inside
`__init__.py`. Confirm the result reads correctly:

```python
wewe_monitor_ns = cg.esphome_ns.namespace("wewe_monitor")
WeweMonitor = wewe_monitor_ns.class_("WeweMonitor", cg.Component)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(WeweMonitor),
        cv.Required(CONF_SIGNAL_URL): cv.string_strict,
    }
).extend(cv.COMPONENT_SCHEMA)
```

(The rest of `__init__.py` — `add_idf_component`, `add_idf_sdkconfig_option`,
`include_builtin_idf_component` calls — is untouched by this task; those
change in later tasks only where noted.)

- [ ] **Step 4: Update `firmware/core2-spike/spike.yaml`'s external_components source and component key**

Find the current block:

```yaml
external_components:
  - source:
      type: local
      path: components
```

and the component config block currently keyed `wewe_webrtc_spike:`.
Change to:

```yaml
external_components:
  - source:
      type: local
      path: ../wewe_monitor
```

and rename the component block's YAML key from `wewe_webrtc_spike:` to
`wewe_monitor:` — keep every other line in that block (including `id: wewe`
and `signal_url: ...`) exactly as-is:

```yaml
wewe_monitor:
  id: wewe
  signal_url: "wss://wewe-api.hub13.xyz"
```

Do not touch anything referencing `id(wewe)` elsewhere in `spike.yaml` (the
display lambda, the touch `binary_sensor:` blocks) — that id is unchanged.

- [ ] **Step 5: Repo-wide grep for stale references to the old name**

```bash
cd /home/grant/sync/Code/wewe
grep -rn "wewe_webrtc_spike\|WeweWebrtcSpike" firmware/ --include="*.py" --include="*.h" --include="*.c" --include="*.cpp" --include="*.yaml"
```

Expected: no output. If anything appears, fix it before continuing — this
is the Review Focus item for this task (a half-renamed reference is exactly
the kind of thing a mechanical multi-file rename misses).

- [ ] **Step 6: Run both host-compilable pure-logic test suites from their new location**

These need no ESP-IDF toolchain — plain `cc` against the test harness each
file already has. Each test file's own top-of-file comment documents its
exact build command; run from inside the `test/` directory, exactly as
documented (note the `-I..` and `../*.c` relative paths — these do not run
from the parent directory):

```bash
cd /home/grant/sync/Code/wewe/firmware/wewe_monitor/wewe_monitor/test
cc -std=c11 -I.. -o /tmp/noise_gate_test noise_gate_test.c ../noise_gate.c -lm && /tmp/noise_gate_test; echo "NOISE_GATE_EXIT=$?"
cc -std=c11 -I.. -o /tmp/invite_mode_test wewe_invite_mode_test.c ../wewe_invite_mode.c && /tmp/invite_mode_test; echo "INVITE_MODE_EXIT=$?"
```

Expected: both exit 0, all test groups reported passing (matching the exact
same output these produced before the move — this confirms the mechanical
rename didn't alter the pure-C logic itself).

- [ ] **Step 7: Compile the reference example against the moved library**

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
esphome compile spike.yaml > /tmp/wewe_monitor_task1_compile.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_monitor_task1_compile.log
grep COMPILE_EXIT /tmp/wewe_monitor_task1_compile.log
```

Expected: `COMPILE_EXIT=0`. If it fails, read the actual compiler error from
the log — don't guess. The most likely failure mode at this step is a
missed rename occurrence Step 2's `sed` didn't catch (e.g. a namespace
closing-brace comment like `}  // namespace wewe_webrtc_spike` that Step 5's
grep should have already caught — if it didn't, the grep pattern in Step 5
missed something and needs fixing too).

- [ ] **Step 8: Flash to real hardware and confirm a clean boot**

```bash
esphome upload --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_monitor_task1_upload.log 2>&1
echo "UPLOAD_EXIT=$?" >> /tmp/wewe_monitor_task1_upload.log
grep UPLOAD_EXIT /tmp/wewe_monitor_task1_upload.log
```

Expected: `UPLOAD_EXIT=0`. Then capture ~15s of boot log (background it,
kill it after) and confirm no crash/assert/backtrace:

```bash
timeout 15 esphome logs --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_monitor_task1_boot.log 2>&1
grep -iE "error|crash|abort|assert|guru|panic|backtrace|stack overflow" /tmp/wewe_monitor_task1_boot.log
```

Expected: no matches (aside from the already-known, benign `role-taken`
retry warning if the persistent room happens to still be registered from a
previous session — that's not a regression, it's expected relay behavior
documented elsewhere in this project).

- [ ] **Step 9: Commit**

```bash
cd /home/grant/sync/Code/wewe
git add firmware/
git commit -m "$(cat <<'EOF'
refactor(firmware): move wewe_webrtc_spike to firmware/wewe_monitor/, rename to wewe_monitor

Pure move + rename, no functional changes — separates the hardware-agnostic
core (signaling, pairing, WebRTC, mic capture, noise gate) from the Core2
reference example, which now imports it as an external component instead
of owning it directly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Make mic GPIO pins configurable (required YAML config)

**Files:**
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_mic.h`
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_mic.c`
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_monitor.h`
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_monitor.cpp`
- Modify: `firmware/wewe_monitor/wewe_monitor/__init__.py`
- Modify: `firmware/core2-spike/spike.yaml`

**Interfaces:**
- Consumes: nothing new from Task 1 beyond the renamed files already in
  place.
- Produces: `wewe_mic_init(int sample_rate_hz, int clk_gpio, int din_gpio)`
  (was `wewe_mic_init(int sample_rate_hz)`) — Task 4 does not call this
  function, so this signature change has no other consumers in this plan.
  `WeweMonitor::set_clk_pin(int)` / `set_din_pin(int)` — new public setters,
  called once each from generated code, mirroring `set_signal_url`'s
  existing shape.

- [ ] **Step 1: Change `wewe_mic_init`'s signature and the hardcoded pins in `wewe_mic.h`**

Replace:

```c
/* Sets up I2S0 in PDM RX mode at the given sample rate, mono, 16-bit PCM. */
int wewe_mic_init(int sample_rate_hz);
```

with:

```c
/* Sets up I2S0 in PDM RX mode at the given sample rate, mono, 16-bit PCM.
 * clk_gpio/din_gpio are the board's PDM clock (ESP32 output) and data
 * (ESP32 input) pins — hardcoded to the Core2's wiring (GPIO0/GPIO34)
 * before this became a reusable library; every board wires its mic
 * differently, so these are now the caller's responsibility. */
int wewe_mic_init(int sample_rate_hz, int clk_gpio, int din_gpio);
```

Also update the file's top-of-file doc comment — it currently states "Pin
mapping (CLK=GPIO0, DATA=GPIO34) confirmed via M5Stack community
documentation" as if those are the only valid pins for this module; reword
to make clear those are just the Core2's specific wiring, passed in by the
caller, not hardcoded in this file anymore:

```c
/*
 * I2S PDM RX capture for a PDM microphone (tested against the Core2's
 * onboard SPM1423; should work with any I2S-PDM-compatible mic). Pins are
 * supplied by the caller via wewe_mic_init() — see wewe_monitor's own
 * clk_pin/din_pin config for how they reach here on a real board.
 *
 * Uses ESP-IDF's hardware PDM-to-PCM filter (SOC_I2S_SUPPORTS_PDM2PCM),
 * so this hands back real 16-bit PCM directly — no manual PDM decimation.
 */
```

- [ ] **Step 2: Update `wewe_mic.c`'s implementation to use the passed-in pins**

Replace:

```c
int wewe_mic_init(int sample_rate_hz) {
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &s_rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel failed: %d", err);
        return -1;
    }

    i2s_pdm_rx_config_t pdm_cfg = {
        .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG((uint32_t)sample_rate_hz),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg =
            {
                .clk = GPIO_NUM_0,
                .din = GPIO_NUM_34,
                .invert_flags = {.clk_inv = false},
            },
    };
    err = i2s_channel_init_pdm_rx_mode(s_rx_handle, &pdm_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_pdm_rx_mode failed: %d", err);
        return -1;
    }

    err = i2s_channel_enable(s_rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_enable failed: %d", err);
        return -1;
    }

    ESP_LOGI(TAG, "PDM mic initialized at %d Hz (clk=GPIO0, din=GPIO34)", sample_rate_hz);
    return 0;
}
```

with:

```c
int wewe_mic_init(int sample_rate_hz, int clk_gpio, int din_gpio) {
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    esp_err_t err = i2s_new_channel(&chan_cfg, NULL, &s_rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel failed: %d", err);
        return -1;
    }

    i2s_pdm_rx_config_t pdm_cfg = {
        .clk_cfg = I2S_PDM_RX_CLK_DEFAULT_CONFIG((uint32_t)sample_rate_hz),
        .slot_cfg = I2S_PDM_RX_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg =
            {
                .clk = (gpio_num_t)clk_gpio,
                .din = (gpio_num_t)din_gpio,
                .invert_flags = {.clk_inv = false},
            },
    };
    err = i2s_channel_init_pdm_rx_mode(s_rx_handle, &pdm_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_init_pdm_rx_mode failed: %d", err);
        return -1;
    }

    err = i2s_channel_enable(s_rx_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_channel_enable failed: %d", err);
        return -1;
    }

    ESP_LOGI(TAG, "PDM mic initialized at %d Hz (clk=GPIO%d, din=GPIO%d)", sample_rate_hz, clk_gpio, din_gpio);
    return 0;
}
```

- [ ] **Step 3: Add `clk_pin_`/`din_pin_` members and setters to `wewe_monitor.h`**

Find:

```cpp
  void set_signal_url(const std::string &url) { signal_url_ = url; }
```

Add immediately after it:

```cpp
  void set_clk_pin(int pin) { clk_pin_ = pin; }
  void set_din_pin(int pin) { din_pin_ = pin; }
```

Find the `protected:` section's member list:

```cpp
  std::string signal_url_;
  bool started_ = false;
```

Add the two new members:

```cpp
  std::string signal_url_;
  int clk_pin_ = -1;
  int din_pin_ = -1;
  bool started_ = false;
```

- [ ] **Step 4: Pass the configured pins into `wewe_mic_init()` in `wewe_monitor.cpp`**

Find:

```cpp
  if (wewe_mic_init(8000) != 0) {
```

Replace with:

```cpp
  if (wewe_mic_init(8000, this->clk_pin_, this->din_pin_) != 0) {
```

- [ ] **Step 5: Add the required `clk_pin`/`din_pin` config to `__init__.py`**

Add the import at the top (alongside the existing `esphome.codegen`/`esphome.config_validation` imports):

```python
from esphome import pins
```

Add the two new config key constants next to the existing
`CONF_SIGNAL_URL = "signal_url"`:

```python
CONF_CLK_PIN = "clk_pin"
CONF_DIN_PIN = "din_pin"
```

Update `CONFIG_SCHEMA` to require both — the clock line is an ESP32 output
(it drives the PDM clock to the mic), the data line is an ESP32 input
(it reads PDM data from the mic), so they use the corresponding directional
pin-number validators:

```python
CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(WeweMonitor),
        cv.Required(CONF_SIGNAL_URL): cv.string_strict,
        cv.Required(CONF_CLK_PIN): pins.internal_gpio_output_pin_number,
        cv.Required(CONF_DIN_PIN): pins.internal_gpio_input_pin_number,
    }
).extend(cv.COMPONENT_SCHEMA)
```

Update `to_code()` to pass them through — find:

```python
    cg.add(var.set_signal_url(config[CONF_SIGNAL_URL]))
```

Add immediately after:

```python
    cg.add(var.set_clk_pin(config[CONF_CLK_PIN]))
    cg.add(var.set_din_pin(config[CONF_DIN_PIN]))
```

- [ ] **Step 6: Add `clk_pin`/`din_pin` to the reference example's YAML**

In `firmware/core2-spike/spike.yaml`, under the `wewe_monitor:` block,
add the Core2's actual wiring (matching exactly what was hardcoded before
this task):

```yaml
wewe_monitor:
  id: wewe
  signal_url: "wss://wewe-api.hub13.xyz"
  clk_pin: GPIO0
  din_pin: GPIO34
```

- [ ] **Step 7: Compile and verify the real exit code**

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
esphome compile spike.yaml > /tmp/wewe_monitor_task2_compile.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_monitor_task2_compile.log
grep COMPILE_EXIT /tmp/wewe_monitor_task2_compile.log
```

Expected: `COMPILE_EXIT=0`.

- [ ] **Step 8: Flash and confirm the mic actually still initializes**

```bash
esphome upload --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_monitor_task2_upload.log 2>&1
echo "UPLOAD_EXIT=$?" >> /tmp/wewe_monitor_task2_upload.log
grep UPLOAD_EXIT /tmp/wewe_monitor_task2_upload.log
```

Expected: `UPLOAD_EXIT=0`. Then:

```bash
timeout 15 esphome logs --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_monitor_task2_boot.log 2>&1
grep "PDM mic initialized" /tmp/wewe_monitor_task2_boot.log
grep -iE "error|crash|abort|assert|guru|panic|backtrace|stack overflow|wewe_mic_init failed" /tmp/wewe_monitor_task2_boot.log
```

Expected: the "PDM mic initialized at 8000 Hz (clk=GPIO0, din=GPIO34)" line
present (confirming the configured pins actually reached the C call, not
just that the build succeeded), and no crash/error matches. This is the one
step in this task that specifically needs real-hardware confirmation, since
it's the only place a config change could silently break actual audio
capture without the compiler ever noticing.

- [ ] **Step 9: Commit**

```bash
cd /home/grant/sync/Code/wewe
git add firmware/
git commit -m "$(cat <<'EOF'
feat(wewe_monitor): make mic clk_pin/din_pin required YAML config

Was hardcoded to the Core2's wiring (GPIO0/GPIO34) — the one real blocker
to using this library on different hardware, since every board wires its
mic to different pins.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Make `max_listeners` configurable (optional, compile-time)

**Files:**
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_monitor.cpp`
- Modify: `firmware/wewe_monitor/wewe_monitor/__init__.py`

**Interfaces:**
- Consumes: nothing new from Tasks 1-2.
- Produces: a `WEWE_MAX_LISTENERS` preprocessor define, injected by
  `cg.add_define()` when `max_listeners` is set in YAML (ESPHome
  automatically includes its generated `defines.h`, containing this define,
  in every compiled file — no new `#include` needed in `wewe_monitor.cpp`
  for this to take effect).

**Why compile-time, not runtime:** `MAX_LISTENERS` sizes a fixed C array
(`Listener listeners[MAX_LISTENERS];` inside `RuntimeState`) — C array sizes
must be compile-time constants, so this can't become a runtime-configurable
class member without restructuring `Listener` storage into a dynamically-sized
container, which is out of scope here (see the spec's Non-goals: packaging
only, no functional restructuring).

- [ ] **Step 1: Replace the hardcoded `#define` with a default-guarded one**

In `wewe_monitor.cpp`, find:

```cpp
#define MAX_LISTENERS 3
```

Replace with:

```cpp
#ifndef WEWE_MAX_LISTENERS
#define WEWE_MAX_LISTENERS 3
#endif
#define MAX_LISTENERS WEWE_MAX_LISTENERS
```

Every existing use of `MAX_LISTENERS` elsewhere in the file (the array
declaration, the "Max listeners reached" warning log) is unchanged — this
is the only line that changes. When YAML doesn't set `max_listeners`,
`WEWE_MAX_LISTENERS` is never defined by codegen, so the `#ifndef` guard
supplies `3` — byte-for-byte the same behavior as before this task.

- [ ] **Step 2: Add the optional `max_listeners` config to `__init__.py`**

Add the constant next to the others:

```python
CONF_MAX_LISTENERS = "max_listeners"
```

Update `CONFIG_SCHEMA`:

```python
CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(WeweMonitor),
        cv.Required(CONF_SIGNAL_URL): cv.string_strict,
        cv.Required(CONF_CLK_PIN): pins.internal_gpio_output_pin_number,
        cv.Required(CONF_DIN_PIN): pins.internal_gpio_input_pin_number,
        cv.Optional(CONF_MAX_LISTENERS, default=3): cv.int_range(min=1, max=8),
    }
).extend(cv.COMPONENT_SCHEMA)
```

(The `max=8` cap matches `wewe_storage.c`'s own `MAX_AUTHORIZED` limit for
persisted authorized-listener slots — a `max_listeners` value that could
never be reached by any actually-persistable listener isn't meaningful.)

Update `to_code()` — add after the existing `cg.add(...)` calls, near the
other `add_idf_sdkconfig_option`/`include_builtin_idf_component` calls:

```python
    cg.add_define("WEWE_MAX_LISTENERS", config[CONF_MAX_LISTENERS])
```

- [ ] **Step 3: Verify the default path compiles unchanged**

`firmware/core2-spike/spike.yaml` doesn't set `max_listeners` — it should
keep compiling exactly as before, now via the default-3 path:

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
esphome compile spike.yaml > /tmp/wewe_monitor_task3_default.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_monitor_task3_default.log
grep COMPILE_EXIT /tmp/wewe_monitor_task3_default.log
grep -n "WEWE_MAX_LISTENERS" .esphome/build/*/defines.h
```

Expected: `COMPILE_EXIT=0`, and the `defines.h` grep shows
`#define WEWE_MAX_LISTENERS 3` (confirming the default actually made it
into the generated defines file, not just that the Python schema has a
default value — those are two different things and this step checks the
one that actually matters).

- [ ] **Step 4: Verify a custom value takes effect — Review Focus test 1 of 2**

Make a scratch copy of the YAML with a non-default value, to prove the
config plumbing actually works without needing real hardware for it:

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
cp spike.yaml /tmp/wewe_monitor_task3_custom.yaml
sed -i '/^wewe_monitor:/a\  max_listeners: 1' /tmp/wewe_monitor_task3_custom.yaml
esphome compile /tmp/wewe_monitor_task3_custom.yaml > /tmp/wewe_monitor_task3_custom.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_monitor_task3_custom.log
grep COMPILE_EXIT /tmp/wewe_monitor_task3_custom.log
grep -n "WEWE_MAX_LISTENERS" .esphome/build/*/defines.h
rm /tmp/wewe_monitor_task3_custom.yaml
```

Expected: `COMPILE_EXIT=0`, and the `defines.h` grep now shows
`#define WEWE_MAX_LISTENERS 1`.

- [ ] **Step 5: Verify an out-of-range value is rejected — Review Focus test 2 of 2**

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
cp spike.yaml /tmp/wewe_monitor_task3_invalid.yaml
sed -i '/^wewe_monitor:/a\  max_listeners: 0' /tmp/wewe_monitor_task3_invalid.yaml
esphome config /tmp/wewe_monitor_task3_invalid.yaml > /tmp/wewe_monitor_task3_invalid.log 2>&1
echo "CONFIG_EXIT=$?" >> /tmp/wewe_monitor_task3_invalid.log
grep CONFIG_EXIT /tmp/wewe_monitor_task3_invalid.log
rm /tmp/wewe_monitor_task3_invalid.yaml
```

Expected: `CONFIG_EXIT` non-zero, with an error message naming
`max_listeners` and the valid range — confirms `cv.int_range(min=1, max=8)`
is actually enforced, not just declared.

- [ ] **Step 6: Restore the real spike.yaml build artifacts and reflash for a sanity check**

Since Step 4/5 compiled scratch copies against the same `.esphome/build`
cache directory, recompile and reflash the real `spike.yaml` once more to
leave the device running the actual reference config, not a scratch one:

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
esphome compile spike.yaml > /tmp/wewe_monitor_task3_final.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_monitor_task3_final.log
grep COMPILE_EXIT /tmp/wewe_monitor_task3_final.log
esphome upload --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_monitor_task3_final_upload.log 2>&1
echo "UPLOAD_EXIT=$?" >> /tmp/wewe_monitor_task3_final_upload.log
grep UPLOAD_EXIT /tmp/wewe_monitor_task3_final_upload.log
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/grant/sync/Code/wewe
git add firmware/
git commit -m "$(cat <<'EOF'
feat(wewe_monitor): make max_listeners optional YAML config (default 3)

Compile-time (it sizes a fixed array), via ESPHome's add_define — a board
tight on RAM/DTLS-handshake stack headroom can now ask for fewer than 3.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Make `ice_servers` configurable (optional list)

**Files:**
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_monitor.h`
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_monitor.cpp`
- Modify: `firmware/wewe_monitor/wewe_monitor/__init__.py`

**Interfaces:**
- Consumes: the `RuntimeState g_state` struct and `create_peer_for()`
  function already present from Task 1's move (unchanged in shape so far).
- Produces: `WeweMonitor::add_ice_server(const std::string &url)` — a new
  public method, called once per YAML list entry by generated code. Nothing
  later in this plan consumes it further.

- [ ] **Step 1: Add `add_ice_server` to the header**

In `wewe_monitor.h`, add alongside `set_clk_pin`/`set_din_pin`:

```cpp
  void add_ice_server(const std::string &url);
```

(Declared here, implemented in the `.cpp` — matching how `on_pair_tapped()`
and the other methods that reach into the file-private `g_state` are
already split between declaration and implementation.)

- [ ] **Step 2: Add `<vector>` include and new `RuntimeState` fields in `wewe_monitor.cpp`**

Add to the top-of-file includes (alongside the existing `<cmath>`/`<cstring>`):

```cpp
#include <vector>
```

Find the `RuntimeState` struct definition and add two new fields (exact
placement doesn't matter, but keep them together for readability):

```cpp
  // Populated once, before setup() runs, by add_ice_server() calls
  // generated from YAML's optional ice_servers list — see that method's
  // own comment for why this is copied into a stable, RuntimeState-owned
  // vector<char*>-compatible form rather than read fresh on every
  // create_peer_for() call.
  std::vector<std::string> ice_server_urls;
  std::vector<esp_peer_ice_server_cfg_t> ice_server_cfgs;
```

- [ ] **Step 3: Implement `add_ice_server`**

Add near the other `WeweMonitor::` method implementations (e.g. right after
`on_screen_touched`'s implementation):

```cpp
void WeweMonitor::add_ice_server(const std::string &url) { g_state.ice_server_urls.push_back(url); }
```

- [ ] **Step 4: Build `ice_server_cfgs` once, in `setup()`, after `ice_server_urls` is known to be complete**

Generated `cg.add(var->add_ice_server(url))` calls run once per YAML list
entry, immediately after construction and before `App.setup_all()` calls
any component's `setup()` — so by the time `WeweMonitor::setup()` runs,
`g_state.ice_server_urls` is fully populated and will never change again.
Building `g_state.ice_server_cfgs` here, once, keeps the same "lives for
the rest of the program" lifetime the current hardcoded `static` array has
— `esp_peer_ice_server_cfg_t` holds raw `char*` pointers that must stay
valid for as long as any `esp_peer_open()` call might reference them.

Find the start of `WeweMonitor::setup()` — the exact first lines will be
whatever Task 1's rename left in place (e.g. `wewe_invite_mode_init(...)`,
`noise_gate_init(...)` or similar). Add, before anything else in the
function body:

```cpp
void WeweMonitor::setup() {
  for (const auto &url : g_state.ice_server_urls) {
    g_state.ice_server_cfgs.push_back(
        esp_peer_ice_server_cfg_t{.stun_url = (char *)url.c_str(), .user = nullptr, .psw = nullptr});
  }
  // ... rest of the existing setup() body, unchanged, follows here ...
```

Do not reformat or move any of the existing body — this is a pure
insertion at the top of the function.

- [ ] **Step 5: Replace the hardcoded ICE server array in `create_peer_for()`**

Find:

```cpp
  // STUN-only, matching src/webrtc/rtcConfig.ts's DEFAULT_ICE_SERVERS.
  static esp_peer_ice_server_cfg_t ice_servers[] = {
      {.stun_url = (char *)"stun:stun.l.google.com:19302", .user = nullptr, .psw = nullptr},
      {.stun_url = (char *)"stun:stun1.l.google.com:19302", .user = nullptr, .psw = nullptr},
  };

  esp_peer_cfg_t cfg = {};
  cfg.server_lists = ice_servers;
  cfg.server_num = 2;
```

Replace with:

```cpp
  esp_peer_cfg_t cfg = {};
  cfg.server_lists = g_state.ice_server_cfgs.data();
  cfg.server_num = (int)g_state.ice_server_cfgs.size();
```

- [ ] **Step 6: Add the optional `ice_servers` config to `__init__.py`, defaulting to today's two Google STUN URLs**

Add the constant:

```python
CONF_ICE_SERVERS = "ice_servers"
DEFAULT_ICE_SERVERS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]
```

Update `CONFIG_SCHEMA`:

```python
CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(WeweMonitor),
        cv.Required(CONF_SIGNAL_URL): cv.string_strict,
        cv.Required(CONF_CLK_PIN): pins.internal_gpio_output_pin_number,
        cv.Required(CONF_DIN_PIN): pins.internal_gpio_input_pin_number,
        cv.Optional(CONF_MAX_LISTENERS, default=3): cv.int_range(min=1, max=8),
        cv.Optional(CONF_ICE_SERVERS, default=DEFAULT_ICE_SERVERS): cv.All(
            cv.ensure_list(cv.string_strict), cv.Length(min=1)
        ),
    }
).extend(cv.COMPONENT_SCHEMA)
```

Update `to_code()` — add after the `set_din_pin` call:

```python
    for url in config[CONF_ICE_SERVERS]:
        cg.add(var.add_ice_server(url))
```

- [ ] **Step 7: Verify the default path still compiles and produces a working connection**

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
esphome compile spike.yaml > /tmp/wewe_monitor_task4_compile.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_monitor_task4_compile.log
grep COMPILE_EXIT /tmp/wewe_monitor_task4_compile.log
esphome upload --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_monitor_task4_upload.log 2>&1
echo "UPLOAD_EXIT=$?" >> /tmp/wewe_monitor_task4_upload.log
grep UPLOAD_EXIT /tmp/wewe_monitor_task4_upload.log
```

Expected: both exit 0. Then capture a boot log and, if a phone with the
Wewe dev client is available in this environment, do one real pairing
attempt and confirm the log shows `PEER_DEF: DTLS handshake success` —
this task is the one most likely to silently break real connectivity
(wrong STUN servers means ICE never finds a working candidate pair), so a
real end-to-end connection check matters more here than a boot-log-only
check. If no phone is available in this execution context, at minimum
confirm the boot log shows no crash and `Joined signaling room` appears,
and flag in the task's completion notes that the full pairing test still
needs a human with the paired phone.

- [ ] **Step 8: Verify an empty list is rejected — Review Focus test**

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
cp spike.yaml /tmp/wewe_monitor_task4_invalid.yaml
sed -i '/^wewe_monitor:/a\  ice_servers: []' /tmp/wewe_monitor_task4_invalid.yaml
esphome config /tmp/wewe_monitor_task4_invalid.yaml > /tmp/wewe_monitor_task4_invalid.log 2>&1
echo "CONFIG_EXIT=$?" >> /tmp/wewe_monitor_task4_invalid.log
grep CONFIG_EXIT /tmp/wewe_monitor_task4_invalid.log
rm /tmp/wewe_monitor_task4_invalid.yaml
```

Expected: `CONFIG_EXIT` non-zero, error naming `ice_servers`.

- [ ] **Step 9: Commit**

```bash
cd /home/grant/sync/Code/wewe
git add firmware/
git commit -m "$(cat <<'EOF'
feat(wewe_monitor): make ice_servers optional YAML config

Defaults to today's hardcoded Google STUN pair. Lets a self-hosted
signal_url pair with a self-hosted STUN server too.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Write the library README

**Files:**
- Create: `firmware/wewe_monitor/README.md`

**Interfaces:**
- Consumes: the final config surface from Tasks 2-4 (`signal_url`,
  `clk_pin`, `din_pin`, `max_listeners`, `ice_servers`) and the task stack
  sizes already present from before this plan started (`wewe_pc_pump`
  16 KB, `wewe_audio_send` 8 KB — unchanged by this plan, just documented).
- Produces: nothing consumed elsewhere in this plan — this is the
  plan's documentation deliverable.

- [ ] **Step 1: Write the README**

```markdown
# wewe_monitor

An ESPHome external component: WiFi signaling, pairing, WebRTC audio, mic
capture, and adaptive noise-gating for building a hardware Monitor
compatible with the [Wewe](https://github.com/grantstephens/wewe) baby
monitor app. Audio-only — no display or UI is included or required; see
`firmware/core2-spike/` in this repo for a worked example that adds one.

## Minimal example

The smallest thing that produces a working, headless Monitor — a bare
board with WiFi and a PDM microphone, no screen:

```yaml
esphome:
  name: my-monitor

esp32:
  board: esp32dev
  framework:
    type: esp-idf

external_components:
  - source:
      type: git
      url: https://github.com/grantstephens/wewe
      path: firmware/wewe_monitor

wewe_monitor:
  id: monitor
  signal_url: "wss://your-relay.example.com"
  clk_pin: GPIO0
  din_pin: GPIO34

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

network:
  enable_ipv6: true  # required — esp_peer's transport needs IPv6 support
                      # compiled into lwIP even on an IPv4-only network

logger:
```

Pairing works exactly like the app: the first time this boots, it's
"unpaired." Whatever mechanism you build to trigger pairing mode (the Core2
reference example uses a touchscreen tap; a board with no display could use
a physical button, or a fixed boot-time window) should call the component's
`on_pair_tapped()` method, which shows a 6-digit rotating code — the app's
"Add Monitor" flow enters that code to link the two.

## Config reference

| Key | Required | Default | Notes |
|---|---|---|---|
| `signal_url` | yes | — | The `signal-server` relay WebSocket URL (`wss://...`). |
| `clk_pin` | yes | — | PDM clock pin (ESP32 output) to your mic. |
| `din_pin` | yes | — | PDM data pin (ESP32 input) from your mic. |
| `max_listeners` | no | `3` | Max concurrent Parent connections. Compile-time — sizes a fixed array. |
| `ice_servers` | no | Google's public STUN pair | STUN server URLs for ICE. Point this at your own if you're self-hosting `signal_server` too. |

## What you bring yourself

- **WiFi credentials** — standard ESPHome `wifi:` config, nothing
  Wewe-specific about it.
- **Board power sequencing, if your hardware needs it.** Some boards gate
  their mic/GPIO rails behind a power-management IC that needs an explicit
  init sequence before anything else can use those pins — the M5Stack
  Core2 is one such board (its AXP192 PMIC must be initialized before its
  I2S/GPIO lines are even electrically live). See
  `firmware/core2-spike/components/wewe_axp192/` in this repo for a worked
  example, including why it registers at ESPHome's `HARDWARE` setup
  priority specifically (it has to run before this component's own
  `setup()`, which starts mic capture). A board without this kind of gating
  needs nothing here at all.

## Task stack sizes — do not reduce without re-verifying on real hardware

Two FreeRTOS tasks inside this component are sized larger than their
workload might look like it needs, and both sizes come from a real crash
found and fixed on real hardware, not a guess:

- **`wewe_pc_pump` (16 KB).** A 6 KB stack measurably overflowed —
  caught by FreeRTOS's own stack-overflow detector, not a guess — when
  STUN packet processing and an active DTLS handshake happen to nest in
  the same call frame (STUN's own HMAC-SHA1 validation calls into mbedTLS
  while a DTLS handshake is also live). This only happens once a real
  peer actually completes a connection attempt through to DTLS — a
  smoke test that never gets that far won't catch a regression here.
- **`wewe_audio_send` (8 KB).** Bumped alongside the above as a
  precaution: it flows through the same SRTP/mbedTLS-backed encrypt path
  for every outgoing audio frame, sharing the same risk profile even
  though it wasn't the task observed overflowing.

If you need to reduce either for RAM reasons, do it incrementally and test
against a real, completed connection (not just a successful compile) each
time — the failure mode is a heap-corruption assert or a silent crash deep
into a real call, not a compile error.
```

- [ ] **Step 2: Cross-check the README against the real schema — Review Focus test**

```bash
cd /home/grant/sync/Code/wewe
grep -n "cv.Required\|cv.Optional" firmware/wewe_monitor/wewe_monitor/__init__.py
```

Compare the output against the README's config table by hand: every
`cv.Required(...)` key must appear in the table marked "yes", every
`cv.Optional(..., default=...)` key must appear marked "no" with the
matching default value. Fix either side if they've drifted.

- [ ] **Step 3: Commit**

```bash
cd /home/grant/sync/Code/wewe
git add firmware/wewe_monitor/README.md
git commit -m "$(cat <<'EOF'
docs(wewe_monitor): add library README

Minimal example, full config reference, what the integrator brings
themselves, and why the two task stack sizes aren't arbitrary.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final validation — full reflash and real pairing test

**Files:** none (validation only, no new deliverable — this is the
acceptance test for the whole plan).

**Interfaces:**
- Consumes: the complete `wewe_monitor` library and the updated
  `firmware/core2-spike/spike.yaml` from Tasks 1-5.
- Produces: nothing — this task's only output is a pass/fail confirmation.

- [ ] **Step 1: Clean compile from scratch**

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
rm -rf .esphome/build
esphome compile spike.yaml > /tmp/wewe_monitor_task6_compile.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_monitor_task6_compile.log
grep COMPILE_EXIT /tmp/wewe_monitor_task6_compile.log
```

Expected: `COMPILE_EXIT=0`. A clean-build (not incremental) compile is the
real test here — it catches any stale-cache artifact from the earlier
tasks' incremental builds that might have been masking a real problem.

- [ ] **Step 2: Flash**

```bash
esphome upload --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_monitor_task6_upload.log 2>&1
echo "UPLOAD_EXIT=$?" >> /tmp/wewe_monitor_task6_upload.log
grep UPLOAD_EXIT /tmp/wewe_monitor_task6_upload.log
```

Expected: `UPLOAD_EXIT=0`.

- [ ] **Step 3: Confirm a clean boot**

```bash
timeout 15 esphome logs --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_monitor_task6_boot.log 2>&1
grep -iE "error|crash|abort|assert|guru|panic|backtrace|stack overflow" /tmp/wewe_monitor_task6_boot.log
```

Expected: no matches (the same benign-`role-taken` caveat from Task 1
applies).

- [ ] **Step 4: Real pairing test — requires a human with the paired phone**

This step needs an actual phone running the Wewe app's dev client — a
subagent without phone/adb access cannot complete it. If executing this
plan without that access, stop here and report Steps 1-3's results; ask
a human to:

1. Tap the device to arm pairing mode.
2. Enter the shown code in the app.
3. Confirm audio is audible in the app.
4. Confirm the log shows `PEER_DEF: DTLS handshake success` and
   `esp_peer state for ...: 7` (connected).

This is the plan's actual acceptance criterion from the spec's own
"Validation" section — everything before it is necessary but not
sufficient on its own.

- [ ] **Step 5: Final commit (if Step 4 required any fix)**

Only needed if Step 4 surfaced a real regression requiring a code change —
if Steps 1-4 all pass cleanly with no changes needed, there's nothing to
commit here; the plan is complete as of Task 5's commit.
