# Parent App Alerts, Listen Button, and Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add settings-gated audible beeps for a detected cry and a sustained Monitor disconnect, a manual "Listen" button that bypasses the noise gate on demand, and enrich the already-existing persistent foreground notification with live connection state.

**Architecture:** Additive changes across existing files only — no new subsystems. Two new tiny pure-logic modules (`disconnectBeep.ts`, `connectionSummary.ts`) follow the existing `connectWatchdog.ts` pattern (testable under the "logic" jest project, no React/RN imports). The Listen button adds one new bidirectional `SignalPayload` variant, following the existing `inviteMode`/`setMonitorName` pattern exactly on both the app side (`peerConnectionHelpers.ts`, `monitorSession.ts`, `parentSession.ts`) and the firmware side (`wewe_monitor.cpp`'s `on_signal`).

**Tech Stack:** React Native/Expo (`expo-audio` for beep playback — already a dependency, currently only used for mic-level metering), `react-native-paper` (`Switch` component, not yet used in this app), ESPHome external_component C++ (wewe_monitor.cpp).

**Spec:** `docs/superpowers/specs/2026-09-30-parent-app-alerts-and-listen-design.md`

## Global Constraints

- Both new settings (`cryBeepEnabled`, `disconnectBeepEnabled`) default to **enabled** (`'true'`) when never explicitly set.
- The cry beep reuses `CryAlertClassifier`'s existing once-per-open-period trigger exactly — no new debounce logic.
- The disconnect beep is **not** instant: silent for the first 15s of `connectionState !== 'connected' && rejected === null`, then fires and repeats every 15s until reconnected. It must **not** reuse `fireConnectionLostAlert`'s trigger (that fires once, immediately, on the state transition).
- One shared `assets/sounds/beep.wav` (already generated and committed) for both the cry beep and the disconnect beep — no second sound asset.
- The Listen button's gate-override is a **global** flag on both Monitor implementations (mic/gate is shared across every connected listener already) — a Listen request from any one Parent opens audio for everyone currently connected. This is expected, not a bug to fix.
- The Listen override has a **60s safety-net timeout** on the firmware side (`LISTEN_OVERRIDE_TIMEOUT_MS`), matching the existing 60s invite-code window pattern (`INVITE_WINDOW_MS`) already in this file.
- Every firmware task must be verified with a real `esphome compile` (exit code checked from the log, never assumed) — this project's established convention.

## Review Focus

- A Listen request arriving for a `device_id` that isn't an already-connected listener (`find_listener(from) == nullptr`) must be ignored, exactly like the existing `inviteMode` signal's same guard — tested in Task 7.
- The disconnect beep must not fire for a `rejected` device (never authorized, never reaches `'connected'`) — tested in Task 3.
- The disconnect beep's repeat timing must use `lastBeepAtMs`, not re-derive from `connectStartedAt` each tick, or it would beep every tick past the threshold instead of every 15s — tested in Task 3.
- The cry beep must not re-fire while the gate stays open (same episode) — this is `CryAlertClassifier`'s existing, already-tested behavior; Task 2 confirms the new beep call site is gated on the same `shouldAlert` value the existing `fireCryAlert` uses, not a new poll-driven condition.
- The persistent notification text must correctly describe the zero-monitors-configured-yet state (an empty `states` list) without crashing or showing something empty — tested in Task 5.

---

## Task 1: Settings — two new toggles

**Files:**
- Modify: `src/domain/store.ts:60-68` (`SETTINGS_KEYS`)
- Modify: `src/screens/Settings.tsx`
- Test: `src/screens/Settings.test.tsx` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SETTINGS_KEYS.cryBeepEnabled`, `SETTINGS_KEYS.disconnectBeepEnabled` (string keys `'cryBeepEnabled'`/`'disconnectBeepEnabled'`), read via `store.getSetting(key)` returning `'true'`/`'false'`/`null` (null = default to enabled). Later tasks read these two keys directly — no helper function, matching how `signalingServerUrl` is read directly in `ParentSessionsContext.tsx` today.

- [ ] **Step 1: Add the two new keys to `SETTINGS_KEYS`**

In `src/domain/store.ts`, replace:

```typescript
export const SETTINGS_KEYS = {
  signalingServerUrl: 'signalingServerUrl',
  noiseGateSensitivity: 'noiseGateSensitivity',
  deviceId: 'deviceId',
  /** This install's persistent, never-displayed relay room id when acting as a Monitor — see `getOrCreateMonitorRoomId`. */
  monitorRoomId: 'monitorRoomId',
  /** This install's current display name when acting as a Monitor — see `getOrCreateMonitorName`/`setMonitorName` in `src/domain/monitorName.ts`. */
  monitorName: 'monitorName',
} as const;
```

with:

```typescript
export const SETTINGS_KEYS = {
  signalingServerUrl: 'signalingServerUrl',
  noiseGateSensitivity: 'noiseGateSensitivity',
  deviceId: 'deviceId',
  /** This install's persistent, never-displayed relay room id when acting as a Monitor — see `getOrCreateMonitorRoomId`. */
  monitorRoomId: 'monitorRoomId',
  /** This install's current display name when acting as a Monitor — see `getOrCreateMonitorName`/`setMonitorName` in `src/domain/monitorName.ts`. */
  monitorName: 'monitorName',
  /** 'true'/'false'; null (never set) defaults to enabled — see Parent app alerts spec. */
  cryBeepEnabled: 'cryBeepEnabled',
  /** 'true'/'false'; null (never set) defaults to enabled — see Parent app alerts spec. */
  disconnectBeepEnabled: 'disconnectBeepEnabled',
} as const;
```

- [ ] **Step 2: Write the failing screen test**

Create `src/screens/Settings.test.tsx`:

```tsx
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import { SettingsScreen } from './Settings';
import { SETTINGS_KEYS } from '../domain/store';
import { WeweContext } from '../WeweContext';

function fakeStore(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    getSetting: jest.fn((key: string) => Promise.resolve(values[key] ?? null)),
    setSetting: jest.fn((key: string, value: string) => {
      values[key] = value;
      return Promise.resolve();
    }),
  } as unknown as import('../domain/store').Store;
}

