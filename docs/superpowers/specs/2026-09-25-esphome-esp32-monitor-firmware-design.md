# ESP32-S3 hardware Monitor firmware, built on ESPHome

**Date:** 2026-09-25
**Status:** Draft — blocked on the feasibility spike in [Spike gate](#spike-gate-run-this-before-anything-else); not yet approved for implementation.

## Problem

`PLAN.md`'s Phase 4 currently scopes the ESP32-S3 hardware Monitor as a **standalone
ESP-IDF application** — hand-rolled Wi-Fi provisioning (SoftAP + captive portal via
`wifi_provisioning`/`protocomm`), hand-rolled OTA (`esp_https_ota` against GitHub
Releases), hand-rolled status/debug surface — on top of Espressif's
`esp-webrtc-solution` for the actual WebRTC media path. That's a correct, low-risk
architecture, but it means writing and maintaining a meaningful amount of C
infrastructure code that has nothing to do with this project's actual differentiator
(the noise gate and the WebRTC audio path) and everything to do with problems ESPHome
already solved for thousands of other projects: Wi-Fi captive portal, OTA, a
config/dashboard surface, structured logging.

`PLAN.md` also contains a "Correction versus the ESPHome device framing" section
explaining, correctly, that **no ESPHome YAML component does on-device WebRTC** — the
closest community pattern (`esphome-intercom`-style projects) bridges raw UDP PCM into
`go2rtc` running on Home Assistant, an architecture this project deliberately doesn't
want (see "Approach C" below, still rejected).

This spec asks a narrower, previously unexamined question: **can ESPHome's own
`esp32: framework: type: esp-idf` build mode — which is a real ESP-IDF build, not a
sandboxed one — host a custom external component that links Espressif's actual
`esp_peer`/`esp_webrtc` WebRTC stack, so the firmware gets ESPHome's Wi-Fi/OTA/
dashboard conveniences *and* real on-device WebRTC in the same binary?** If yes, it
replaces Phase 4's hand-rolled infrastructure with ESPHome's, and the only firmware
code this project still writes by hand is the part that's actually specific to Wewe:
the mic capture wiring, the RMS/VAD gate port, and a signaling client for
`signal-server`'s own wire protocol.

## Confirmed research (as of 2026-09-25, pre-spike)

Read directly from `espressif/esp-webrtc-solution`'s `main` branch and ESPHome's
current release docs before writing this spec, not assumed:

- `esp-webrtc-solution` is **not** a monolithic blob. It's a set of proper ESP-IDF
  Component-Manager packages — `esp_peer`, `esp_webrtc`, `av_render`,
  `media_lib_utils`, `webrtc_utils`, `codec_board` — each with its own
  `idf_component.yml`, installable via the same `components.espressif.com` registry
  mechanism any ESP-IDF project (ESPHome's `esp-idf` framework mode included) already
  uses for third-party components.
- The `peer_demo` solution's manifest declares `idf: version: ">=5.0"`; its README
  states it builds against "either the IDF master branch or the IDF release v5.4."
  Both are permissive lower bounds, not a pin to one exact minor version.
- ESPHome made `esp-idf` the **default** ESP32 framework starting with release
  2026.1.0 (previously default was Arduino), and as of ESPHome 2026.5.0 is building
  against ESP-IDF 6.0.1. 6.0.1 satisfies `esp-webrtc-solution`'s stated `>=5.0`
  floor, so there is no *known* version conflict — but "the floor is satisfied on
  paper" is not the same claim as "it links," which is exactly what the spike below
  tests.
- `signal-server`'s wire protocol (`signal-server/README.md`) is deliberately trivial:
  one WebSocket, JSON messages with a `type` field (`join`/`signal`/`joined`/
  `peer-joined`/`peer-left`/`error`), no binary framing, no auth beyond the pairing
  code as room name. This is a much smaller integration surface than
  `esp-webrtc-solution`'s bundled `apprtc_signal` implementation, and confirms a
  custom ESP-IDF-side signaling client (plain WebSocket + a small JSON library,
  e.g. `cJSON` which ESP-IDF already vendors) is a low-risk, self-contained piece —
  not a reason to prefer `esp-webrtc-solution`'s own bundled signaling.

## Goals

- Every convenience ESPHome already provides for free stays free: Wi-Fi provisioning
  and captive portal, OTA, structured logging, and a status/config web dashboard.
- The only hand-written C/C++ is Wewe-specific: I2S mic capture wiring, the RMS/VAD
  gate (ported line-for-line from `src/domain/noiseGate.ts`, preserving its frozen-EMA
  and stationarity-window invariants per `AGENTS.md`), and a `signal-server` WebSocket
  signaling client.
- The firmware is a real WebRTC peer functionally equivalent to the phone Monitor
  role — same signaling protocol, same DTLS-SRTP media, same pairing-code join flow —
  so the Parent app's playback path genuinely stays identical regardless of which
  Monitor type it's talking to, matching `PLAN.md`'s "Confirmed scope decision #2."
- Feasibility is proven **before** any of the above is built for real. See
  [Spike gate](#spike-gate-run-this-before-anything-else).

## Non-goals

- Video, TURN, or talk-back playback on the hardware unit — unchanged from
  `PLAN.md`'s existing Phase 6 stretch scope; this spec only replaces *how* Phase 4's
  firmware is built, not what it does.
- Any dependency on Home Assistant. ESPHome's native API/entity model is used only
  as a bonus status surface (see "ESPHome entities" below); Home Assistant is never
  required to pair, provision, or operate a hardware Monitor.
- Deciding the exact mic part number as a hard requirement — see "Hardware" below,
  which gives a recommendation plus fallbacks, not a single locked BOM line, since
  that's explicitly still an "open item" in `PLAN.md`.

## Spike gate — run this before anything else

Before any of the design below is implemented, prove the core technical bet: that an
ESPHome `esp-idf`-framework build can successfully declare and link an
`esp-webrtc-solution` component. This is a compile-only spike (no hardware required —
it's a cross-compile), scoped and pre-approved conversationally on 2026-09-25:

1. Scratch ESPHome YAML: `esp32-s3-devkitc-1` board, `framework: type: esp-idf`.
2. A minimal `external_components` stub (an empty C++ class satisfying ESPHome's
   component interface) with its own `idf_component.yml` depending on
   `espressif/esp_peer` — mirroring `peer_demo`'s manifest exactly.
3. `esphome compile` against that YAML. Success criterion: the Component Manager
   resolves the dependency and the final link step completes with `esp_peer` symbols
   present in the output map file — not that the firmware does anything functional
   yet.

**Go/no-go:** if this fails for a structural reason (ESPHome's generated
`CMakeLists.txt` doesn't expose a hook the component manager needs, a genuine
IDF-version incompatibility despite the stated floor, etc.), fall back to `PLAN.md`'s
existing plain-ESP-IDF Phase 4 plan rather than sinking further time into forcing the
combination — do not let sunk cost turn a failed spike into a struggle. If it
succeeds, this spec supersedes `PLAN.md`'s current Phase 4 paragraph and the
"Correction versus the ESPHome device framing" section gets a follow-up note (not a
retraction — the correction about *stock* ESPHome YAML doing WebRTC remains true;
this is a custom component, not a YAML platform).

## Design

### Layering

```
┌─────────────────────────────────────────────────────────────┐
│ ESPHome-native (YAML-configured, zero custom code)           │
│  wifi:, captive_portal:, ota:, api:, web_server:, logger:     │
├─────────────────────────────────────────────────────────────┤
│ Custom external_component: "wewe_webrtc"                     │
│  - owns esp_webrtc/esp_peer lifecycle (setup/loop hooks)      │
│  - owns I2S mic capture → RMS/VAD gate → Opus encode          │
│  - owns signal-server WebSocket signaling client              │
│  - exposes ESPHome entities: connection state, RMS level,     │
│    mute switch, pairing-code text field                       │
├─────────────────────────────────────────────────────────────┤
│ espressif/esp_peer, esp_webrtc, av_render, media_lib_utils,   │
│ webrtc_utils  (pulled via idf_component.yml, unmodified)      │
└─────────────────────────────────────────────────────────────┘
```

The custom component is the only place Wewe-specific code lives. Everything above it
is stock ESPHome YAML; everything below it is stock, unforked upstream Espressif
components.

### Wi-Fi provisioning and pairing-code entry

ESPHome's built-in `captive_portal:` component already provides the SoftAP +
browser-based config-page flow that `PLAN.md`'s plain-ESP-IDF plan intended to
hand-build with `protocomm`. The one addition needed: a custom form field for the
pairing code, alongside the Wi-Fi SSID/password fields ESPHome already renders. First-
boot flow becomes: unit powers on with no saved Wi-Fi → SoftAP comes up → phone
connects to it → captive portal page opens automatically → user enters home Wi-Fi
credentials *and* the pairing code shown in the app's AddMonitor screen, in one form →
unit reboots, joins Wi-Fi, and immediately opens the signal-server WebSocket with that
room code. No QR scanning on the hardware side is needed (the unit has no camera by
default) — the app's existing "enter code manually" path, already built for phone
pairing, is what a user types into the captive portal.

### ESPHome entities (bonus, not required)

The custom component registers a handful of ESPHome entities — a `binary_sensor` for
WebRTC connection state, a `sensor` for current RMS level (handy for debugging mic
placement without a phone in hand), and a `switch` for mute. These ride on ESPHome's
existing `api:`/`web_server:` components for free. A user who happens to run Home
Assistant gets these automatically; a user who doesn't never needs to know they exist
— nothing in the pairing/streaming path depends on ESPHome's API being reachable by
anything other than the unit's own local web dashboard.

### OTA

ESPHome's native `update:`/`ota:` components replace `PLAN.md`'s hand-rolled
`esp_https_ota` call. Point ESPHome's update check at a manifest JSON hosted alongside
GitHub Releases (ESPHome supports an HTTP(S) update source out of the box) rather than
writing a custom updater — this is free convenience win #2 from adopting ESPHome, on
top of the captive portal.

### Signaling client

A small, self-contained piece: a WebSocket client (ESP-IDF's own `esp_websocket_client`
component, already a transitive dependency of most ESP-IDF examples) plus `cJSON` to
speak `signal-server`'s protocol exactly as documented — `join` with `role: "monitor"`,
relay `signal` payloads (the SDP/ICE blobs `esp_peer` produces) verbatim in both
directions. This does **not** reuse `esp-webrtc-solution`'s bundled `apprtc_signal`
implementation, which speaks a different (Google AppRTC) protocol; `esp_webrtc`'s
signaling interface is documented as pluggable specifically so a custom transport can
be substituted, which is what this is.

### Mic capture and the noise gate

I2S mic → ring buffer → the ported RMS/VAD gate → only when open, samples flow into
`esp_webrtc`'s audio source callback for Opus encode + send. This is unchanged from
`PLAN.md`'s original Phase 4 description and `AGENTS.md`'s invariant that the gate
"runs on the Monitor" — still true here, the gate is still firmware-side, still the
same ported algorithm, still preserving the frozen-EMA-while-open and
reset-on-any-variation-stationarity-window properties. Nothing about the ESPHome shell
changes this piece; it's the same C port either way.

## Hardware

### Board

Needs ESP32-**S3** with **PSRAM** — DTLS-SRTP + Opus encode is RAM/compute-heavy
enough that Espressif's own WebRTC demos target S3, not classic ESP32/C3. Three
candidates, in recommended order:

1. **ESP32-S3-DevKitC-1 (N8R8 or N16R8)** — recommended default. Official Espressif
   board, guaranteed PSRAM, full GPIO breakout for wiring an external I2S mic breakout
   board, cheapest to source, best-documented for exactly this kind of "component +
   custom peripheral" project. N8R8 (8MB flash/8MB PSRAM) is enough; no reason to pay
   for N16R8 unless OTA image size or future features demand it.
2. **ESP32-S3-Korvo-2** — Espressif's own audio/voice-AI dev board: has a built-in
   dual-mic array (ES7210 ADC) and speaker/amp already wired, no breadboarding
   required. Worth it if the goal is a bring-up shortcut for a prototype, but the
   dual-mic array + `esp-sr` beamforming/AEC stack is overkill for a stationary
   single-mic baby monitor and adds cost and firmware complexity (a second codec
   driver) for a feature this project doesn't need. Good for early bring-up/debugging
   even if the final BOM moves to option 1.
3. **Seeed XIAO ESP32S3 Sense** — smallest form factor, has 8MB PSRAM, and its Sense
   expansion board includes an onboard PDM digital mic (plus a camera this project
   doesn't use). Attractive for a genuinely tiny final enclosure, but PDM capture is a
   less common ESP-IDF code path than I2S-standard MEMS mics (fewer worked examples to
   crib from) — treat as a Phase 5 "miniaturize" option, not the Phase 4 bring-up
   board.

### Microphone (for option 1, the DevKitC-1 path)

An external I2S digital MEMS mic breakout, wired to three GPIOs (BCLK/WS/DATA) plus
power. In rough order of recommendation:

- **ICS-43434** (e.g. TDK InvenSense, sold on breakouts by Adafruit/others) — best
  self-noise/SNR (~65 dB(A) SNR, -26 dBFS sensitivity) of the commonly-available I2S
  MEMS mics, meaningfully better than the more famous INMP441 for a use case where the
  mic sits meters from a quiet, sleeping baby and has to reject its own self-noise as
  much as the room's. Recommended default.
- **INMP441** — the most commonly used I2S MEMS mic in ESP32 projects (huge amount of
  prior art, every ESP-IDF I2S example targets it first), ~61 dB(A) SNR. Fine fallback
  if ICS-43434 stock/lead-time is a problem, or for the very first bring-up test where
  "definitely works, tons of reference code" matters more than a few dB of SNR.
- **SPH0645LM4H** (Adafruit breakout) — avoid for this project specifically. Widely
  documented DC-offset/bit-alignment quirk in its I2S output that historically needed
  a firmware workaround; no advantage over the two above that offsets debugging that
  quirk on top of an already-unproven ESPHome/WebRTC combo.

Mounting note, independent of part choice: MEMS mics need an open acoustic port —
don't fully enclose the capsule behind solid plastic in the final enclosure design: a
small drilled port (standard MEMS mic guidance) is required or effective sensitivity
drops sharply regardless of which part was chosen.

### Power

Mains-powered via USB-C, always plugged in — a nursery monitor is stationary by
definition, so there's no battery/power-management design needed, unlike a wearable
product. A standard 5V/1A USB-C wall supply is sufficient headroom for S3 + Wi-Fi TX +
mic.

## Risks / open items

- **The spike above is unproven** — this entire spec is contingent on it. Treat
  everything below "Spike gate" as provisional until that gate passes.
- ESPHome's ESP-IDF version pin moves with every ESPHome release; a working build
  today isn't guaranteed to keep working after an unrelated ESPHome upgrade. Pin the
  ESPHome version explicitly in this project's toolchain (mirroring how `mise.toml`
  already pins everything else) rather than tracking ESPHome `latest`.
- `esp_capture` (referenced in `esp-webrtc-solution`'s own docs as the I2S capture
  glue used by its solutions) wasn't confirmed as one of the six components listed
  directly under `components/` in this research pass — it may be a separately
  published registry package. Confirm its actual location/license during the spike's
  follow-up (task 4c below), not assumed here.
- Component-Manager dependency resolution happens at build time over the network by
  default; CI and offline development need either a vendored/pinned component cache
  or an accepted "needs network to build" constraint. Decide during implementation
  planning, not blocking for this spec.
- No onboard speaker on the recommended board/mic combo — talk-back playback on the
  hardware unit remains out of scope, unchanged from `PLAN.md`'s Phase 6.

## Task breakdown (post-spike)

Only start these once the spike gate passes:

1. **ESPHome shell scaffold** — YAML config, board target, `esp-idf` framework pin,
   Wi-Fi + captive portal + OTA manifest wiring, logger.
2. **`wewe_webrtc` external component skeleton** — lifecycle hooks wired to ESPHome's
   component model, entity registration (connection-state, RMS-level, mute), empty
   stubs for the pieces below.
3. **I2S mic capture** — wire the chosen mic's BCLK/WS/DATA to the board, verify raw
   capture with a throwaway ESPHome `i2s_audio:`/`microphone:` test config *before*
   touching the WebRTC path, to isolate hardware/wiring bugs from firmware bugs.
4. **RMS/VAD gate port** — line-for-line port of `src/domain/noiseGate.ts` to C,
   with the frozen-EMA and stationarity-window invariants preserved and tested against
   the same fixtures the TS version uses, adapted to a C test harness.
5. **`signal-server` signaling client** — WebSocket + `cJSON`, implementing exactly
   the wire protocol in `signal-server/README.md`, tested against a local
   `make signal-server` instance before any real ESP32 flashing.
6. **`esp_peer`/`esp_webrtc` wiring** — connect the signaling client's SDP/ICE
   exchange and the gated mic samples to `esp_peer`'s API, first as a same-LAN test
   against a phone Parent, matching `peer_demo`'s call pattern.
7. **Pairing-code captive-portal form field** — the one piece of custom UI in the
   Wi-Fi provisioning flow.
8. **End-to-end validation** — real wewe Parent app ↔ this firmware: audio quality,
   gate behavior parity with the phone Monitor, remote (STUN, not just LAN)
   connectivity, an OTA update round-trip, and power-cycle/reconnect behavior.

Each of these is small enough to be its own implementation-plan task once this spec is
approved and handed to `writing-plans`.
