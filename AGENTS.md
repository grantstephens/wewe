# Wewe — Agent guidance

This file provides guidance to coding agents (Claude Code, pi, etc.) when working in
this repository.

## What this is

A baby monitor (React Native + Expo), audio-only, where the "monitor" end can be either
a second phone or a purpose-built ESP32-S3 hardware unit with a microphone. See
[`PLAN.md`](PLAN.md) for the full architecture rationale and phased delivery plan —
read it before making an architectural change, since several design decisions there
(WebRTC over a custom protocol, STUN-only for v1, noise-gating at the source rather than
always-on streaming, no ESPHome for the firmware) were made deliberately with stated
tradeoffs, not defaults.

This project's scaffolding (toolchain pinning, layered `src/domain`/`storage`/
`platform`/`screens` split, MD3 theme generation, jest project split) was adapted from
the sibling project DriveWell — see that repository's own `AGENTS.md` for the reasoning
behind the mechanics this repo reuses verbatim (the `SqlDatabase` seam, the
`storeContract.ts` pattern, RFC3339 UTC timestamps, `await render`/`await fireEvent` in
screen tests).

## Expo version

Targets Expo SDK **57**. Read the exact versioned docs at
https://docs.expo.dev/versions/v57.0.0/ before writing any code that uses Expo APIs.

## The toolchain

Pinned in [`mise.toml`](mise.toml) — `mise install` after cloning.

