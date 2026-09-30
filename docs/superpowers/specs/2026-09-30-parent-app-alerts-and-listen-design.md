# Parent App: Audible Alerts, Listen Button, Notification — Design

## Goal

Give the Parent app audible alerting for the two events a parent needs to notice even when not looking at the phone (a detected cry, a Monitor that's stayed unreachable), a manual way to check in on the Monitor's audio without waiting for a cry, and a persistent notification that actually reflects live connection state. All four are additive to existing, working flows — no protocol or architecture changes beyond one new bidirectional signal message for the Listen button.

## Components

### 1. Settings: two new toggles

`SETTINGS_KEYS.cryBeepEnabled` / `SETTINGS_KEYS.disconnectBeepEnabled`, following the existing string-valued settings convention (`'true'`/`'false'`), both **default enabled** — alerts a parent might rely on should opt out, not opt in. First `Switch` component in the app (`react-native-paper` already provides one; Settings currently only has a text field).

### 2. Cry beep

**The debounce behavior the user wants — "beep once, not again until it goes quiet and a new sound starts" — is already exactly what `CryAlertClassifier` implements** (`src/domain/cryAlert.ts`): `push()` returns `true` exactly once per continuous gate-open period, and `reset()` (already called in `ParentSessionsContext.tsx` whenever `getRemoteAudioLevel()` returns null, i.e. the gate closes) makes the next open period judged fresh. No new debounce logic is needed — the beep just needs wiring to the same `shouldAlert` trigger the existing `fireCryAlert` vibration/notification already uses, gated behind `cryBeepEnabled`.

Sound: a short single beep (not a two-stage escalation) — see Sound asset below.

### 3. Disconnect beep

Not event-driven like the cry beep — needs a **repeating** check: silent for the first 15s of being disconnected, then a beep every 15s until reconnected. Today's `connectStartedAt` field (fixed earlier this session to reset exactly when `connectionState` leaves `'connected'`, regardless of whether the transition passes through `disconnected`/`failed`) is exactly "when did the current disconnected period start" — reused directly rather than adding a duplicate timestamp.

New pure function, `src/domain/disconnectBeep.ts`:

```ts
export function shouldFireDisconnectBeep(
  connectStartedAt: number,
  lastBeepAtMs: number | null,
  now: number,
  thresholdMs: number,
  repeatMs: number,
): boolean {
  const disconnectedForMs = now - connectStartedAt;
  if (disconnectedForMs < thresholdMs) return false;
  if (lastBeepAtMs === null) return true;
  return now - lastBeepAtMs >= repeatMs;
}
```

Called every tick of `ParentSessionsContext.tsx`'s existing 500ms watchdog `setInterval`, only when `connectionState !== 'connected' && state.rejected === null`, with `thresholdMs=15_000, repeatMs=15_000`. The `rejected` exclusion matters: a rejected device never reaches `'connected'` at all, so without it a not-yet-authorized device would start repeat-beeping after 15s too — that's an authorization problem ("Not let in yet"), not a reachability problem, and already has its own UI treatment. A new `lastDisconnectBeepAtMs: number | null` field on `Managed`, reset to `null` whenever `connectionState === 'connected'`.

Gated behind `disconnectBeepEnabled`. Deliberately **not** reusing `fireConnectionLostAlert`'s existing trigger (`disconnected`/`failed` + `wasConnected`) — that fires once, immediately, on the state transition, which is exactly the instant beep the user explicitly said they don't want, and would also mean a beep on every brief, self-healing reconnect blip.

### 4. Sound asset + playback

One short tone, `assets/sounds/beep.wav` (880Hz, 150ms, faded in/out — generated locally, not sourced externally, so there's no licensing question). Played via `expo-audio` (already a dependency, currently only used for mic-level metering in `micLevel.ts` — this adds its playback side, `createAudioPlayer`/`useAudioPlayer`, no new package). New `src/platform/sounds.ts`:

```ts
export async function playBeep(): Promise<void> { /* expo-audio playback of assets/sounds/beep.wav */ }
```

Both the cry beep and the disconnect beep reuse this same sound — one asset, not two, since nothing in the request asked for them to sound different, and reusing keeps the asset/testing surface smaller.

### 5. Listen button — full scope

**Wire protocol.** New `SignalPayload` variant in `peerConnectionHelpers.ts`: `{ listenRequest: boolean }` (`true` = start, `false` = stop), plus an `isListenRequestSignal` type guard — mirrors the existing `inviteMode`/`setMonitorName` bidirectional pattern exactly.

**Software Monitor** (`monitorSession.ts`): already has `setGateOpen(open: boolean)`, wired to a local UI toggle in `Monitor.tsx`. A remote `listenRequest` signal calls the same method. Last-writer-wins if the local user and a remote Listen request disagree at the same moment — an accepted, rare-edge-case simplification, not a queue/priority system.

**Firmware Monitor** (`wewe_monitor.cpp`): the mic/gate is shared across every connected listener (`audio_send_task` already sends the same encoded frame to all of them — confirmed in the existing code), so a Listen request from any one Parent opens audio for all currently-connected Parents. Expected for a single-household device; called out here so it's a known decision, not a surprise.

- New global state: `bool listen_override` + `int64_t listen_override_expires_at_ms`, alongside the existing gate/invite state in `RuntimeState`.
- `audio_send_task`'s send-decision becomes `noise_gate_push(...) || (g_state.listen_override && now_ms < g_state.listen_override_expires_at_ms)`.
- A new inbound signal handler (mirroring how `inviteMode`/`setMonitorName` already parse via cJSON in `wewe_signaling.c`/`peer_msg_handler`) sets `listen_override = true` and `listen_override_expires_at_ms = now + LISTEN_OVERRIDE_TIMEOUT_MS` (60s) on `listenRequest: true`; clears both on `listenRequest: false`.
- **60s safety-net timeout**, same pattern as the existing 60s invite-code window — so a dropped connection, killed app, or missed "stop" signal never leaves the gate stuck open. The app also sends `listenRequest: false` on Parent-screen blur/unmount as routine hygiene, but the timeout is the real backstop.

**UI** (`Parent.tsx`): a third action button alongside "Hold to talk" / "Invite a listener", using the same `Button` + existing style pattern. Tap-toggle (matching "Invite a listener"'s pattern, not push-to-talk's hold pattern) — tap to start listening, tap again (or the 60s timeout) to stop.

### 6. Persistent notification — enrich existing text

The foreground-service notification already exists and is already persistent (`ongoing: true`, set in `platform/foregroundService.ts`). New pure function, `src/domain/connectionSummary.ts`:

```ts
export function describeConnectionStates(states: string[]): string {
  // "Monitor connected" / "All 3 monitors connected" / "2 of 3 connected" / "Reconnecting…" etc.
}
```

`ParentSessionsContext.tsx`'s existing `recomputeForegroundService` passes the live `connectionState` of every managed session through this instead of just a static count.

### 7. QoL addition: "Test alert sounds" button

A small button in Settings, next to the two new toggles, that plays the beep once on demand — lets someone verify they can actually hear/recognize it (volume, ringer mode, etc.) without waiting for a real cry or a real disconnect.

## Non-goals

- No change to the underlying cry-detection sensitivity (`CryAlertClassifier`'s thresholds) — reused as-is.
- No priority/ref-counting for concurrent Listen requests from multiple Parents — last-writer-wins, as stated above.
- No distinct sounds for cry vs. disconnect — one shared asset.
- No change to the existing silent vibration/notification alerts (`fireCryAlert`/`fireConnectionLostAlert`) — the new beeps are additive, played alongside them, not replacements.

## Testing approach

- `src/domain/disconnectBeep.test.ts` and `src/domain/connectionSummary.test.ts` — pure functions, host-runnable under the "logic" jest project, no mocking needed.
- Sound playback (`platform/sounds.ts`) and the Listen button's wire-protocol plumbing are thin platform/integration glue with no meaningful branching logic of their own to unit test in isolation — verified by real device testing (same convention established earlier this session for ESP32-adjacent work), not a synthetic test.
- Firmware `listen_override` change: verified via real `esphome compile`/`config` plus a real hardware Listen-button round trip (request → audio audible → stop → audio stops again), matching this project's established real-hardware verification convention for ESP32 work.
