# `wewe_monitor`: packaging the ESP32 firmware as a reusable ESPHome library

**Date:** 2026-09-30
**Status:** Design approved in chat 2026-09-30; not yet broken into implementation-plan tasks.

## Problem

`firmware/core2-spike/components/wewe_webrtc_spike/` is a real, working ESPHome
external component — properly shaped with a `CONFIG_SCHEMA`/`to_code` (see its
`__init__.py`), already exercised end-to-end against the production relay and a real
phone across an extensive live-hardware debugging session (2026-09-28 through
2026-09-30) that found and fixed five distinct real bugs (a stack overflow in the
WebRTC pump task, a cross-task double-free race in peer teardown, a relay-side room-TTL
gap, and two app-side reconnect bugs). It works.

But its name, location, and a few hardcoded assumptions all say "throwaway spike," not
"thing someone else can import": the directory is `core2-spike`, the component is
`wewe_webrtc_spike`, and the mic's I2S GPIO pins are hardcoded in C
(`wewe_mic.c`'s `GPIO_NUM_0`/`GPIO_NUM_34`) rather than exposed as YAML config. Anyone
wanting to build a Wewe-compatible hardware Monitor on different hardware today would
need to fork this file tree and edit C++ to change which pins their mic is wired to.

This spec covers separating the **hardware-agnostic core** (signaling, pairing,
WebRTC peer/media handling, mic capture, the noise gate) from the **Core2-specific
glue** (AXP192 power sequencing, the LCD status UI, touch regions) that a different
board wouldn't need, and packaging the former as a real, documented, git-importable
ESPHome component.

## Scope decisions (settled in chat)

- **Library covers signaling/pairing/WebRTC/mic/gate only** — not the display/touch
  UI. A board with no screen (just a mic and WiFi) needs the library and nothing else.
  The Core2's AXP192 driver and display/touch UI stay in `firmware/core2-spike/` as a
  worked *reference example* that uses the library, not part of it.
- **Distribution: stays in this monorepo**, referenced via ESPHome's git-sourced
  `external_components` (`source: {type: git, url: <this repo>, path:
  firmware/wewe_monitor}`). No separate repo to version and coordinate releases
  against — it ships and gets fixed alongside the app and `signal-server` it talks to,
  the same way `wewe_axp192` already lives as a subdirectory component rather than its
  own package.
- **Component name: `wewe_monitor`** — matches the app's own terminology (a paired
  device is called a "Monitor" throughout the app, `AGENTS.md`, `PLAN.md`); someone
  reading the app's docs and this component's docs sees the same word.
- Renaming `firmware/core2-spike/` itself (it's a reference example now, not a spike)
  is **optional, low priority** — skip if it's not worth the churn.

## Directory structure

```
firmware/
  wewe_monitor/                    # the library — new
    README.md                      # usage docs, see "Documentation" below
    wewe_monitor/
      __init__.py                  # renamed from wewe_webrtc_spike's; component key `wewe_monitor`, class `WeweMonitor`
      wewe_monitor.h
      wewe_monitor.cpp              # renamed from wewe_webrtc_spike.h/.cpp; same content, same namespace-rename
      wewe_signaling.h / .c
      wewe_storage.h / .c
      wewe_invite_mode.h / .c
      wewe_mic.h / .c                # pins now come from config, see below
      wewe_g711.h / .c
      noise_gate.h / .c
      test/
        wewe_invite_mode_test.c      # unchanged, still host-compilable
        noise_gate_test.c            # unchanged, still host-compilable
  core2-spike/                       # the reference example — existing directory, now imports the library
    spike.yaml                       # external_components: now points at ../wewe_monitor (dev) / git+path (documented usage)
    components/
      wewe_axp192/                   # unchanged — Core2-specific, stays here
```

Every file under `wewe_monitor/wewe_monitor/` is a straight rename/move from
`core2-spike/components/wewe_webrtc_spike/` with the C++ namespace changed from
`wewe_webrtc_spike` to `wewe_monitor` and the Python component's `CODEOWNERS`/class
name updated to match. No logic changes during the move itself — the move and the
config-surface changes below are separate, reviewable steps.

## Config surface

**New required config** (the one real genericity blocker):

```yaml
wewe_monitor:
  id: monitor
  signal_url: "wss://your-relay.example.com"
  clk_pin: GPIO0    # new — mic I2S PDM clock pin
  din_pin: GPIO34   # new — mic I2S PDM data pin
```

`wewe_mic_init()` currently takes only a sample rate; it gains `clk_gpio`/`din_gpio`
parameters, and the component's `to_code()` passes through whatever `clk_pin`/`din_pin`
YAML resolves to (`cv.All(pins.gpio_number)`, matching how ESPHome components
universally validate GPIO config).

**New optional config**, both with defaults matching current hardcoded behavior — pure
flexibility, not required to get a board running:

```yaml
wewe_monitor:
  max_listeners: 3                 # optional, default 3 — compile-time MAX_LISTENERS becomes a to_code()-supplied constant
  ice_servers:                     # optional, defaults to today's hardcoded Google STUN pair
    - stun:stun.l.google.com:19302
    - stun:stun1.l.google.com:19302
```

**Explicitly not exposed:** sample rate. It's fixed at 8000 Hz because the G711A codec
is fixed at 8000 Hz — that's a codec constraint, not a hardware one, and exposing it
would just let someone configure a combination that silently doesn't work.

## Documentation

`firmware/wewe_monitor/README.md` covers:

1. A minimal working example YAML (signaling + a bare mic, no display) — the actual
   smallest thing that produces a working Monitor.
2. The full config reference: required vs. optional keys, defaults.
3. What the library does *not* provide and the integrator must bring themselves: WiFi
   credentials (standard ESPHome `wifi:`), and — called out explicitly — any
   board-specific power-sequencing your hardware needs before its mic/GPIO lines are
   usable (the Core2 needs AXP192 init before its rails come up at all; a simpler board
   might need nothing). Point to `core2-spike/components/wewe_axp192/` as a worked
   example of what that looks like and why it has to run at
   `setup_priority::HARDWARE`.
4. **A clearly flagged section on the two FreeRTOS task stack sizes** —
   `wewe_pc_pump` (16 KB) and `wewe_audio_send` (8 KB) — stating plainly that these
   aren't arbitrary: 6 KB was measured to overflow via FreeRTOS's own stack-overflow
   detector when STUN processing and an active DTLS handshake nest in the same call
   frame, a real crash found on real hardware during this project's own bring-up. The
   README says not to reduce these without re-verifying against a real device.

## Validation

After the move: recompile and reflash the Core2 reference example
(`firmware/core2-spike/spike.yaml`), now pointed at the renamed, relocated library,
and confirm it still boots clean and can complete a real pairing + connection cycle —
the same compile → flash → log-watch loop used throughout this project's hardware
work. This is the acceptance test for the whole restructuring: if the reference
example still works unchanged in behavior, the rename/move introduced no regressions.

## Non-goals

- Publishing to ESPHome's own component registry (`esphome/external_components`
  first-party listing) — out of scope; git+path is sufficient for "importable," and
  registry submission is a separate, later decision if this ever gets outside use.
- Multi-board CI (compiling the library against a second, different board target to
  prove genericity beyond the Core2) — out of scope for this pass; the config surface
  change (configurable mic pins) is what makes it *possible* for someone else to try,
  not something this project commits to testing against hardware it doesn't own.
- Any change to the wire protocol, pairing model, or noise-gate algorithm — this is a
  packaging change only, not a functional one.