**Dependency installs need `--legacy-peer-deps`.** The Expo/React 19/react-native-webrtc
combination has real (not spurious) peer-dependency conflicts at the edges. One
consequence: `--legacy-peer-deps` disables npm 7+'s automatic peer-dependency
auto-install, so packages that declare a *required* peer dependency (e.g.
`@testing-library/react-native`'s peer on `test-renderer`) will not get installed
automatically — they need to be added as explicit direct dependencies. If a fresh
`npm install` ever produces a "Cannot find module" failure specifically inside a test
run, suspect a missing peer dependency before suspecting the test.

## Commands

```bash
make check          # tsc --noEmit && jest — the gate before any commit
make test           # jest
make start          # Expo dev server; needs a dev client, NOT Expo Go
make android        # Expo dev server, opening on a connected device
make signal-server  # run the local signaling relay for development
```

Or without `make`: `npm run check`, `npx jest src/domain/noiseGate.test.ts` for a single
file.

**Not Expo-Go-compatible.** `react-native-webrtc`, `react-native-zeroconf`, and
`expo-camera`'s barcode scanner all require custom native code — `expo prebuild` and a
dev client are required, same posture as DriveWell.

## Architecture

Layered, dependencies pointing inward, same convention as DriveWell.

| Directory | Role |
|---|---|
| `src/domain` | Pure TypeScript, no React/Expo imports, runs in plain Node Jest: `NoiseGate` (adaptive-threshold streaming gate), `CryAlertClassifier` (Parent-side alert heuristic), `pairing.ts` (code generation/validation, QR URI encode/decode), `activityLog.ts`, `store.ts` (the `Store` interface + `SETTINGS_KEYS`), `timestamp.ts`. |
| `src/webrtc` | `signalingClient.ts` (the app-side half of `signal-server`'s room protocol), `peerConnectionHelpers.ts` (ICE candidate queueing, the shared `handleIncomingSdp` both sessions use so either side can renegotiate — see its doc comment), `monitorSession.ts`, `parentSession.ts`. Neither session file imports React; they're plain classes constructed and driven from screens. |
| `src/platform` | The parts that differ per build target: `micLevel.ts` (expo-audio metering tap, separate from the WebRTC track — see its doc comment for why two capture paths exist), `discovery.ts` (mDNS via react-native-zeroconf, UX sugar only, never the only pairing path), `alerts.ts` (notifications + vibration), `foregroundService.ts` (persistent Android foreground-service notification — see the "unverified" note below). |
| `src/storage` | `SqliteStore` (via `expo-sqlite`/`node:sqlite`), held to `storeContract.ts`'s behavioural contract. |
| `src/screens` | Home, Monitor, Parent, AddMonitor, Settings. |
| `src/theme.ts` | MD3 theme via `@material/material-color-utilities`, same pattern as DriveWell — seed color is the app icon's night-navy, not a leaf green. |
| `signal-server/` | Independent Node/TypeScript project (own `package.json`/`tsconfig.json`/`jest.config.js`) — a stateless WebSocket relay. See its own README for the wire protocol. |

### Invariants worth not breaking

- **The noise gate runs on the Monitor, the alert classifier runs on the Parent.**
  Deliberately not the same place: gating (whether to transmit at all) has to be cheap
  enough to run on an ESP32 eventually, while alert sensitivity is something a parent
  should be able to tune (or a future ML classifier replace) without re-flashing
  firmware. Don't collapse these into one component.
- **`NoiseGate`'s adaptive floor never updates while the gate is open.** If it did, a
  sustained loud event would raise the floor to meet itself and the gate would decide
  the room simply got louder — see the class doc comment. Any change to the gating
  algorithm must preserve this property.
- **Either WebRTC side can send a fresh SDP offer at any time** — `handleIncomingSdp` in
  `peerConnectionHelpers.ts` decides what an incoming description means from its `type`
  (`offer` → answer it; `answer` → just apply it), not from which side historically
  went first. This is what makes push-to-talk work: the Parent, normally only ever an
  answerer for the initial call, becomes an offerer the moment `startTalking()` adds its
  track. Don't reintroduce a "the offerer is always X" assumption in either session.
- **The signaling relay has a convenience default, not a hard requirement.**
  `SETTINGS_KEYS.signalingServerUrl` falls back to `DEFAULT_SIGNALING_SERVER_URL`
  (`src/domain/store.ts`, currently `wss://wewe.hub13.xyz`, an instance the project
  maintainer runs) at every read site when unset, so the app works out of the box —
  but Settings still persists an explicit override that always wins. This reverses an
  earlier decision (see git history / PLAN.md's open items) to have no default at all;
  don't hardcode the default URL anywhere except that one constant.
- **`react-native-webrtc`'s shipped TypeScript declarations are missing their
  `vendor/event-target-shim` module** in the installed version at the time this was
  written (verify with `find node_modules/react-native-webrtc/lib/typescript -iname
  '*vendor*'` if this ever changes). Consequence: its `EventTarget`-inherited members
  (`addEventListener`, strongly-typed event payloads) don't resolve — use the `on<event>
  = handler` property-setter style everywhere, and annotate the handler's `event`
  parameter explicitly (see `monitorSession.ts`/`parentSession.ts`) rather than relying
  on inference, or `noImplicitAny` will fail the build.
- **Nothing crashes on a user's device.** `Store` methods reject with errors; a failed
  database open renders an error screen, not a blank app — same rule as DriveWell.
- Out of scope by design (see PLAN.md): video, TURN/CGNAT fallback in v1, an ESPHome
  YAML config for the hardware unit (real on-device WebRTC needs Espressif's ESP-IDF
  `esp-webrtc-solution`, not ESPHome).
- **`react-native-notify-kit`, not `@notifee/react-native`, backs the foreground
  service.** The original Notifee was archived (April 2026); this is a maintained,
  New-Architecture-compatible fork with an Expo config plugin, API-compatible with
  Notifee's own docs. `registerForegroundServiceRunner()` is called once in `index.ts`,
  outside any component, before anything can call `startForegroundSession()` — this is
  the library's own documented requirement, not a style choice.
- **Foreground-service startup is verified on a real device (Pixel 9, Android 16) —
  do not use `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`.** Parent's session used to
  request `[CONNECTED_DEVICE, MICROPHONE]`; on real hardware that crashed immediately
  with `SecurityException: Starting FGS with type connectedDevice ... requires
  permissions [FOREGROUND_SERVICE_CONNECTED_DEVICE] and any of [BLUETOOTH_*, NFC,
  ...]` — `CONNECTED_DEVICE` is for apps managing a physical Bluetooth/USB/NFC
  accessory, not a WebRTC peer connection, and this app declares none of those
  permissions on purpose. Fixed to `[MEDIA_PLAYBACK, MICROPHONE]` (Parent is playing
  received audio in the background; Monitor's own `MICROPHONE`-only type was already
  correct). The `types` array passed at each `startForegroundSession()` call site and
  `app.json`'s `react-native-notify-kit` plugin config (`android.foregroundService.types`,
  which the generated manifest's `<service foregroundServiceType="...">` is derived
  from) must be changed together — the plugin config needs a fresh `expo prebuild` to
  take effect, a JS-only edit won't. Still **not** verified: whether the session
  survives extended screen-off backgrounding, or holds up under Android 14+'s
  microphone-type enforcement over a long push-to-talk session rather than a short
  test — only confirmed it starts without crashing and stays foregrounded briefly.

### Testing gotchas specific to this stack

- **`await render(...)` and `await fireEvent(...)` in every screen test.** Same
  act()-scope corruption risk DriveWell's `AGENTS.md` documents — an unawaited call
  overlaps the next `act()` scope and later `render()` calls in the same file silently
  produce an empty tree.
- **`signal-server`'s tests use a persistent per-socket message queue
  (`TestClient`), never a one-off `.once('message', …)` re-attached after each
  `await`.** When the relay sends two messages back-to-back in one synchronous burst
  (e.g. `joined` immediately followed by `peer-joined`), both frames can arrive in the
  same underlying `data` event; a listener attached only after the first message's
  `await` resolves misses the second one entirely. This was a real, reproduced bug —
  see the git history of `signal-server/src/server.test.ts` — not a hypothetical.
- **`Promise.withResolvers()`** is used throughout in place of `new Promise((resolve) =>
  …)` — needs `lib: ["ES2024"]` (or later) in whatever `tsconfig.json` compiles the file;
  `signal-server/tsconfig.json` sets this explicitly since Node's default lib target is
  older.

## Data

`wewe.db` via `expo-sqlite` (or `node:sqlite` in tests). Uninstalling the app deletes
paired monitors and the activity log — stated plainly in the README, not a gap to
silently fix later.

## Releasing

Not set up yet. DriveWell's `Makefile`/`.github/workflows/release.yml`/F-Droid recipe
are the proven template to adapt once there's a real release candidate to point them at
— see `PLAN.md`'s Parity phase.
