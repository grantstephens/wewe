# Wewe

A baby monitor (in the spirit of Dormi) with one difference: the monitor end can be a
phone, or a purpose-built ESP32-S3 hardware unit with a microphone. Audio-only — no
video. Built with React Native (Expo) and Material Design 3.

The whole system is two WebRTC peers — a Monitor (phone or ESP32-S3) and a Parent
(phone) — talking through a tiny relay that only ever forwards call setup, never audio.
See [`PLAN.md`](PLAN.md) for the full architecture and phased delivery plan.

## How it works

1. **Monitor** generates a pairing code, shows it as text and a QR code, and starts
   listening on the mic. A local noise gate (adaptive, no configuration needed) only
   opens the outgoing audio track when it detects sound — quiet nursery time transmits
   nothing.
2. **Parent** scans the code (or types it, or picks the monitor from a local-network
   list) and connects. Once audio is flowing, a second classifier decides whether the
   incoming sound is worth an alert (vibration + notification) versus just logging it.
3. Push-to-talk lets the parent talk back; the monitor's mic and the parent's talk-back
   share the same peer connection, added/enabled on demand.

Media is peer-to-peer, encrypted end-to-end by WebRTC's own DTLS-SRTP — the signaling
relay (`signal-server/`) never sees or stores audio, and keeps no state beyond
currently-open pairing rooms in memory.

## Repository layout

```
src/domain/     pure TypeScript: NoiseGate, CryAlertClassifier, pairing codes, the
                Store contract, timestamp formatting — no React/Expo, tested in
                plain Node (same rule as the sibling DriveWell project).
src/webrtc/     signaling client, MonitorSession/ParentSession (peer-connection
                lifecycle), the shared SDP/ICE handling both sides use.
src/platform/   mic level metering (expo-audio), mDNS discovery/advertising
                (react-native-zeroconf), alerts (notifications + vibration), the
                persistent Android foreground-service notification.
src/screens/    Home, Monitor, Parent, AddMonitor, Settings.
src/storage/    SqliteStore (expo-sqlite on device, node:sqlite in tests) behind a
                shared behavioural contract.
src/theme.ts    Material Design 3 theme generated from one seed color.
signal-server/  the stateless WebSocket signaling relay — see its own README.
```

## Development

Toolchain pinned in [`mise.toml`](mise.toml) — run `mise install` after cloning.

```bash
make check          # tsc --noEmit && jest — the gate before any commit
make test           # jest
make start          # Expo dev server (needs a dev client — see below)
make signal-server  # run the local signaling relay for development
```

**Not Expo-Go-compatible.** `react-native-webrtc` requires custom native code, so this
needs `expo prebuild` and a dev client, not Expo Go. `npx expo run:android` after
`mise install` and `npm install`.

### Signaling server

There is no default relay baked into the app — see
[`signal-server/README.md`](signal-server/README.md). Run one locally for development:

```bash
cd signal-server
npm install
npm run dev
```

Then set the Settings screen's relay URL to `ws://<your-machine-ip>:8787`.

## Your data

Paired monitors and the activity log live in the app's private SQLite database on the
device. Uninstalling the app deletes them. There is no cloud account, no sync, and no
audio ever leaves either device except peer-to-peer to whichever phone/ESP32 you paired
with.

## Status

Phone-to-phone monitoring is implemented and covered by the automated test suite
(`make check`, 59 tests): pairing (code/QR/mDNS), WebRTC audio with noise gating,
cry/connection-loss alerts, activity log, push-to-talk, custom relay settings, a
hardened signal-server (room TTL + per-IP rate limiting), signaling reconnect with
exponential backoff, and an Android foreground-service notification so the mic/socket
survive the screen turning off. The foreground service is implemented per its library's
documented API and confirmed via `expo prebuild`'s generated manifest, but **not yet
verified on a physical device** — that verification, plus real cross-NAT testing, is
the immediate next step (see `PLAN.md`).

Still ahead: the ESP32-S3 firmware (a standalone ESP-IDF application using Espressif's
`esp-webrtc-solution` — not an ESPHome YAML config, since ESPHome has no on-device
WebRTC component).