test('cry beep toggle defaults on and can be switched off and saved', async () => {
  const store = fakeStore();
  const { getByText, getByTestId } = await render(
    <WeweContext.Provider value={{ store, revision: 0, bumpRevision: () => {} }}>
      <SettingsScreen />
    </WeweContext.Provider>,
  );

  await waitFor(() => expect(getByTestId('cry-beep-switch').props.value).toBe(true));

  await fireEvent(getByTestId('cry-beep-switch'), 'onValueChange', false);
  await fireEvent.press(getByText('Save'));

  await waitFor(() => expect(store.setSetting).toHaveBeenCalledWith(SETTINGS_KEYS.cryBeepEnabled, 'false'));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/screens/Settings.test.tsx`
Expected: FAIL — `getByTestId('cry-beep-switch')` not found (the Switch doesn't exist yet).

- [ ] **Step 4: Add the two Switch toggles to Settings.tsx**

Replace the full file with:

```tsx
import React from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { Button, HelperText, Switch, Text, TextInput, useTheme } from 'react-native-paper';

import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS } from '../domain/store';
import { playBeep } from '../platform/sounds';
import { useWewe } from '../WeweContext';

/**
 * The signaling relay URL defaults to DEFAULT_SIGNALING_SERVER_URL (a
 * convenience instance the project maintainer runs) so the app works out
 * of the box, but nothing requires using it — this field always shows the
 * effective value and Save persists whatever's typed here, overriding the
 * default. Both Monitor and Parent screens read this same persisted value.
 */
export function SettingsScreen() {
  const theme = useTheme();
  const { store } = useWewe();
  const [relayUrl, setRelayUrl] = React.useState('');
  const [cryBeepEnabled, setCryBeepEnabled] = React.useState(true);
  const [disconnectBeepEnabled, setDisconnectBeepEnabled] = React.useState(true);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    store.getSetting(SETTINGS_KEYS.signalingServerUrl).then((value) => setRelayUrl(value || DEFAULT_SIGNALING_SERVER_URL));
    store.getSetting(SETTINGS_KEYS.cryBeepEnabled).then((value) => setCryBeepEnabled(value !== 'false'));
    store.getSetting(SETTINGS_KEYS.disconnectBeepEnabled).then((value) => setDisconnectBeepEnabled(value !== 'false'));
  }, [store]);

  const save = async () => {
    await store.setSetting(SETTINGS_KEYS.signalingServerUrl, relayUrl.trim());
    await store.setSetting(SETTINGS_KEYS.cryBeepEnabled, cryBeepEnabled ? 'true' : 'false');
    await store.setSetting(SETTINGS_KEYS.disconnectBeepEnabled, disconnectBeepEnabled ? 'true' : 'false');
    setSaved(true);
  };

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        Settings
      </Text>

      <Text variant="titleMedium" style={styles.sectionTitle}>
        Alerts
      </Text>
      <View style={styles.toggleRow}>
        <Text variant="bodyMedium" style={styles.toggleLabel}>
          Beep when a cry is detected
        </Text>
        <Switch
          testID="cry-beep-switch"
          value={cryBeepEnabled}
          onValueChange={(value) => {
            setCryBeepEnabled(value);
            setSaved(false);
          }}
        />
      </View>
      <View style={styles.toggleRow}>
        <Text variant="bodyMedium" style={styles.toggleLabel}>
          Beep when the monitor is unreachable
        </Text>
        <Switch
          testID="disconnect-beep-switch"
          value={disconnectBeepEnabled}
          onValueChange={(value) => {
            setDisconnectBeepEnabled(value);
            setSaved(false);
          }}
        />
      </View>
      <Button mode="outlined" onPress={() => playBeep().catch(() => {})} style={styles.testButton}>
        Test alert sound
      </Button>

      <Text variant="titleMedium" style={styles.sectionTitle}>
        Signaling server
      </Text>
      <Text variant="bodyMedium" style={styles.help}>
        Wewe has no server of its own beyond this: a small relay that only ever forwards call
        setup, never audio. A default is provided so this works out of the box — run your own
        instead, or point at one you trust.{' '}
        <Text style={{ color: theme.colors.primary }} onPress={() => Linking.openURL('https://wewe.hub13.xyz/privacy/')}>
          Read more about what it can see.
        </Text>
      </Text>
      <TextInput
        label="Relay URL"
        placeholder="wss://relay.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        value={relayUrl}
        onChangeText={(text) => {
          setRelayUrl(text);
          setSaved(false);
        }}
      />
      <HelperText type="info" visible={saved}>
        Saved.
      </HelperText>
      <View style={styles.actions}>
        <Button mode="contained" onPress={save}>
          Save
        </Button>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 24 },
  title: { marginBottom: 16 },
  sectionTitle: { marginTop: 8, marginBottom: 4 },
  help: { marginBottom: 12 },
  actions: { marginTop: 12 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  toggleLabel: { flex: 1, marginRight: 12 },
  testButton: { marginBottom: 16, alignSelf: 'flex-start' },
});
```

This references `../platform/sounds` (`playBeep`), which doesn't exist yet — Task 4 creates it. `npx jest src/screens/Settings.test.tsx` in the next step will fail to resolve that import until Task 4 lands; that's expected and fine since Task 4 comes right after this one and the whole plan's test command (Task 10) re-runs everything at the end. To keep this task's own step self-contained and its test runnable in isolation right now, create a minimal stub first:

```bash
mkdir -p src/platform
cat > src/platform/sounds.ts <<'EOF'
export async function playBeep(): Promise<void> {}
EOF
```

Task 4 replaces this stub with the real implementation.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/screens/Settings.test.tsx`
Expected: PASS — 1/1.

