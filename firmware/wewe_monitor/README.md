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
