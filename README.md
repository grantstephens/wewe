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

The app defaults to `wss://api.wewe.hub13.xyz`, an instance the project maintainer runs —
see [`signal-server/README.md`](signal-server/README.md) for the wire protocol. Nothing
requires using it: the Settings screen persists an explicit override that always wins.
Run your own locally for development:

```bash
cd signal-server
npm install
npm run dev
```

Then set the Settings screen's relay URL to `ws://<your-machine-ip>:8787`.

In production, self-host it as a container: `signal-server/Dockerfile` builds a small
image, and [`.github/workflows/docker.yml`](.github/workflows/docker.yml) publishes one
to `ghcr.io/grantstephens/wewe-signal-server` on every push to `main` and on tags.
`signal-server/docker-compose.yml` runs the published image directly
(`docker compose up -d`), bound to `:8787` on all interfaces — put your own reverse
proxy in front to terminate TLS so the app can use `wss://` (see the compose file's
commented-out Traefik/Caddy label examples; if your proxy runs on a different
host/container, make sure it's actually reachable at that port, not just `localhost`).
See [`signal-server/README.md`](signal-server/README.md)
for the wire protocol and hardening knobs (room TTL, per-IP rate limiting).

### Site

`site/` is a small static marketing/privacy-policy site (`site/index.html`,
`site/privacy/index.html`) deployed to Cloudflare Pages at `wewe.hub13.xyz` — kept
deliberately separate from `api.wewe.hub13.xyz` (the signaling relay above), since
they're different kinds of thing serving different audiences. No build step, no Docker
image; push the `site/` directory to Cloudflare Pages directly (dashboard Git
integration, or `wrangler pages deploy site`).

### Releasing

Pushing a `v*` tag (e.g. `v1.0.0`) triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds a signed
APK and AAB and attaches them to a GitHub Release. `versionCode` is packed from the tag
itself (see [`tools/compute-version.sh`](tools/compute-version.sh) for the exact scheme),
so rebuilding a tag always reproduces the same value.

Before tagging, write the release notes to a file and run
`make prepare-release TAG=v1.0.1 CHANGELOG=path/to/notes.txt`. It computes the version and
commits it into `fdroid-version.txt`, so F-Droid's `checkupdates` (which can't do the
packing arithmetic itself) has a real, regex-extractable versionCode to read at that tag —
and it copies your notes into
`fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`. Then tag and push as the
command's own output says:

```bash
make prepare-release TAG=v1.0.1 CHANGELOG=path/to/notes.txt
git tag v1.0.1
git push origin main v1.0.1
```

`fdroid/xyz.hub13.wewe.yml` is a draft F-Droid recipe, not yet submitted — see the TODOs
at its top for what has to happen first (a real tagged release to point `Builds:` at, and
a verified from-source build, since this hasn't been tried against F-Droid's own build
infrastructure yet).

#### Signing setup

Android identifies an app by its signing certificate — every release must use the *same*
key, or existing users cannot upgrade and would have to uninstall, losing their paired
monitors and activity log. Generate it once, back it up somewhere you trust, and never
commit it:

```bash
keytool -genkeypair -v -keystore wewe.keystore -storetype PKCS12 \
        -alias wewe -keyalg RSA -keysize 4096 -validity 10000
```

Then set four repository secrets:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of the `.keystore` file |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias (`wewe` above) |
| `ANDROID_KEY_PASSWORD` | key password |

```bash
base64 -w0 wewe.keystore | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD
```

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
survive the screen turning off, verified on a physical device (Pixel 9, Android 16).
Real cross-NAT testing (two separate networks, not just LAN) is the immediate next
step (see `PLAN.md`).

Still ahead: the ESP32-S3 firmware (a standalone ESP-IDF application using Espressif's
`esp-webrtc-solution` — not an ESPHome YAML config, since ESPHome has no on-device
WebRTC component).