- [ ] **Step 6: Commit**

```bash
git add src/domain/store.ts src/screens/Settings.tsx src/screens/Settings.test.tsx src/platform/sounds.ts
git commit -m "feat(settings): add cry/disconnect beep toggles"
```

---

## Task 2: Sound playback (`platform/sounds.ts`)

**Files:**
- Modify: `src/platform/sounds.ts` (replaces Task 1's stub)
- Test: none — thin `expo-audio` playback glue with no branching logic of its own, matching this project's established convention that platform glue is verified by real device testing, not a synthetic unit test (see this plan's Global Constraints and the spec's own Testing approach section).

**Interfaces:**
- Consumes: `assets/sounds/beep.wav` (already committed).
- Produces: `playBeep(): Promise<void>` — already consumed by Task 1's Settings screen; also consumed by Task 3 (cry beep) and Task 5 (disconnect beep).

- [ ] **Step 1: Implement real playback**

Replace `src/platform/sounds.ts`:

```typescript
import { createAudioPlayer } from 'expo-audio';

/**
 * One short beep, reused for both the cry alert and the sustained-disconnect
 * alert (see the alerts/listen design spec — deliberately one shared asset,
 * not two). A fresh player per call rather than one long-lived instance:
 * expo-audio's player is a thin native handle: creating and releasing one
 * per beep is cheap, and avoids any "still playing the previous beep" state
 * to manage across rapid repeats (the disconnect beep fires every 15s).
 */
export async function playBeep(): Promise<void> {
  const player = createAudioPlayer(require('../../assets/sounds/beep.wav'));
  player.play();
  setTimeout(() => player.release(), 1000);
}
```

- [ ] **Step 2: Verify the app still typechecks and the existing suite passes**

Run: `npm run typecheck && npx jest`
Expected: typecheck clean, all existing tests still pass (Task 1's Settings test included).

- [ ] **Step 3: Commit**

```bash
git add src/platform/sounds.ts
git commit -m "feat(sounds): implement beep playback via expo-audio"
```

---

## Task 3: Disconnect beep — pure logic + wiring

**Files:**
- Create: `src/domain/disconnectBeep.ts`
- Test: `src/domain/disconnectBeep.test.ts`
- Modify: `src/ParentSessionsContext.tsx`

**Interfaces:**
- Consumes: `Managed.connectStartedAt` (already exists, fixed earlier this session to reset exactly when `connectionState` leaves `'connected'`), `Managed.state.connectionState`, `Managed.state.rejected`, `playBeep()` (Task 2).
- Produces: `shouldFireDisconnectBeep(connectStartedAt: number, lastBeepAtMs: number | null, now: number, thresholdMs: number, repeatMs: number): boolean` — not consumed elsewhere in this plan.

- [ ] **Step 1: Write the failing tests**

Create `src/domain/disconnectBeep.test.ts`:

```typescript
import { shouldFireDisconnectBeep } from './disconnectBeep';

describe('shouldFireDisconnectBeep', () => {
  it('stays silent before the threshold elapses', () => {
    expect(shouldFireDisconnectBeep(1_000, null, 1_000 + 14_999, 15_000, 15_000)).toBe(false);
  });

  it('fires the first time right at the threshold', () => {
    expect(shouldFireDisconnectBeep(1_000, null, 1_000 + 15_000, 15_000, 15_000)).toBe(true);
  });

  it('does not fire again before the repeat interval elapses', () => {
    const lastBeepAtMs = 1_000 + 15_000;
    expect(shouldFireDisconnectBeep(1_000, lastBeepAtMs, lastBeepAtMs + 14_999, 15_000, 15_000)).toBe(false);
  });

  it('fires again once the repeat interval elapses', () => {
    const lastBeepAtMs = 1_000 + 15_000;
    expect(shouldFireDisconnectBeep(1_000, lastBeepAtMs, lastBeepAtMs + 15_000, 15_000, 15_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/domain/disconnectBeep.test.ts`
Expected: FAIL — `Cannot find module './disconnectBeep'`.

- [ ] **Step 3: Implement**

Create `src/domain/disconnectBeep.ts`:

```typescript
/**
 * Decides whether the Parent app should fire a disconnect beep this tick.
 * Deliberately NOT event-driven like fireConnectionLostAlert (which fires
 * once, immediately, on the disconnected/failed transition) — the user
 * explicitly wants a delay before the first beep (so a brief, self-healing
 * reconnect blip — the common case, see this session's ~90s ICE-disconnect
 * investigation — never beeps at all) and a repeat while the problem
 * persists (so a genuinely stuck connection keeps getting noticed).
 */
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/domain/disconnectBeep.test.ts`
Expected: PASS — 4/4.

- [ ] **Step 5: Wire into `ParentSessionsContext.tsx`**

Note on what this step's wiring does that `shouldFireDisconnectBeep` itself does not: the `rejected`-device exclusion (Review Focus's second item — a not-yet-authorized device must never repeat-beep) is applied at this call site (`if (managed.state.rejected === null) { ... }`), not inside the tested pure function, since `rejected` isn't one of `shouldFireDisconnectBeep`'s parameters. `ParentSessionsContext.tsx` has no test file in this codebase (same structural reason as `monitorSession.ts` before Task 7 — it's a context provider exercised through screen-level integration, not unit tests), so this specific exclusion is verified by reading the wiring back after writing it, not by an automated assertion — same honesty-about-coverage approach as Task 4's Step 3.

Add the import near the top (alongside the other `./domain/*` imports):

```typescript
import { shouldFireDisconnectBeep } from './domain/disconnectBeep';
```

Add two new constants near `CONNECT_TIMEOUT_MS`:

```typescript
/** How long a session may stay disconnected before the first audible beep — deliberately not instant, see disconnectBeep.ts. */
const DISCONNECT_BEEP_THRESHOLD_MS = 15_000;
/** How often the disconnect beep repeats while the problem persists. */
const DISCONNECT_BEEP_REPEAT_MS = 15_000;
```

Add `lastDisconnectBeepAtMs: number | null` to the `Managed` interface:

```typescript
interface Managed {
  session: ParentSession;
  state: ParentSessionState;
  classifier: CryAlertClassifier;
  wasConnected: boolean;
  connectStartedAt: number;
  lastDisconnectBeepAtMs: number | null;
}
```

Initialize it in `startSession`'s `managed` object literal, alongside `connectStartedAt: Date.now(),`:

```typescript
        connectStartedAt: Date.now(),
        lastDisconnectBeepAtMs: null,
```

In the watchdog `setInterval` (the block containing `if (managed.state.connectionState !== 'connected' && !managed.state.connectTimedOut)`), replace that whole `if` block with:

```typescript
        if (managed.state.connectionState === 'connected') {
          managed.lastDisconnectBeepAtMs = null;
        } else {
          if (!managed.state.connectTimedOut && Date.now() - managed.connectStartedAt > CONNECT_TIMEOUT_MS) {
            managed.state = { ...managed.state, connectTimedOut: true };
            changed = true;
          }
          if (managed.state.rejected === null) {
            store.getSetting(SETTINGS_KEYS.disconnectBeepEnabled).then((enabled) => {
              if (enabled === 'false') return;
              const now = Date.now();
              if (shouldFireDisconnectBeep(managed.connectStartedAt, managed.lastDisconnectBeepAtMs, now, DISCONNECT_BEEP_THRESHOLD_MS, DISCONNECT_BEEP_REPEAT_MS)) {
                managed.lastDisconnectBeepAtMs = now;
                playBeep().catch(() => {});
              }
            });
          }
        }
```

Add the `playBeep` import alongside the existing `fireConnectionLostAlert, fireCryAlert` import:

```typescript
import { fireConnectionLostAlert, fireCryAlert } from './platform/alerts';
import { playBeep } from './platform/sounds';
```

- [ ] **Step 6: Run the full suite to verify nothing broke**

Run: `npm run typecheck && npx jest`
Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/domain/disconnectBeep.ts src/domain/disconnectBeep.test.ts src/ParentSessionsContext.tsx
git commit -m "feat(alerts): repeating disconnect beep after 15s, settings-gated"
```

---

## Task 4: Cry beep wiring

**Files:**
- Modify: `src/ParentSessionsContext.tsx`

**Interfaces:**
- Consumes: `playBeep()` (Task 2), the existing `shouldAlert` value already computed in the watchdog interval's `managed.classifier.push(...)` call.
- Produces: nothing new — this task only adds a settings-gated side effect at an existing trigger point.

- [ ] **Step 1: Write the failing test**

There's no existing test file for `ParentSessionsContext.tsx` (it's a context provider, exercised today only through screen-level integration, not unit tests) — adding one just for this one-line conditional would be new test infrastructure disproportionate to the change. Instead, this step extends the plan's real-device verification (Task 10) to explicitly exercise this path; the "test" for this task is Step 3 below (confirm the beep call site is gated on the pre-existing, already-tested `shouldAlert` value, not new logic) plus Task 10's real-device cry test.

Skip to Step 2.

- [ ] **Step 2: Wire the beep into the existing cry-alert call site**

In `src/ParentSessionsContext.tsx`'s watchdog interval, find:

```typescript
          const shouldAlert = managed.classifier.push(levelDb, Date.now());
          if (shouldAlert) {
            fireCryAlert(managed.state.monitor.label).catch(() => {});
            logEvent(managed.state.monitor.id, 'cry_alert');
          }
```

Replace with:

```typescript
          const shouldAlert = managed.classifier.push(levelDb, Date.now());
          if (shouldAlert) {
            fireCryAlert(managed.state.monitor.label).catch(() => {});
            logEvent(managed.state.monitor.id, 'cry_alert');
            store.getSetting(SETTINGS_KEYS.cryBeepEnabled).then((enabled) => {
              if (enabled !== 'false') playBeep().catch(() => {});
            });
          }
```

This reuses the exact same `shouldAlert` boolean the existing (already-tested-by-`CryAlertClassifier`'s-own-tests) vibration/notification alert uses — the beep fires under precisely the same "once per open period" condition, with no new debounce logic, per the spec's core finding.

- [ ] **Step 3: Verify the call site is correctly gated**

Read back the edited block and confirm: the beep call is inside the same `if (shouldAlert)` block as the existing `fireCryAlert` call, not a new/separate condition. This is the check this task's "test" consists of — there is no separate automated assertion for it (see Step 1).

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npx jest`
Expected: typecheck clean, all tests pass (no new tests added this task; this confirms no regression).

- [ ] **Step 5: Commit**

```bash
git add src/ParentSessionsContext.tsx
git commit -m "feat(alerts): cry beep, reusing the existing once-per-episode trigger"
```

---

## Task 5: Persistent notification — enrich with live connection state

**Files:**
- Create: `src/domain/connectionSummary.ts`
- Test: `src/domain/connectionSummary.test.ts`
- Modify: `src/ParentSessionsContext.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `describeConnectionStates(states: string[]): string` — not consumed elsewhere in this plan.

- [ ] **Step 1: Write the failing tests**

Create `src/domain/connectionSummary.test.ts`:

```typescript
import { describeConnectionStates } from './connectionSummary';

describe('describeConnectionStates', () => {
  it('describes zero monitors', () => {
    expect(describeConnectionStates([])).toBe('No monitors paired');
  });

  it('describes one connected monitor', () => {
    expect(describeConnectionStates(['connected'])).toBe('Monitor connected');
  });

  it('describes all of several connected', () => {
    expect(describeConnectionStates(['connected', 'connected', 'connected'])).toBe('All 3 monitors connected');
  });

  it('describes a partial mix', () => {
    expect(describeConnectionStates(['connected', 'connecting', 'connected'])).toBe('2 of 3 connected');
  });

  it('describes none connected yet', () => {
    expect(describeConnectionStates(['connecting'])).toBe('Reconnecting…');
  });

  it('describes none of several connected', () => {
    expect(describeConnectionStates(['connecting', 'failed'])).toBe('Reconnecting to 2 monitors…');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/domain/connectionSummary.test.ts`
Expected: FAIL — `Cannot find module './connectionSummary'`.

- [ ] **Step 3: Implement**

Create `src/domain/connectionSummary.ts`:

```typescript
/**
 * Describes live per-monitor connection state for the persistent
 * foreground-service notification (see platform/foregroundService.ts) —
 * the notification already exists and is already persistent (`ongoing:
 * true`); this only changes its body text from a static "Watching N
 * monitors" count to something that reflects whether they're actually
 * reachable right now.
 */
export function describeConnectionStates(states: string[]): string {
  const total = states.length;
  if (total === 0) return 'No monitors paired';

  const connected = states.filter((s) => s === 'connected').length;

  if (connected === total) {
    return total === 1 ? 'Monitor connected' : `All ${total} monitors connected`;
  }
  if (connected === 0) {
    return total === 1 ? 'Reconnecting…' : `Reconnecting to ${total} monitors…`;
  }
  return `${connected} of ${total} connected`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/domain/connectionSummary.test.ts`
Expected: PASS — 6/6.

- [ ] **Step 5: Wire into `recomputeForegroundService`**

Add the import near the top:

```typescript
import { describeConnectionStates } from './domain/connectionSummary';
```

In `recomputeForegroundService`, replace:

```typescript
    const count = managed.length;
    startForegroundSession('Wewe', `Watching ${count} ${count === 1 ? 'monitor' : 'monitors'}`, types).catch(() => {});
```

with:

```typescript
    const body = describeConnectionStates(managed.map((m) => m.state.connectionState));
    startForegroundSession('Wewe', body, types).catch(() => {});
```

(The `managed.length === 0` early return above this, which calls `stopForegroundSession()` instead, already handles the case `describeConnectionStates([])` would otherwise need to cover here — that path never reaches this line. `describeConnectionStates([])`'s `'No monitors paired'` case is still tested directly in Step 1, since the function itself must handle it correctly regardless of how its one current caller happens to be guarded.)

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npx jest`
Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/domain/connectionSummary.ts src/domain/connectionSummary.test.ts src/ParentSessionsContext.tsx
git commit -m "feat(notification): reflect live connection state, not just a count"
```

---

## Task 6: Listen button — wire protocol

**Files:**
- Modify: `src/webrtc/peerConnectionHelpers.ts`
- Test: none — a type guard this thin (identical shape to the five existing ones in this file) has no branching logic worth a synthetic test beyond what Tasks 7-9's real usage already exercises.

**Interfaces:**
- Consumes: nothing new.
- Produces: `isListenRequestSignal(payload: unknown): payload is { listenRequest: boolean }` — consumed by Task 7 (`monitorSession.ts`) only. Task 9's `parentSession.ts` only ever *sends* a `listenRequest` signal, never receives one (the Listen feature is Parent→Monitor one-way; there's no Monitor→Parent acknowledgment), so it has no use for this type guard. `SignalPayload`'s union gains `| { listenRequest: boolean }`.

- [ ] **Step 1: Add the new signal variant and type guard**

In `src/webrtc/peerConnectionHelpers.ts`, find:

```typescript
export type SignalPayload =
  | { sdp: WireSdp }
  | { candidate: WireIceCandidate }
  | { rejected: true; reason: string }
  | { inviteMode: 'open' | 'closed' }
  | { inviteCode: string | null }
  | { monitorName: string }
  | { setMonitorName: string };
```

Replace with:

```typescript
export type SignalPayload =
  | { sdp: WireSdp }
  | { candidate: WireIceCandidate }
  | { rejected: true; reason: string }
  | { inviteMode: 'open' | 'closed' }
  | { inviteCode: string | null }
  | { monitorName: string }
  | { setMonitorName: string }
  | { listenRequest: boolean };
```

Add the type guard after `isSetMonitorNameSignal`:

```typescript
/** True iff `payload` is a Parent asking the Monitor to bypass its noise gate on demand (true = start, false = stop) — only honored by MonitorSession/firmware from an already-connected (thus already-authorized) sender, same as inviteMode/setMonitorName. */
export function isListenRequestSignal(payload: unknown): payload is { listenRequest: boolean } {
  return typeof payload === 'object' && payload !== null && 'listenRequest' in payload;
}
```

- [ ] **Step 2: Run the full suite**

Run: `npm run typecheck && npx jest`
Expected: typecheck clean, all tests pass (this task only adds new exports, doesn't change existing behavior).

- [ ] **Step 3: Commit**

```bash
git add src/webrtc/peerConnectionHelpers.ts
git commit -m "feat(webrtc): add listenRequest signal type"
```

---

## Task 7: Listen button — software Monitor handling

**Files:**
- Modify: `src/webrtc/monitorSession.ts`

**Interfaces:**
- Consumes: `isListenRequestSignal` (Task 6), the existing `setGateOpen(open: boolean)` method (already defined in this file), the existing `this.peers` map and its already-established "only an already-connected peer may act" guard pattern (see `isInviteModeSignal`'s handling in `handleSignal`).
- Produces: nothing new for later tasks — this is the software-Monitor-side terminus of the Listen feature.

- [ ] **Step 1: Write the failing test**

There's no existing test file for `monitorSession.ts` (same structural reason as `parentSession.ts` before this session added one — it imports `react-native-webrtc`, which can't load under the "logic" jest project's plain-node environment; see this session's `parentSession.test.ts` for the `jest.mock('react-native-webrtc', ...)` pattern this step reuses).

Create `src/webrtc/monitorSession.test.ts`:

```typescript
/**
 * react-native-webrtc ships ESM the "logic" jest project's plain node
 * environment can't load — mocked wholesale, same pattern as
 * parentSession.test.ts.
 */
class MockPeerConnection {
  connectionState = 'new';
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  localTracks: { enabled: boolean }[] = [];

  async setRemoteDescription(): Promise<void> {}
  async setLocalDescription(): Promise<void> {}
  async createAnswer(): Promise<{ sdp: string; type: string }> {
    return { sdp: 'fake-answer-sdp', type: 'answer' };
  }
  async createOffer(): Promise<{ sdp: string; type: string }> {
    return { sdp: 'fake-offer-sdp', type: 'offer' };
  }
  async addIceCandidate(): Promise<void> {}
  addTrack(): void {}
  close(): void {}
}

const mockPeerConnectionInstances: MockPeerConnection[] = [];
const mockTracks: { enabled: boolean }[] = [];

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn().mockImplementation(() => {
    const pc = new MockPeerConnection();
    mockPeerConnectionInstances.push(pc);
    return pc;
  }),
  RTCIceCandidate: jest.fn().mockImplementation((init: unknown) => init),
  RTCSessionDescription: jest.fn().mockImplementation((init: unknown) => init),
  mediaDevices: {
    getUserMedia: jest.fn().mockImplementation(() => {
      const track = { enabled: true };
      mockTracks.push(track);
      return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] });
    }),
  },
}));

// eslint-disable-next-line import/first -- must follow jest.mock('react-native-webrtc', ...) above
import { MonitorSession } from './monitorSession';
import type { Store } from '../domain/store';

function fakeStore(): Store {
  return {
    isListenerAuthorized: jest.fn().mockResolvedValue(true),
    authorizeListener: jest.fn().mockResolvedValue(undefined),
  } as unknown as Store;
}

/** Reaches the private handleSignal — same TS-privacy-is-compile-time-only seam parentSession.test.ts uses. */
function handleSignal(session: MonitorSession, payload: unknown, from: string): Promise<void> {
  return (session as unknown as { handleSignal(payload: unknown, from: string | undefined): Promise<void> }).handleSignal(payload, from);
}

describe('MonitorSession — listenRequest', () => {
  beforeEach(() => {
    mockPeerConnectionInstances.length = 0;
    mockTracks.length = 0;
  });

  it('opens the gate for an already-connected listener on listenRequest: true, and closes it again on false', async () => {
    const session = new MonitorSession({ signalingUrl: 'wss://example.invalid' }, fakeStore());
    await (session as unknown as { start(): Promise<void> }).start();
    // Simulate the peer already being an accepted, connected listener.
    await (session as unknown as { handlePeerJoined(id: string): Promise<void> }).handlePeerJoined('device-1');
    for (const track of mockTracks) track.enabled = false; // simulate the gate currently closed (quiet room)

    await handleSignal(session, { listenRequest: true }, 'device-1');
    expect(mockTracks.every((t) => t.enabled)).toBe(true);

    await handleSignal(session, { listenRequest: false }, 'device-1');
    expect(mockTracks.every((t) => !t.enabled)).toBe(true);
  });

  it('ignores a listenRequest from a device that is not an already-connected listener', async () => {
    const session = new MonitorSession({ signalingUrl: 'wss://example.invalid' }, fakeStore());
    await (session as unknown as { start(): Promise<void> }).start();
    for (const track of mockTracks) track.enabled = false;

    await handleSignal(session, { listenRequest: true }, 'unknown-device');
    expect(mockTracks.every((t) => !t.enabled)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/webrtc/monitorSession.test.ts`
Expected: FAIL — `handleSignal` doesn't recognize `listenRequest`, so `setGateOpen` never gets called; the first test's assertions fail.

- [ ] **Step 3: Implement**

In `src/webrtc/monitorSession.ts`, add `isListenRequestSignal` to the import from `./peerConnectionHelpers`:

```typescript
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteModeSignal,
  isListenRequestSignal,
  isMonitorNameSignal,
  isSdpSignal,
  isSetMonitorNameSignal,
} from './peerConnectionHelpers';
```

In `handleSignal`, add a new branch right after the existing `isInviteModeSignal` block (same "already-connected" guard pattern):

```typescript
    if (isListenRequestSignal(payload)) {
      // Only an already-connected (and therefore already-authorized) peer
      // may request Listen — same guard as inviteMode above. The gate is
      // shared across every connected listener (one localStream, added to
      // every RTCPeerConnection — see setupPeerConnection), so this opens
      // audio for everyone currently connected, not just the requester;
      // see the alerts/listen design spec's Global Constraints.
      if (!this.peers.has(from)) return;
      this.setGateOpen(payload.listenRequest);
      return;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/webrtc/monitorSession.test.ts`
Expected: PASS — 2/2.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npx jest`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/webrtc/monitorSession.ts src/webrtc/monitorSession.test.ts
git commit -m "feat(webrtc): handle listenRequest on the software Monitor"
```

---

## Task 8: Listen button — ESP32 firmware

**Files:**
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_monitor.h`
- Modify: `firmware/wewe_monitor/wewe_monitor/wewe_monitor.cpp`

**Interfaces:**
- Consumes: nothing new from earlier tasks in this plan (firmware and app are independent binaries talking JSON over the wire — the `"listenRequest"` field name must match Task 6's `listenRequest` exactly, which it does by construction below).
- Produces: nothing consumed by later tasks in this plan.

No host-runnable test exists for this logic (timing- and hardware-dependent, same as this session's earlier keepalive fix) — verified by real `esphome compile`/`config` and real hardware in Task 10, per this plan's Global Constraints.

- [ ] **Step 1: Add the override state to `RuntimeState`**

In `wewe_monitor.cpp`, find `RuntimeState`'s `last_keepalive_ms` field (added earlier this session) and add two new fields right after it:

```cpp
  // Real, reproduced on hardware: the WebRTC transport (ICE/DTLS) dies on
  // its own after ~85-91s of zero outbound traffic while the noise gate
  // stays closed (a quiet room) — confirmed via boot-log evidence showing
  // no ICE agent activity at all (no periodic STUN binding requests) in
  // the gap before "agent disconnected done" fires, so esp_peer's own
  // keepalive doesn't run once connected. 0 = no keepalive sent yet this
  // session; audio_send_task seeds it to the connect time on first use.
  int64_t last_keepalive_ms = 0;

  // A Parent's manual "Listen" request bypassing the gate — see
  // on_signal's listenRequest handling. Global, not per-listener: the mic
  // feed is shared across every connected listener already (see
  // audio_send_task), so one Parent's Listen request opens audio for
  // everyone currently connected. 60s safety-net timeout so a dropped
  // connection or a missed "stop" never leaves the gate stuck open.
  bool listen_override = false;
  int64_t listen_override_expires_at_ms = 0;
```

- [ ] **Step 2: Add the timeout constant**

Find `KEEPALIVE_INTERVAL_MS` (added earlier this session) and add alongside it:

```cpp
// Safety-net timeout for a Listen request — matches INVITE_WINDOW_MS's
// existing 60s pattern in this file.
constexpr int64_t LISTEN_OVERRIDE_TIMEOUT_MS = 60 * 1000;
```

- [ ] **Step 3: Fold the override into the send-decision**

Find `audio_send_task`'s gate check:

```cpp
    bool open = noise_gate_push(&g_state.gate, level_db, now_ms);
```

Replace with:

```cpp
    bool listen_override_active = g_state.listen_override && now_ms < g_state.listen_override_expires_at_ms;
    if (g_state.listen_override && !listen_override_active) {
      g_state.listen_override = false;  // safety-net timeout elapsed
    }
    bool open = noise_gate_push(&g_state.gate, level_db, now_ms) || listen_override_active;
```

- [ ] **Step 4: Handle the incoming signal**

In `on_signal`, find the existing `inviteMode` block:

```cpp
void on_signal(const char *from, cJSON *payload, void *ctx) {
  cJSON *invite_mode = cJSON_GetObjectItem(payload, "inviteMode");
  if (cJSON_IsString(invite_mode)) {
```

Add a new block immediately before it (same file, same function — `listenRequest` is checked first since it's a boolean field, distinct from `inviteMode`'s string field, so order between the two blocks doesn't matter functionally, but matching this file's existing top-to-bottom ordering convention of "app-level signals before SDP/candidate" keeps it consistent):

```cpp
void on_signal(const char *from, cJSON *payload, void *ctx) {
  cJSON *listen_request = cJSON_GetObjectItem(payload, "listenRequest");
  if (cJSON_IsBool(listen_request)) {
    // Only an already-connected (and therefore already-authorized) peer
    // may request Listen — same guard as inviteMode below.
    if (find_listener(from) == nullptr) {
      return;
    }
    if (cJSON_IsTrue(listen_request)) {
      g_state.listen_override = true;
      g_state.listen_override_expires_at_ms = esp_timer_get_time() / 1000 + LISTEN_OVERRIDE_TIMEOUT_MS;
    } else {
      g_state.listen_override = false;
    }
    return;
  }

  cJSON *invite_mode = cJSON_GetObjectItem(payload, "inviteMode");
  if (cJSON_IsString(invite_mode)) {
```

(Leave the rest of `on_signal` — the `inviteMode`/`sdp`/`candidate` handling below it — unchanged.)

- [ ] **Step 5: Verify it compiles**

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
esphome compile spike.yaml > /tmp/wewe_listen_compile.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_listen_compile.log
grep COMPILE_EXIT /tmp/wewe_listen_compile.log
```

Expected: `COMPILE_EXIT=0`.

- [ ] **Step 6: Commit**

```bash
cd /home/grant/sync/Code/wewe
git add firmware/wewe_monitor/wewe_monitor/wewe_monitor.cpp
git commit -m "feat(wewe_monitor): handle listenRequest, bypassing the gate with a 60s safety net"
```

---

## Task 9: Listen button — app-side signaling + UI

**Files:**
- Modify: `src/webrtc/parentSession.ts`
- Modify: `src/ParentSessionsContext.tsx`
- Modify: `src/screens/Parent.tsx`
- Test: `src/webrtc/parentSession.test.ts` (extends the existing file)

**Interfaces:**
- Consumes: Task 6's `SignalPayload`'s `{ listenRequest: boolean }` variant.
- Produces: `ParentSession.setListenRequest(listening: boolean): void`; `ParentSessionsValue.setListening(monitorId: string, listening: boolean): void`; `ParentSessionState.listening: boolean`. Nothing later in this plan consumes these — this is the plan's final consumer-facing piece.

- [ ] **Step 1: Write the failing test**

In `src/webrtc/parentSession.test.ts` (the file this session already created earlier today), add a new `describe` block after the existing one:

```typescript
describe('ParentSession — setListenRequest', () => {
  it('sends a listenRequest signal over the signaling channel', async () => {
    const session = new ParentSession({ signalingUrl: 'wss://example.invalid', room: 'room-1', deviceId: 'device-1' });
    const sendSignalSpy = jest.spyOn(
      (session as unknown as { signaling: { sendSignal: (payload: unknown) => void } }).signaling,
      'sendSignal',
    );

    session.setListenRequest(true);

    expect(sendSignalSpy).toHaveBeenCalledWith({ listenRequest: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/webrtc/parentSession.test.ts`
Expected: FAIL — `session.setListenRequest is not a function`.

- [ ] **Step 3: Implement `ParentSession.setListenRequest`**

In `src/webrtc/parentSession.ts`, add a new public method right after `setInviteMode`:

```typescript
  /** Asks the Monitor to bypass its noise gate on this Parent's behalf (true = start listening, false = stop) — only honored if the Monitor still considers this deviceId connected (see MonitorSession.handleSignal / wewe_monitor.cpp's on_signal). */
  setListenRequest(listening: boolean): void {
    this.signaling.sendSignal({ listenRequest: listening });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/webrtc/parentSession.test.ts`
Expected: PASS — 2/2 (the existing test from earlier this session, plus this new one).

- [ ] **Step 5: Wire into `ParentSessionsContext.tsx`**

Add `listening: boolean` to `ParentSessionState`:

```typescript
  /** The Monitor's current display name, or null until its first `monitorName` signal arrives. */
  monitorName: string | null;
  /** True while this Parent has an active Listen request open (see Parent.tsx's Listen button). Local UI state only — not echoed back by the Monitor, same as `invitingListener`/`talking`. */
  listening: boolean;
```

Add `setListening` to `ParentSessionsValue`:

```typescript
  setInviteMode: (monitorId: string, open: boolean) => void;
  setListening: (monitorId: string, listening: boolean) => void;
  renameMonitor: (monitorId: string, label: string) => void;
```

Initialize `listening: false` in `startSession`'s `state` object literal, alongside `invitingListener: false,`:

```typescript
          invitingListener: false,
          listening: false,
```

Add a `setListening` callback, mirroring `setInviteMode` exactly, right after it:

```typescript
  const setListening = React.useCallback(
    (monitorId: string, listening: boolean): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      managed.session.setListenRequest(listening);
      managed.state = { ...managed.state, listening };
      rerender();
    },
    [rerender],
  );
```

Add it to the `value` memo's returned object and dependency array:

```typescript
    return {
      states,
      getSession: (monitorId) => managedRef.current.get(monitorId)?.session,
      startTalking,
      stopTalking,
      setInviteMode,
      setListening,
      renameMonitor,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, startTalking, stopTalking, setInviteMode, setListening, renameMonitor]);
```

Also send `listenRequest: false` when a session stops, as routine hygiene (the firmware's 60s timeout is the real backstop, but this covers a clean app close/monitor-removal promptly). In `stopSession`, before `managed.session.stop();`:

```typescript
      if (managed.state.listening) managed.session.setListenRequest(false);
      managed.session.stop();
```

- [ ] **Step 6: Add the Listen button to `Parent.tsx`**

In `src/screens/Parent.tsx`, destructure `setListening` alongside the existing context values:

```typescript
  const { states, getSession, startTalking, stopTalking, setInviteMode, setListening, renameMonitor } = useParentSessions();
```

Add the button after the existing "Invite a listener" `Button`, before the invite-code `Surface`:

```tsx
      <Button
        mode={state.listening ? 'contained' : 'outlined'}
        icon="ear-hearing"
        onPress={() => setListening(monitorId, !state.listening)}
        style={styles.secondaryButton}
        contentStyle={styles.secondaryButtonContent}
      >
        {state.listening ? 'Stop listening' : 'Listen now'}
      </Button>
```

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npx jest`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/webrtc/parentSession.ts src/webrtc/parentSession.test.ts src/ParentSessionsContext.tsx src/screens/Parent.tsx
git commit -m "feat(parent): add Listen button, wired through to the Monitor's gate override"
```

---

## Task 10: Final validation — real device

**Files:** none (validation only).

**Interfaces:**
- Consumes: the complete feature set from Tasks 1-9.
- Produces: nothing — pass/fail confirmation, same shape as this session's earlier `wewe_monitor` library plan's Task 6.

- [ ] **Step 1: Full app suite**

```bash
cd /home/grant/sync/Code/wewe
npm run check
```

Expected: typecheck clean, all tests pass (every test added in Tasks 1-9, plus the pre-existing suite).

- [ ] **Step 2: Clean firmware rebuild**

```bash
cd /home/grant/sync/Code/wewe/firmware/core2-spike
rm -rf .esphome/build
esphome compile spike.yaml > /tmp/wewe_alerts_task10_compile.log 2>&1
echo "COMPILE_EXIT=$?" >> /tmp/wewe_alerts_task10_compile.log
grep COMPILE_EXIT /tmp/wewe_alerts_task10_compile.log
esphome upload --device /dev/ttyUSB0 spike.yaml > /tmp/wewe_alerts_task10_upload.log 2>&1
echo "UPLOAD_EXIT=$?" >> /tmp/wewe_alerts_task10_upload.log
grep UPLOAD_EXIT /tmp/wewe_alerts_task10_upload.log
```

Expected: both exit 0.

- [ ] **Step 3: Real-device checks — requires a human with the paired phone**

This step needs the actual app running on a phone, real cry-equivalent noise, and the real Monitor — a subagent without phone/adb access cannot complete it. If executing this plan without that access, stop here and report Steps 1-2's results; ask a human to:

1. Reload the app so Tasks 1-9's JS changes are live.
2. In Settings, confirm both new toggles show on by default, and "Test alert sound" plays the beep.
3. Make a sustained loud noise near the Monitor (a real cry substitute). Confirm: one beep, not a repeated stream of beeps while the noise continues; the beep stops recurring until the room goes quiet and a new loud sound starts.
4. Turn the cry-beep toggle off, repeat the loud noise, confirm no beep (but the existing vibration/notification still fires — this plan didn't touch that path).
5. Power off the Monitor (or disconnect its WiFi). Confirm: no beep for the first ~15s, then a beep, then another beep roughly 15s after that, repeating, until the Monitor comes back — not one instant beep.
6. Reconnect the Monitor. Confirm the repeating beep stops.
7. Tap "Listen now" while the room is quiet. Confirm audio becomes audible within a few seconds despite no cry. Tap "Stop listening" (or wait ~60s). Confirm audio stops again (the room being quiet).
8. Check the Android notification shade: confirm the persistent Wewe notification's text reflects connection state (e.g. "Monitor connected"), not just a monitor count.

- [ ] **Step 4: Final commit (if Step 3 surfaced a real regression requiring a code change)**

Only needed if Step 3 surfaced a real regression — if Steps 1-3 all pass cleanly with no changes needed, there's nothing to commit here; the plan is complete as of Task 9's commit.
