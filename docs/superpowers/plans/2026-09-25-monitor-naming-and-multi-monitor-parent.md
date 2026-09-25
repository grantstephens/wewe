# Monitor Naming + Simultaneous Multi-Monitor Parent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Monitor an auto-generated, bidirectionally-editable name
(adjective-animal, e.g. "raring-rabbit") that stays in sync between the Monitor
and every connected Parent; and let a Parent listen to every paired monitor
simultaneously — live, mixed audio from all of them at once — instead of one
at a time, by moving session ownership out of the per-screen `Parent.tsx` into
an app-lifetime provider.

**Architecture:** Naming rides entirely over the existing opaque `signal`
channel (two new payload shapes, no relay change). Multi-monitor support
introduces one new file, `src/ParentSessionsContext.tsx`, that owns one
`ParentSession` per paired monitor for the app's whole lifetime, the single
shared foreground-service notification, and centralized cry-alert polling —
`Home.tsx` becomes a live status dashboard reading this shared state,
`Parent.tsx` becomes a detail view over it.

**Tech Stack:** Same as the rest of the project — TypeScript, React Native,
`react-native-webrtc`, Jest (`jest-expo` for screens — see Task 8's note on a
real, reproduced native-import gotcha this plan runs into for the first time).

**Spec:** [`docs/superpowers/specs/2026-09-25-monitor-naming-and-multi-monitor-parent-design.md`](../specs/2026-09-25-monitor-naming-and-multi-monitor-parent-design.md)

## Global Constraints

- No relay (`signal-server`) changes at all — naming is entirely application-level.
- No cap on simultaneous monitors; no artificial limit introduced.
- Cry/noise alerts and the activity log stay scoped per-monitor — never
  attributed across monitors.
- The foreground-service notification is a single, shared, always-fully-recomputed
  resource (never an incremental type addition) — see Task 6's doc comment for
  why this is non-negotiable (two prior real-device crashes from getting this
  piecemeal, per `AGENTS.md`).
- No data migration: `monitorName` is a new setting with a generated default;
  existing `PairedMonitor.label` values are untouched until the next rename
  from either side.

## Review Focus

- **A rename arriving from a Parent while the Monitor's own screen is also
  open and mid-edit** — the Monitor's own `renameSelf` call and an incoming
  `setMonitorName` signal both funnel through the exact same code path, so
  whichever lands second simply wins (last-write-wins) rather than the two
  disagreeing. Task 3 pins this by routing both origins through one method.
- **A newly-created session's state being read before its first
  `onConnectionStateChange` fires** — `Home.tsx`/`Parent.tsx` must render a
  sane "not yet connected" state for a monitor whose session was only just
  constructed, not crash on a missing map entry. Task 8/9 pin this.
- **Removing a monitor while its session is mid-connect** — `stopSession` must
  tear down the underlying `ParentSession` and recompute the foreground
  service even if that session never reached `'connected'`. Task 6 pins this
  (the revision-diff loop doesn't check connection state before stopping).
- **Two sessions racing to update the shared foreground-service type list at
  once** (e.g., starting to talk on Monitor A while Monitor B's connection
  state is also changing) — every mutation recomputes the *complete* type set
  from the current state of every managed session, never an incremental
  patch. Task 6 pins this structurally (one `recomputeForegroundService`
  function, called after every state change that could affect it).
- **`Home.test.tsx` transitively importing `react-native-webrtc`** once
  `Home.tsx` depends on the new provider — reproduced directly while writing
  this plan (a bare `import { RTCPeerConnection } from 'react-native-webrtc'`
  throws `Invariant Violation: new NativeEventEmitter() requires a non-null
  argument` under `jest-expo`, at import time, before any test body runs).
  Task 8 pins this by mocking `ParentSessionsContext` itself, not the native
  module — `Home.tsx`'s own logic is what's under test, not session behavior.

---

## Task 1: `src/domain/monitorName.ts` — generation + persistence

**Files:**
- Create: `src/domain/monitorName.ts`
- Create: `src/domain/monitorName.test.ts`
- Modify: `src/domain/store.ts`

**Interfaces:**
- Produces: `generateMonitorName(randomInt?): string`,
  `getOrCreateMonitorName(store): Promise<string>`,
  `setMonitorName(store, name): Promise<void>`, `SETTINGS_KEYS.monitorName`.
  Consumed by Task 3 (`MonitorSession`).

- [ ] **Step 1: Write the failing tests**

Create `src/domain/monitorName.test.ts`:

```ts
import { generateMonitorName, getOrCreateMonitorName, setMonitorName } from './monitorName';
import { SETTINGS_KEYS, type Store } from './store';

function fakeStore(initial: Record<string, string> = {}): Store {
  const settings = new Map(Object.entries(initial));
  return {
    addMonitor: async () => {},
    monitors: async () => [],
    removeMonitor: async () => {},
    appendEvent: async () => {},
    events: async () => [],
    getSetting: async (key) => settings.get(key) ?? null,
    setSetting: async (key, value) => {
      settings.set(key, value);
    },
    isListenerAuthorized: async () => false,
    authorizeListener: async () => {},
    close: async () => {},
  };
}

describe('generateMonitorName', () => {
  test('produces an adjective-animal name using the injected RNG', () => {
    // 0 picks the first adjective and first animal from each list.
    const name = generateMonitorName(() => 0);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  test('is deterministic under an injected RNG', () => {
    const name1 = generateMonitorName(() => 0);
    const name2 = generateMonitorName(() => 0);
    expect(name1).toBe(name2);
  });

  test('varies with a different injected value', () => {
    const first = generateMonitorName(() => 0);
    const second = generateMonitorName((maxExclusive) => maxExclusive - 1);
    expect(first).not.toBe(second);
  });
});

describe('getOrCreateMonitorName', () => {
  test('generates and persists one on first use', async () => {
    const store = fakeStore();
    const name = await getOrCreateMonitorName(store);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    await expect(store.getSetting(SETTINGS_KEYS.monitorName)).resolves.toBe(name);
  });

  test('returns the same name on every subsequent call', async () => {
    const store = fakeStore();
    const first = await getOrCreateMonitorName(store);
    const second = await getOrCreateMonitorName(store);
    expect(second).toBe(first);
  });

  test('returns an already-persisted name without generating a new one', async () => {
    const store = fakeStore({ [SETTINGS_KEYS.monitorName]: 'existing-name' });
    await expect(getOrCreateMonitorName(store)).resolves.toBe('existing-name');
  });
});

describe('setMonitorName', () => {
  test('persists a name, overwriting whatever was there before', async () => {
    const store = fakeStore({ [SETTINGS_KEYS.monitorName]: 'old-name' });
    await setMonitorName(store, 'new-name');
    await expect(store.getSetting(SETTINGS_KEYS.monitorName)).resolves.toBe('new-name');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest src/domain/monitorName.test.ts
```
Expected: FAIL — `Cannot find module './monitorName'` (the file doesn't exist
yet), and `SETTINGS_KEYS.monitorName` doesn't exist on `store.ts`'s exported
object yet either.

- [ ] **Step 3: Add `SETTINGS_KEYS.monitorName`**

In `src/domain/store.ts`, replace:
```ts
export const SETTINGS_KEYS = {
  signalingServerUrl: 'signalingServerUrl',
  noiseGateSensitivity: 'noiseGateSensitivity',
  deviceId: 'deviceId',
  /** This install's persistent, never-displayed relay room id when acting as a Monitor — see `getOrCreateMonitorRoomId`. */
  monitorRoomId: 'monitorRoomId',
} as const;
```
with:
```ts
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

- [ ] **Step 4: Create `monitorName.ts`**

```ts
import { SETTINGS_KEYS, type Store } from './store';

/**
 * A deliberately small, hand-picked wordlist — every combination reads as a
 * harmless, cozy label (this is a baby monitor's default name, potentially
 * shown to a stranger who scans a QR code during an invite window), never
 * anything alarming or ambiguous. 40x40 = 1,600 combinations, plenty for
 * telling monitors on a dashboard apart without ever needing to be
 * unguessable — unlike `monitorRoomId`, this name is never a secret.
 */
const ADJECTIVES = [
  'quiet', 'gentle', 'cozy', 'sleepy', 'happy', 'curious', 'playful', 'bright',
  'calm', 'tiny', 'brave', 'cheerful', 'drowsy', 'fuzzy', 'giggly', 'humble',
  'jolly', 'kind', 'lively', 'merry', 'nimble', 'perky', 'quirky', 'radiant',
  'silly', 'snug', 'sunny', 'sweet', 'tidy', 'vivid', 'witty', 'zesty',
  'breezy', 'chirpy', 'dandy', 'eager', 'fluffy', 'glowing', 'hushed', 'mellow',
] as const;

const ANIMALS = [
  'rabbit', 'otter', 'panda', 'koala', 'fox', 'owl', 'deer', 'lamb', 'duck',
  'mouse', 'bear', 'hedgehog', 'squirrel', 'sparrow', 'kitten', 'puppy',
  'seal', 'dolphin', 'penguin', 'raccoon', 'badger', 'beaver', 'chipmunk',
  'robin', 'finch', 'wren', 'lynx', 'moose', 'elk', 'hare', 'gecko', 'turtle',
  'swan', 'heron', 'crane', 'dove', 'lark', 'wombat', 'quokka', 'alpaca',
] as const;

/** Uniform integer in [0, maxExclusive), using the platform's default RNG — same injection pattern as pairing.ts's generatePairingCode. */
function defaultRandomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/** Generates a fresh "adjective-animal" display name, e.g. "raring-rabbit". Not unique, not a secret — purely for telling monitors apart at a glance. */
export function generateMonitorName(randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const animal = ANIMALS[randomInt(ANIMALS.length)];
  return `${adjective}-${animal}`;
}

/** Returns this Monitor install's current display name, generating and persisting one on first use. */
export async function getOrCreateMonitorName(store: Store): Promise<string> {
  const existing = await store.getSetting(SETTINGS_KEYS.monitorName);
  if (existing) return existing;
  const name = generateMonitorName();
  await store.setSetting(SETTINGS_KEYS.monitorName, name);
  return name;
}

/** Persists a new display name, overwriting whatever was there before — called on an explicit rename, from either the Monitor's own screen or an authorized Parent's request (see MonitorSession.renameSelf). */
export async function setMonitorName(store: Store, name: string): Promise<void> {
  await store.setSetting(SETTINGS_KEYS.monitorName, name);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx jest src/domain/monitorName.test.ts
```
Expected: PASS, all 7 tests.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/domain/monitorName.ts src/domain/monitorName.test.ts src/domain/store.ts
git commit -m "domain: add auto-generated, persistent monitor display names

generateMonitorName produces an adjective-animal name (e.g.
raring-rabbit) from a small hand-picked wordlist — never a secret,
purely for telling monitors apart. getOrCreateMonitorName/
setMonitorName mirror the deviceId.ts store-backed pattern."
```

---

## Task 2: `peerConnectionHelpers` — naming signal payloads

**Files:**
- Modify: `src/webrtc/peerConnectionHelpers.ts`

**Interfaces:**
- Produces: `SignalPayload` gains `{ monitorName: string } | { setMonitorName:
  string }`, `isMonitorNameSignal`, `isSetMonitorNameSignal`. Consumed by Task 3
  (`MonitorSession`, both directions) and Task 5 (`ParentSession`, receiving
  `monitorName`).

- [ ] **Step 1: Extend the payload union and add the guards**

Replace:
```ts
export type SignalPayload =
  | { sdp: WireSdp }
  | { candidate: WireIceCandidate }
  | { rejected: true; reason: string }
  | { inviteMode: 'open' | 'closed' }
  | { inviteCode: string | null };
```
with:
```ts
export type SignalPayload =
  | { sdp: WireSdp }
  | { candidate: WireIceCandidate }
  | { rejected: true; reason: string }
  | { inviteMode: 'open' | 'closed' }
  | { inviteCode: string | null }
  | { monitorName: string }
  | { setMonitorName: string };
```

Add, after `isInviteCodeSignal`:
```ts

/** True iff `payload` is the Monitor telling a Parent its current display name — sent to every connected peer on accept, and re-broadcast to all of them whenever it changes. */
export function isMonitorNameSignal(payload: unknown): payload is { monitorName: string } {
  return typeof payload === 'object' && payload !== null && 'monitorName' in payload;
}

/** True iff `payload` is an already-connected Parent asking the Monitor to rename itself — honored only from a peer the Monitor already has a live RTCPeerConnection for. */
export function isSetMonitorNameSignal(payload: unknown): payload is { setMonitorName: string } {
  return typeof payload === 'object' && payload !== null && 'setMonitorName' in payload;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors — this file has no dedicated test suite, same posture as
its existing guards.

- [ ] **Step 3: Commit**

```bash
git add src/webrtc/peerConnectionHelpers.ts
git commit -m "webrtc: add monitorName/setMonitorName signal payload shapes

Carries the Monitor's current display name to every connected Parent,
and a Parent's rename request back to the Monitor, over the existing
opaque signal channel - no relay changes needed."
```

---

## Task 3: `MonitorSession` — own, broadcast, and accept name changes

**Files:**
- Modify: `src/webrtc/monitorSession.ts`

**Interfaces:**
- Consumes: `getOrCreateMonitorName`/`setMonitorName` (Task 1),
  `isMonitorNameSignal`/`isSetMonitorNameSignal` (Task 2).
- Produces: `MonitorSession.renameSelf(name: string): void`,
  `MonitorSessionEvents.onMonitorNameChange?: (name: string) => void`.
  Consumed by Task 4 (`Monitor.tsx`).

No automated test for this file — same established posture as Task 5 of the
prior (ephemeral-rotating-pairing-codes) plan. Verified by typecheck plus the
manual multi-device test in Task 10.

- [ ] **Step 1: Update the import**

Replace:
```ts
import { getOrCreateMonitorRoomId } from '../domain/deviceId';
import { decideListener, InviteMode } from '../domain/inviteMode';
import { generatePairingCode } from '../domain/pairing';
```
with:
```ts
import { getOrCreateMonitorRoomId } from '../domain/deviceId';
import { decideListener, InviteMode } from '../domain/inviteMode';
import { getOrCreateMonitorName, setMonitorName } from '../domain/monitorName';
import { generatePairingCode } from '../domain/pairing';
```

- [ ] **Step 2: Add the new event**

Replace:
```ts
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure. */
  onError?: (message: string) => void;
}
```
with:
```ts
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure. */
  onError?: (message: string) => void;
  /** Fires once this Monitor's display name is first loaded, and again every time it changes (from this device's own screen or a connected Parent's rename request). */
  onMonitorNameChange?: (name: string) => void;
}
```

Replace the `isInviteModeSignal` import too. Replace:
```ts
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteModeSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
```
with:
```ts
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteModeSignal,
  isMonitorNameSignal,
  isSdpSignal,
  isSetMonitorNameSignal,
} from './peerConnectionHelpers';
```

- [ ] **Step 3: Add the `currentName` field and load it in `start()`**

Replace:
```ts
  private localStream: MediaStream | null = null;
  private currentCode: string | null = null;
  private codeExpiresAt: number | null = null;
  private inviteTimer: ReturnType<typeof setTimeout> | null = null;
```
with:
```ts
  private localStream: MediaStream | null = null;
  private currentCode: string | null = null;
  private codeExpiresAt: number | null = null;
  private inviteTimer: ReturnType<typeof setTimeout> | null = null;
  private currentName = '';
```

Replace:
```ts
  async start(): Promise<void> {
    this.localStream = (await mediaDevices.getUserMedia({ audio: true })) as MediaStream;
    const roomId = await getOrCreateMonitorRoomId(this.store);

    await this.signaling.connect(roomId, 'monitor', {
```
with:
```ts
  async start(): Promise<void> {
    this.localStream = (await mediaDevices.getUserMedia({ audio: true })) as MediaStream;
    const roomId = await getOrCreateMonitorRoomId(this.store);
    this.currentName = await getOrCreateMonitorName(this.store);
    this.events.onMonitorNameChange?.(this.currentName);

    await this.signaling.connect(roomId, 'monitor', {
```

- [ ] **Step 4: Add `renameSelf` and wire it into `handleSignal`**

Add, after `closeLocalInvite`:
```ts

  /** Renames this Monitor — from its own screen, or internally when handleSignal accepts an authorized peer's setMonitorName request. Persists and re-broadcasts to every currently-connected peer, so both origins produce identical, indistinguishable behavior. */
  renameSelf(name: string): void {
    this.currentName = name;
    setMonitorName(this.store, name).catch(() => {});
    this.events.onMonitorNameChange?.(name);
    for (const deviceId of this.peers.keys()) {
      this.signaling.sendSignal({ monitorName: name }, deviceId);
    }
  }
```

Replace:
```ts
  private async handleSignal(payload: unknown, from: string | undefined): Promise<void> {
    if (from === undefined) return;

    if (isInviteModeSignal(payload)) {
```
with:
```ts
  private async handleSignal(payload: unknown, from: string | undefined): Promise<void> {
    if (from === undefined) return;

    if (isSetMonitorNameSignal(payload)) {
      // Same "already-connected, thus already-authorized" guard as the
      // inviteMode signal below — a not-yet-accepted deviceId has no entry
      // in `peers` yet and can't rename a Monitor it was never let into.
      if (!this.peers.has(from)) return;
      this.renameSelf(payload.setMonitorName);
      return;
    }

    if (isInviteModeSignal(payload)) {
```

- [ ] **Step 5: Tell each newly-accepted peer the current name**

Replace:
```ts
  private async handlePeerJoined(deviceId: string): Promise<void> {
    const authorized = await this.store.isListenerAuthorized(deviceId);
    const decision = decideListener(authorized, this.inviteMode.isOpen);
    if (decision === 'reject') {
      this.signaling.sendSignal({ rejected: true, reason: 'not-authorized' }, deviceId);
      return;
    }
    if (decision === 'accept-new') {
      await this.store.authorizeListener(deviceId);
    }
    await this.createOfferFor(deviceId);
    this.events.onListenerCountChange?.(this.countConnected());
  }
```
with:
```ts
  private async handlePeerJoined(deviceId: string): Promise<void> {
    const authorized = await this.store.isListenerAuthorized(deviceId);
    const decision = decideListener(authorized, this.inviteMode.isOpen);
    if (decision === 'reject') {
      this.signaling.sendSignal({ rejected: true, reason: 'not-authorized' }, deviceId);
      return;
    }
    if (decision === 'accept-new') {
      await this.store.authorizeListener(deviceId);
    }
    this.signaling.sendSignal({ monitorName: this.currentName }, deviceId);
    await this.createOfferFor(deviceId);
    this.events.onListenerCountChange?.(this.countConnected());
  }
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: no errors — `monitorSession.ts` itself must be clean; no other file
references anything this task changed yet.

- [ ] **Step 7: Commit**

```bash
git add src/webrtc/monitorSession.ts
git commit -m "webrtc: MonitorSession owns its display name end to end

Loads/generates its name on start(), tells every newly-accepted peer
what it's currently called, and exposes renameSelf() - called both by
the Monitor's own screen and, internally, by an authorized peer's
setMonitorName request, so a rename from either origin goes through
the exact same persist-and-broadcast path and can never disagree."
```

---

## Task 4: `Monitor.tsx` — display and edit its own name

**Files:**
- Modify: `src/screens/Monitor.tsx`

**Interfaces:**
- Consumes: `MonitorSession.renameSelf`/`onMonitorNameChange` (Task 3).

- [ ] **Step 1: Add name state and the event handler**

Replace:
```ts
  const [inviteCode, setInviteCode] = React.useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = React.useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(null);
  const [reconnecting, setReconnecting] = React.useState<number | null>(null);
  const [gateOpen, setGateOpen] = React.useState(false);
```
with:
```ts
  const [inviteCode, setInviteCode] = React.useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = React.useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(null);
  const [reconnecting, setReconnecting] = React.useState<number | null>(null);
  const [gateOpen, setGateOpen] = React.useState(false);
  const [monitorName, setMonitorName] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState('');
```

Replace:
```ts
      {
        onListenerCountChange: setListenerCount,
        onInviteCodeChange: (code, expiresAt) => {
          setInviteCode(code);
          setInviteExpiresAt(expiresAt);
        },
        onSignalingReconnecting: (attempt) => setReconnecting(attempt),
        onSignalingReconnected: () => setReconnecting(null),
      },
```
with:
```ts
      {
        onListenerCountChange: setListenerCount,
        onInviteCodeChange: (code, expiresAt) => {
          setInviteCode(code);
          setInviteExpiresAt(expiresAt);
        },
        onMonitorNameChange: setMonitorName,
        onSignalingReconnecting: (attempt) => setReconnecting(attempt),
        onSignalingReconnected: () => setReconnecting(null),
      },
```

- [ ] **Step 2: Add the name row + rename dialog to the render**

Replace:
```ts
      <Text variant="titleLarge" style={styles.title}>
        This device is the monitor
      </Text>

      {listenerCount > 0 && (
```
with:
```ts
      <Text variant="titleLarge" style={styles.title}>
        This device is the monitor
      </Text>

      <View style={styles.nameRow}>
        <Text variant="titleMedium">{monitorName ?? '…'}</Text>
        <IconButton
          icon="pencil-outline"
          onPress={() => {
            setRenameDraft(monitorName ?? '');
            setRenaming(true);
          }}
        />
      </View>

      <Portal>
        <Dialog visible={renaming} onDismiss={() => setRenaming(false)}>
          <Dialog.Title>Rename this monitor</Dialog.Title>
          <Dialog.Content>
            <TextInput label="Name" value={renameDraft} onChangeText={setRenameDraft} autoFocus />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRenaming(false)}>Cancel</Button>
            <Button
              onPress={() => {
                const name = renameDraft.trim();
                if (name) sessionRef.current?.renameSelf(name);
                setRenaming(false);
              }}
              disabled={!renameDraft.trim()}
            >
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {listenerCount > 0 && (
```

- [ ] **Step 3: Add the new imports and the `nameRow` style**

Replace:
```ts
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ProgressBar, Text, useTheme } from 'react-native-paper';
```
with:
```ts
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Dialog, IconButton, Portal, ProgressBar, Text, TextInput, useTheme } from 'react-native-paper';
```

Replace:
```ts
  title: { marginBottom: 16, textAlign: 'center' },
  connectedBanner: { width: '100%', padding: 12, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
```
with:
```ts
  title: { marginBottom: 16, textAlign: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  connectedBanner: { width: '100%', padding: 12, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```
Expected: all existing tests pass (no `Monitor.test.tsx` exists today).

- [ ] **Step 6: Commit**

```bash
git add src/screens/Monitor.tsx
git commit -m "screens: Monitor displays and lets you edit its own name

A pencil icon next to the current auto-generated name opens the same
rename-dialog pattern Home.tsx already uses, calling
MonitorSession.renameSelf - broadcasts to every connected Parent."
```

---

## Task 5: `ParentSession` — receive and request name changes

**Files:**
- Modify: `src/webrtc/parentSession.ts`

**Interfaces:**
- Consumes: `isMonitorNameSignal` (Task 2).
- Produces: `ParentSessionEvents.onMonitorNameChanged?: (name: string) =>
  void`, `ParentSession.renameMonitor(name: string): void`. Consumed by Task 6
  (`ParentSessionsContext`).

No automated test for this file, same reason as Task 3. Verified by typecheck
plus the manual multi-device test in Task 10.

- [ ] **Step 1: Update the import and add the new event**

Replace:
```ts
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteCodeSignal,
  isRejectedSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
```
with:
```ts
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteCodeSignal,
  isMonitorNameSignal,
  isRejectedSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
```

Replace:
```ts
  /** Fires when the Monitor sends the currently-live pairing code after this Parent asked to invite a listener (see `setInviteMode`) — null means the invite window closed. */
  onInviteCode?: (code: string | null) => void;
}
```
with:
```ts
  /** Fires when the Monitor sends the currently-live pairing code after this Parent asked to invite a listener (see `setInviteMode`) — null means the invite window closed. */
  onInviteCode?: (code: string | null) => void;
  /** Fires once, as soon as the Monitor first tells this Parent its display name (right after being accepted), and again every time the Monitor's name changes — from its own screen or any connected Parent's rename request, this Parent's own included. */
  onMonitorNameChanged?: (name: string) => void;
}
```

- [ ] **Step 2: Add `renameMonitor` and wire the incoming signal**

Replace:
```ts
  /** Asks the Monitor to open or close invite mode on this Parent's behalf — only honored if the Monitor still considers this deviceId connected (see MonitorSession.handleSignal). */
  setInviteMode(open: boolean): void {
    this.signaling.sendSignal({ inviteMode: open ? 'open' : 'closed' });
  }
```
with:
```ts
  /** Asks the Monitor to open or close invite mode on this Parent's behalf — only honored if the Monitor still considers this deviceId connected (see MonitorSession.handleSignal). */
  setInviteMode(open: boolean): void {
    this.signaling.sendSignal({ inviteMode: open ? 'open' : 'closed' });
  }

  /** Asks the Monitor to rename itself — only honored if the Monitor still considers this deviceId connected. The confirmed new name arrives back via onMonitorNameChanged, same as any other rename (see MonitorSession.renameSelf). */
  renameMonitor(name: string): void {
    this.signaling.sendSignal({ setMonitorName: name });
  }
```

Replace:
```ts
    if (isInviteCodeSignal(payload)) {
      this.events.onInviteCode?.(payload.inviteCode);
      return;
    }
    const pc = this.pc ?? this.setupPeerConnection();
```
with:
```ts
    if (isInviteCodeSignal(payload)) {
      this.events.onInviteCode?.(payload.inviteCode);
      return;
    }
    if (isMonitorNameSignal(payload)) {
      this.events.onMonitorNameChanged?.(payload.monitorName);
      return;
    }
    const pc = this.pc ?? this.setupPeerConnection();
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors — `parentSession.ts` itself must be clean.

- [ ] **Step 4: Commit**

```bash
git add src/webrtc/parentSession.ts
git commit -m "webrtc: ParentSession receives and can request name changes

onMonitorNameChanged fires on the Monitor's initial greeting and every
later change; renameMonitor sends a rename request the Monitor treats
identically to renaming from its own screen."
```

---

## Task 6: `ParentSessionsContext` — app-lifetime session manager

**Files:**
- Create: `src/ParentSessionsContext.tsx`

**Interfaces:**
- Consumes: `ParentSession` (Task 5, new events/method), `useWewe` (existing
  `WeweContext`), `CryAlertClassifier`/`getOrCreateDeviceId`/`fireCryAlert`/
  `fireConnectionLostAlert`/`startForegroundSession`/`stopForegroundSession`
  (all existing, unchanged).
- Produces: `ParentSessionsProvider`, `useParentSessions()`,
  `ParentSessionState`, `ParentSessionsValue`. Consumed by Task 7 (`App.tsx`),
  Task 8 (`Home.tsx`), Task 9 (`Parent.tsx`).

No automated test for this file — it wraps `ParentSession`, itself untested
for the same native-module reason (see Task 8's note on why even *importing*
this file crashes under `jest-expo` without a mock at the consuming test's
boundary). Verified by typecheck plus the manual multi-device test in Task 10.

- [ ] **Step 1: Create `src/ParentSessionsContext.tsx`**

```tsx
import React from 'react';

import { CryAlertClassifier } from './domain/cryAlert';
import { getOrCreateDeviceId } from './domain/deviceId';
import type { ActivityEvent } from './domain/activityLog';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS, type PairedMonitor } from './domain/store';
import { formatTimestamp } from './domain/timestamp';
import { fireConnectionLostAlert, fireCryAlert } from './platform/alerts';
import { AndroidForegroundServiceType, startForegroundSession, stopForegroundSession } from './platform/foregroundService';
import { useWewe } from './WeweContext';
import { ParentSession } from './webrtc/parentSession';

/** How often to poll every active session's inbound audio level for CryAlertClassifier — same cadence Parent.tsx used to run this at per-screen. */
const LEVEL_POLL_MS = 500;

/** How long a session may go without ever reaching 'connected' before its connectTimedOut flag is set — see ParentSessionState's doc comment. Same value Parent.tsx used to watch for per-screen. */
const CONNECT_TIMEOUT_MS = 20_000;

function newEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Live, per-monitor state the dashboard (Home) and detail view (Parent) both read. */
export interface ParentSessionState {
  monitor: PairedMonitor;
  /** The relay URL this session actually connected through — needed to build a working invite QR/code (see Parent.tsx's "Invite a listener" flow); resolved once per app run, shared by every session. */
  relayUrl: string;
  connectionState: string;
  reconnecting: number | null;
  /** True once CONNECT_TIMEOUT_MS has elapsed since the most recent connection attempt started, and it still hasn't reached 'connected'. Resets whenever a fresh attempt starts (the initial connect, or the first reconnect attempt after having been connected before). */
  connectTimedOut: boolean;
  rejected: string | null;
  talking: boolean;
  invitingListener: boolean;
  inviteCode: string | null;
  /** The Monitor's current display name, or null until its first `monitorName` signal arrives. */
  monitorName: string | null;
}

export interface ParentSessionsValue {
  /** Every paired monitor's live state, keyed by PairedMonitor.id. A monitor with no entry yet has had its session requested but not constructed — render it as "not yet connected". */
  states: Map<string, ParentSessionState>;
  /** The underlying session, for the one action this provider doesn't wrap directly (setInviteMode). */
  getSession: (monitorId: string) => ParentSession | undefined;
  startTalking: (monitorId: string) => Promise<void>;
  stopTalking: (monitorId: string) => void;
  setInviteMode: (monitorId: string, open: boolean) => void;
  renameMonitor: (monitorId: string, label: string) => void;
}

const ParentSessionsReactContext = React.createContext<ParentSessionsValue | null>(null);

export function useParentSessions(): ParentSessionsValue {
  const value = React.useContext(ParentSessionsReactContext);
  if (value === null) {
    throw new Error('useParentSessions must be used inside a ParentSessionsProvider');
  }
  return value;
}

interface Managed {
  session: ParentSession;
  state: ParentSessionState;
  classifier: CryAlertClassifier;
  wasConnected: boolean;
  connectStartedAt: number;
}

/**
 * ParentSessionsProvider owns one ParentSession per paired monitor for the
 * app's whole lifetime — not tied to any screen being open. See
 * docs/superpowers/specs/2026-09-25-monitor-naming-and-multi-monitor-parent-design.md.
 * Mounted once in App.tsx, inside WeweProvider (it needs `store`).
 *
 * The single shared foreground-service notification
 * (`startForegroundSession`/`stopForegroundSession` display/update one
 * notification, never one per call — see `platform/foregroundService.ts`) is
 * entirely owned here: every state change that could affect its `types`
 * array recomputes the *complete* set from scratch (at least one session
 * active -> MEDIA_PLAYBACK, at least one session currently talking -> also
 * MICROPHONE) rather than adding to it incrementally, since notifee doesn't
 * merge types across calls — getting this piecemeal is the exact bug class
 * that crashed real devices twice already (see AGENTS.md). This is why
 * push-to-talk goes through this provider's startTalking/stopTalking instead
 * of a screen calling ParentSession or the foreground service directly.
 */
export function ParentSessionsProvider({ children }: { children: React.ReactNode }) {
  const { store, revision } = useWewe();
  const managedRef = React.useRef(new Map<string, Managed>());
  const deviceIdRef = React.useRef<string | null>(null);
  const relayUrlRef = React.useRef<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const rerender = React.useCallback(() => setTick((n) => n + 1), []);

  const recomputeForegroundService = React.useCallback(() => {
    const managed = [...managedRef.current.values()];
    if (managed.length === 0) {
      stopForegroundSession().catch(() => {});
      return;
    }
    const anyTalking = managed.some((m) => m.state.talking);
    const types = anyTalking
      ? [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK, AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE]
      : [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK];
    const count = managed.length;
    startForegroundSession('Wewe', `Watching ${count} ${count === 1 ? 'monitor' : 'monitors'}`, types).catch(() => {});
  }, []);

  const logEvent = React.useCallback(
    (monitorId: string, kind: ActivityEvent['kind'], detail?: string) => {
      const event: ActivityEvent = {
        id: newEventId(),
        monitorId,
        kind,
        occurredAt: formatTimestamp(new Date()),
        ...(detail ? { detail } : {}),
      };
      store.appendEvent(event).catch(() => {});
    },
    [store],
  );

  const startSession = React.useCallback(
    (monitor: PairedMonitor, deviceId: string, relayUrl: string): void => {
      const managed: Managed = {
        session: null as unknown as ParentSession,
        state: {
          monitor,
          relayUrl,
          connectionState: 'idle',
          reconnecting: null,
          connectTimedOut: false,
          rejected: null,
          talking: false,
          invitingListener: false,
          inviteCode: null,
          monitorName: null,
        },
        classifier: new CryAlertClassifier(),
        wasConnected: false,
        connectStartedAt: Date.now(),
      };

      const session = new ParentSession(
        { signalingUrl: relayUrl, room: monitor.roomId, deviceId },
        {
          onConnectionStateChange: (connectionState) => {
            managed.state = { ...managed.state, connectionState };
            if (connectionState === 'connected') {
              managed.state = { ...managed.state, connectTimedOut: false };
              managed.wasConnected = true;
            } else if ((connectionState === 'disconnected' || connectionState === 'failed') && managed.wasConnected) {
              managed.wasConnected = false;
              managed.connectStartedAt = Date.now();
              fireConnectionLostAlert(managed.state.monitor.label).catch(() => {});
              logEvent(managed.state.monitor.id, 'disconnected');
            }
            rerender();
          },
          onSignalingReconnecting: (attempt) => {
            managed.state = { ...managed.state, reconnecting: attempt };
            rerender();
          },
          onSignalingReconnected: () => {
            managed.state = { ...managed.state, reconnecting: null };
            rerender();
          },
          onError: () => {
            managed.state = { ...managed.state, connectionState: 'failed' };
            rerender();
          },
          onRejected: (reason) => {
            managed.state = { ...managed.state, rejected: reason };
            rerender();
          },
          onRoomResolved: (room) => {
            if (room !== managed.state.monitor.roomId) {
              const updated = { ...managed.state.monitor, roomId: room };
              managed.state = { ...managed.state, monitor: updated };
              store.addMonitor(updated).catch(() => {});
            }
          },
          onInviteCode: (code) => {
            managed.state = { ...managed.state, inviteCode: code };
            rerender();
          },
          onMonitorNameChanged: (name) => {
            managed.state = { ...managed.state, monitorName: name };
            if (name !== managed.state.monitor.label) {
              const updated = { ...managed.state.monitor, label: name };
              managed.state = { ...managed.state, monitor: updated };
              store.addMonitor(updated).catch(() => {});
            }
            rerender();
          },
        },
      );
      managed.session = session;
      managedRef.current.set(monitor.id, managed);
      session.start().catch(() => {
        managed.state = { ...managed.state, connectionState: 'failed' };
        rerender();
      });
      recomputeForegroundService();
      rerender();
    },
    [logEvent, recomputeForegroundService, rerender, store],
  );

  const stopSession = React.useCallback(
    (monitorId: string): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      managed.session.stop();
      managedRef.current.delete(monitorId);
      recomputeForegroundService();
      rerender();
    },
    [recomputeForegroundService, rerender],
  );

  // Initial setup: resolve the shared deviceId/relayUrl once, then start a session per paired monitor.
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([getOrCreateDeviceId(store), store.getSetting(SETTINGS_KEYS.signalingServerUrl)]).then(
      ([deviceId, relayUrlSetting]) => {
        if (cancelled) return;
        deviceIdRef.current = deviceId;
        relayUrlRef.current = relayUrlSetting || DEFAULT_SIGNALING_SERVER_URL;
        store.monitors().then((monitors) => {
          if (cancelled) return;
          for (const monitor of monitors) {
            startSession(monitor, deviceIdRef.current!, relayUrlRef.current!);
          }
        });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync whenever the paired-monitor list changes (pair/remove) — revision is WeweContext's existing "stored data changed" signal.
  React.useEffect(() => {
    if (deviceIdRef.current === null || relayUrlRef.current === null) return;
    let cancelled = false;
    store.monitors().then((monitors) => {
      if (cancelled) return;
      const currentIds = new Set(monitors.map((m) => m.id));
      for (const id of [...managedRef.current.keys()]) {
        if (!currentIds.has(id)) stopSession(id);
      }
      for (const monitor of monitors) {
        if (!managedRef.current.has(monitor.id)) {
          startSession(monitor, deviceIdRef.current!, relayUrlRef.current!);
        }
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  // Central cry-alert polling + connect-timeout watchdog, one interval for every active session.
  React.useEffect(() => {
    const interval = setInterval(() => {
      let changed = false;
      for (const managed of managedRef.current.values()) {
        managed.session.getRemoteAudioLevel().then((levelDb) => {
          if (levelDb == null) {
            managed.classifier.reset();
            return;
          }
          const shouldAlert = managed.classifier.push(levelDb, Date.now());
          if (shouldAlert) {
            fireCryAlert(managed.state.monitor.label).catch(() => {});
            logEvent(managed.state.monitor.id, 'cry_alert');
          }
        });
        if (managed.state.connectionState !== 'connected' && !managed.state.connectTimedOut) {
          if (Date.now() - managed.connectStartedAt > CONNECT_TIMEOUT_MS) {
            managed.state = { ...managed.state, connectTimedOut: true };
            changed = true;
          }
        }
      }
      if (changed) rerender();
    }, LEVEL_POLL_MS);
    return () => clearInterval(interval);
  }, [logEvent, rerender]);

  // Tear every session down when the provider itself unmounts (app close) — not on any screen's lifecycle.
  React.useEffect(() => {
    return () => {
      for (const managed of managedRef.current.values()) managed.session.stop();
      stopForegroundSession().catch(() => {});
    };
  }, []);

  const startTalking = React.useCallback(
    async (monitorId: string): Promise<void> => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      await managed.session.startTalking();
      managed.state = { ...managed.state, talking: true };
      recomputeForegroundService();
      rerender();
    },
    [recomputeForegroundService, rerender],
  );

  const stopTalking = React.useCallback(
    (monitorId: string): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      managed.session.stopTalking();
      managed.state = { ...managed.state, talking: false };
      recomputeForegroundService();
      rerender();
    },
    [recomputeForegroundService, rerender],
  );

  const setInviteMode = React.useCallback(
    (monitorId: string, open: boolean): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      managed.session.setInviteMode(open);
      managed.state = { ...managed.state, invitingListener: open, inviteCode: open ? managed.state.inviteCode : null };
      rerender();
    },
    [rerender],
  );

  const renameMonitor = React.useCallback(
    (monitorId: string, label: string): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      const updated = { ...managed.state.monitor, label };
      managed.state = { ...managed.state, monitor: updated, monitorName: label };
      store.addMonitor(updated).catch(() => {});
      managed.session.renameMonitor(label);
      rerender();
    },
    [store, rerender],
  );

  const value = React.useMemo<ParentSessionsValue>(() => {
    const states = new Map<string, ParentSessionState>();
    for (const [id, managed] of managedRef.current) states.set(id, managed.state);
    return {
      states,
      getSession: (monitorId) => managedRef.current.get(monitorId)?.session,
      startTalking,
      stopTalking,
      setInviteMode,
      renameMonitor,
    };
    // `tick` is read only to force this memo to recompute after an
    // in-place `managedRef.current` mutation elsewhere in this component —
    // it has no other use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, startTalking, stopTalking, setInviteMode, renameMonitor]);

  return <ParentSessionsReactContext.Provider value={value}>{children}</ParentSessionsReactContext.Provider>;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ParentSessionsContext.tsx
git commit -m "app: add ParentSessionsProvider, an app-lifetime session manager

Owns one ParentSession per paired monitor for the app's whole
lifetime, the single shared foreground-service notification
(recomputed in full on every relevant change, never patched
incrementally), and centralized cry-alert polling / connect-timeout
tracking - moving all of this out of the per-screen Parent.tsx so a
Parent can watch every paired monitor simultaneously."
```

---

## Task 7: `App.tsx` — mount the provider

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `ParentSessionsProvider` (Task 6).

- [ ] **Step 1: Wrap the navigator**

Replace:
```ts
import { WeweProvider } from './WeweContext';
```
with:
```ts
import { ParentSessionsProvider } from './ParentSessionsContext';
import { WeweProvider } from './WeweContext';
```

Replace:
```ts
          <WeweProvider store={store}>
            <NavigationContainer theme={navTheme}>
              <Stack.Navigator screenOptions={{ headerShown: true }}>
                <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Wewe' }} />
                <Stack.Screen name="Monitor" component={MonitorScreen} options={{ title: 'Monitor' }} />
                <Stack.Screen name="Parent" component={ParentScreen} options={{ title: 'Watching' }} />
                <Stack.Screen name="AddMonitor" component={AddMonitorScreen} options={{ title: 'Add a monitor' }} />
                <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
              </Stack.Navigator>
            </NavigationContainer>
          </WeweProvider>
```
with:
```ts
          <WeweProvider store={store}>
            <ParentSessionsProvider>
              <NavigationContainer theme={navTheme}>
                <Stack.Navigator screenOptions={{ headerShown: true }}>
                  <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Wewe' }} />
                  <Stack.Screen name="Monitor" component={MonitorScreen} options={{ title: 'Monitor' }} />
                  <Stack.Screen name="Parent" component={ParentScreen} options={{ title: 'Watching' }} />
                  <Stack.Screen name="AddMonitor" component={AddMonitorScreen} options={{ title: 'Add a monitor' }} />
                  <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
                </Stack.Navigator>
              </NavigationContainer>
            </ParentSessionsProvider>
          </WeweProvider>
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: errors appear in `src/screens/Home.tsx` and `src/screens/Parent.tsx`
— neither has been updated to the new session model yet (Tasks 8-9). No
errors in `App.tsx` itself.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "app: mount ParentSessionsProvider around the navigator

Inside WeweProvider (needs store) and outside the stack, so every
screen can read live multi-monitor session state."
```

---

## Task 8: `Home.tsx` — live status dashboard

**Files:**
- Modify: `src/screens/Home.tsx`
- Modify: `src/screens/Home.test.tsx`

**Interfaces:**
- Consumes: `useParentSessions`/`ParentSessionState` (Task 6).

**A real, reproduced gotcha this task runs into first:** `Home.tsx` will now
import `ParentSessionsContext.tsx`, which imports `ParentSession`, which
imports `react-native-webrtc` — and a bare `import { RTCPeerConnection } from
'react-native-webrtc'` throws `Invariant Violation: new NativeEventEmitter()
requires a non-null argument` under this project's `jest-expo` test
environment, at import time, before any test body runs (confirmed directly
while writing this plan — no mock exists for this package today, and none has
ever been needed since no other tested file transitively imported it). The
fix is **not** a global `react-native-webrtc` mock — it's mocking
`ParentSessionsContext` itself at the boundary `Home.tsx` actually depends on,
same idea as `deviceId.test.ts`'s hand-rolled `fakeStore()`: `Home.tsx`'s own
logic (list rendering, rename, remove, navigation) is what's under test, not
session behavior, which has no coverage anywhere in this project by
established convention.

- [ ] **Step 1: Rewrite the failing/updated test first**

Replace the whole `src/screens/Home.test.tsx` file:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import type { ParentSessionState, ParentSessionsValue } from '../ParentSessionsContext';
import type { Store } from '../domain/store';
import { openNodeSqlite } from '../storage/nodeSqlite';
import { SqliteStore } from '../storage/SqliteStore';
import { lightTheme } from '../theme';
import { WeweProvider } from '../WeweContext';
import { HomeScreen } from './Home';

// See this plan's Task 8 note: importing ParentSessionsContext (and
// transitively ParentSession -> react-native-webrtc) crashes at import time
// under jest-expo with no mock in place. Home.tsx's own logic is what's
// under test here, not session/WebRTC behavior — mocking at this boundary,
// the same one Home.tsx itself depends on, keeps that logic covered without
// ever needing a real (or globally faked) native module.
let mockSessionsValue: ParentSessionsValue;
jest.mock('../ParentSessionsContext', () => ({
  useParentSessions: () => mockSessionsValue,
}));

let store: Store;
beforeEach(async () => {
  store = await SqliteStore.open(openNodeSqlite(':memory:'));
  mockSessionsValue = {
    states: new Map(),
    getSession: () => undefined,
    startTalking: async () => {},
    stopTalking: () => {},
    setInviteMode: () => {},
    renameMonitor: jest.fn(),
  };
});
afterEach(async () => {
  await store.close();
});

function stateFor(overrides: Partial<ParentSessionState> & { monitor: ParentSessionState['monitor'] }): ParentSessionState {
  return {
    connectionState: 'idle',
    reconnecting: null,
    connectTimedOut: false,
    rejected: null,
    talking: false,
    invitingListener: false,
    inviteCode: null,
    monitorName: null,
    ...overrides,
  };
}

function renderHome(navigate: jest.Mock) {
  return render(
    <PaperProvider theme={lightTheme}>
      <WeweProvider store={store}>
        <HomeScreen
          navigation={{ navigate } as never}
          route={{ key: 'Home', name: 'Home' } as never}
        />
      </WeweProvider>
    </PaperProvider>,
  );
}

test('shows the empty state with no paired monitors', async () => {
  await renderHome(jest.fn());
  await screen.findByText(/No monitors paired yet/);
});

test('lists a paired monitor once one exists', async () => {
  const monitor = { id: 'm1', label: 'Nursery', roomId: '482913', addedAt: '2026-09-20T08:00:00Z' };
  await store.addMonitor(monitor);
  mockSessionsValue.states.set('m1', stateFor({ monitor, connectionState: 'connected' }));
  await renderHome(jest.fn());
  await screen.findByText('Nursery');
  await screen.findByText(/Connected/);
});

test('shows a not-yet-connected status for a monitor with no session state yet', async () => {
  await store.addMonitor({ id: 'm1', label: 'Nursery', roomId: '482913', addedAt: '2026-09-20T08:00:00Z' });
  await renderHome(jest.fn());
  await screen.findByText('Nursery');
  await screen.findByText(/Connecting/);
});

test('tapping "Use this device as a monitor" navigates to Monitor', async () => {
  const navigate = jest.fn();
  await renderHome(navigate);
  await fireEvent.press(await screen.findByText('Use this device as a monitor'));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('Monitor'));
});

test('tapping a paired monitor navigates to Parent with its id', async () => {
  const monitor = { id: 'm1', label: 'Nursery', roomId: '482913', addedAt: '2026-09-20T08:00:00Z' };
  await store.addMonitor(monitor);
  mockSessionsValue.states.set('m1', stateFor({ monitor }));
  const navigate = jest.fn();
  await renderHome(navigate);
  await fireEvent.press(await screen.findByText('Nursery'));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('Parent', { monitorId: 'm1' }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest src/screens/Home.test.tsx
```
Expected: FAIL — `Cannot find module '../ParentSessionsContext'` (the type
import resolves fine since it's type-only and erased, but the `jest.mock`
call targets a module that doesn't exist yet), and/or `Home.tsx` doesn't yet
render any status text ("Connected"/"Connecting").

- [ ] **Step 3: Update `Home.tsx`**

Replace:
```tsx
import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { Button, Dialog, IconButton, List, Portal, Text, TextInput, useTheme } from 'react-native-paper';

import type { PairedMonitor } from '../domain/store';
import type { RootStackParamList } from '../navigation';
import { useWewe } from '../WeweContext';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
```
with:
```tsx
import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { Button, Dialog, IconButton, List, Portal, Text, TextInput, useTheme } from 'react-native-paper';

import { useParentSessions } from '../ParentSessionsContext';
import type { PairedMonitor } from '../domain/store';
import type { RootStackParamList } from '../navigation';
import { useWewe } from '../WeweContext';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/** A short, human status line for a monitor row — mirrors the states ParentSessionState actually produces. */
function statusText(monitorId: string, states: ReturnType<typeof useParentSessions>['states']): string {
  const state = states.get(monitorId);
  if (!state) return 'Connecting…';
  if (state.rejected !== null) return 'Not let in yet';
  if (state.reconnecting !== null) return `Reconnecting (attempt ${state.reconnecting})…`;
  if (state.connectionState === 'connected') return 'Connected';
  if (state.connectTimedOut) return "Couldn't reach this monitor";
  return 'Connecting…';
}
```

Replace:
```ts
  const theme = useTheme();
  const { store, bump, revision } = useWewe();
  const [monitors, setMonitors] = React.useState<PairedMonitor[]>([]);
  const [renaming, setRenaming] = React.useState<PairedMonitor | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
```
with:
```ts
  const theme = useTheme();
  const { store, bump, revision } = useWewe();
  const { states, renameMonitor } = useParentSessions();
  const [monitors, setMonitors] = React.useState<PairedMonitor[]>([]);
  const [renaming, setRenaming] = React.useState<PairedMonitor | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
```

Replace:
```ts
  const saveRename = () => {
    if (!renaming) return;
    const label = renameDraft.trim();
    if (label) {
      store.addMonitor({ ...renaming, label }).then(bump);
    }
    setRenaming(null);
  };
```
with:
```ts
  const saveRename = () => {
    if (!renaming) return;
    const label = renameDraft.trim();
    if (label) {
      renameMonitor(renaming.id, label);
      bump();
    }
    setRenaming(null);
  };
```

Replace:
```tsx
        renderItem={({ item }) => (
          <List.Item
            title={item.label}
            description="Tap to view"
            left={(props) => <List.Icon {...props} icon="baby-face-outline" />}
            right={() => (
              <View style={styles.itemActions}>
                <IconButton icon="pencil-outline" onPress={() => startRename(item)} />
                <IconButton icon="delete-outline" onPress={() => removeMonitor(item)} />
              </View>
            )}
            onPress={() => navigation.navigate('Parent', { monitorId: item.id })}
          />
        )}
```
with:
```tsx
        renderItem={({ item }) => (
          <List.Item
            title={item.label}
            description={statusText(item.id, states)}
            left={(props) => <List.Icon {...props} icon="baby-face-outline" />}
            right={() => (
              <View style={styles.itemActions}>
                <IconButton icon="pencil-outline" onPress={() => startRename(item)} />
                <IconButton icon="delete-outline" onPress={() => removeMonitor(item)} />
              </View>
            )}
            onPress={() => navigation.navigate('Parent', { monitorId: item.id })}
          />
        )}
```

Note: `store`/`bump`'s only remaining direct use is `removeMonitor` (unchanged)
and the `monitors`-loading effect (unchanged) — this task doesn't otherwise
touch either.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx jest src/screens/Home.test.tsx
```
Expected: PASS, all 5 tests.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: errors remain only in `src/screens/Parent.tsx` (Task 9). Confirm
`src/screens/Home.tsx` itself is clean.

- [ ] **Step 6: Run the full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/screens/Home.tsx src/screens/Home.test.tsx
git commit -m "screens: Home becomes a live multi-monitor status dashboard

Each row's description now reflects that monitor's actual live
connection state via ParentSessionsProvider instead of a static 'Tap
to view'. Rename goes through the provider (which also propagates it
to the Monitor) instead of writing the store directly."
```

---

## Task 9: `Parent.tsx` — detail view over shared session state

**Files:**
- Modify: `src/screens/Parent.tsx`

**Interfaces:**
- Consumes: `useParentSessions`/`ParentSessionState` (Task 6).

No automated test for this file, same established posture as today (no
`Parent.test.tsx` exists, and this task doesn't add one).

- [ ] **Step 1: Replace the whole file**

```tsx
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Text, useTheme } from 'react-native-paper';

import QRCode from 'react-native-qrcode-svg';

import { useParentSessions } from '../ParentSessionsContext';
import { pairingUri } from '../domain/pairing';
import type { ActivityEvent } from '../domain/activityLog';
import type { RootStackParamList } from '../navigation';
import { useWewe } from '../WeweContext';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'Parent'>;

/**
 * Parent is a detail view over a monitor's already-running session (owned by
 * ParentSessionsProvider, started as soon as the app opened — see
 * docs/superpowers/specs/2026-09-25-monitor-naming-and-multi-monitor-parent-design.md).
 * Opening or leaving this screen neither starts nor stops anything; it only
 * changes which monitor's state and controls (push-to-talk,
 * invite-a-listener, rename, activity log) are currently on screen.
 */
export function ParentScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { store } = useWewe();
  const { monitorId } = route.params;
  const { states, getSession, startTalking, stopTalking, setInviteMode, renameMonitor } = useParentSessions();
  const state = states.get(monitorId);

  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
  const [talking, setTalking] = React.useState(false);
  // Mirrors `talking`, but updated synchronously — see the identical guard
  // this screen used before this task, now against the shared session
  // instead of a locally-owned one. Same double-invocation race this
  // originally fixed: onPressIn/onPressOut both call toggleTalk, and a quick
  // tap can fire both before React state from the first has flushed.
  const talkingRef = React.useRef(false);

  const refreshEvents = React.useCallback(() => {
    store.events(monitorId).then(setEvents);
  }, [store, monitorId]);

  React.useEffect(() => {
    refreshEvents();
  }, [refreshEvents]);

  const toggleTalk = async () => {
    if (talkingRef.current) {
      talkingRef.current = false;
      stopTalking(monitorId);
      setTalking(false);
    } else {
      talkingRef.current = true;
      await startTalking(monitorId);
      setTalking(true);
    }
  };

  if (!state) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <Text>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        {state.monitor.label}
      </Text>
      <Text variant="bodyMedium" style={styles.status}>
        {state.rejected !== null
          ? 'Not let in yet — ask someone already connected to invite this device.'
          : state.reconnecting !== null
            ? `Reconnecting to relay (attempt ${state.reconnecting})…`
            : state.connectTimedOut && state.connectionState !== 'connected'
              ? "Couldn't reach that monitor. Check it's still running and try again."
              : `Connection: ${state.connectionState}`}
      </Text>

      <Button
        mode={talking ? 'contained' : 'outlined'}
        icon="microphone"
        onPressIn={toggleTalk}
        onPressOut={toggleTalk}
        style={styles.talkButton}
      >
        {talking ? 'Release to stop talking' : 'Hold to talk'}
      </Button>

      <Button
        mode={state.invitingListener ? 'contained' : 'outlined'}
        icon="account-plus-outline"
        onPress={() => setInviteMode(monitorId, !state.invitingListener)}
        style={styles.talkButton}
      >
        {state.invitingListener ? 'Stop inviting' : 'Invite a listener'}
      </Button>

      {state.invitingListener && state.inviteCode !== null && (
        <View style={styles.qrWrap}>
          <QRCode value={pairingUri(state.inviteCode, state.relayUrl)} size={200} />
          <Text variant="headlineMedium" style={styles.code}>
            {state.inviteCode}
          </Text>
        </View>
      )}
      {state.invitingListener && state.inviteCode === null && (
        <Text variant="bodyMedium" style={styles.centeredText}>
          Asking the monitor for a code…
        </Text>
      )}

      <Text variant="titleMedium" style={styles.logTitle}>
        Activity
      </Text>
      {events.map((event) => (
        <List.Item
          key={event.id}
          title={event.kind.replace('_', ' ')}
          description={event.occurredAt}
          left={(props) => <List.Icon {...props} icon="bell-outline" />}
        />
      ))}

      <Button onPress={() => navigation.goBack()} style={styles.back}>
        Back
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  title: { marginBottom: 4 },
  status: { marginBottom: 24 },
  talkButton: { marginBottom: 24 },
  centeredText: { textAlign: 'center', marginBottom: 16 },
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 16, alignItems: 'center' },
  code: { letterSpacing: 4, marginTop: 8 },
  logTitle: { marginBottom: 8 },
  back: { marginTop: 16 },
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors anywhere in the project.

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```
Expected: all tests pass (no `Parent.test.tsx` exists today).

- [ ] **Step 4: Commit**

```bash
git add src/screens/Parent.tsx
git commit -m "screens: Parent becomes a detail view over a shared session

Reads connectionState/rejected/talking/inviteCode/monitor label from
ParentSessionsProvider instead of owning a ParentSession itself.
Opening or leaving this screen no longer starts or stops anything -
push-to-talk goes through the provider's startTalking/stopTalking so
the shared foreground-service notification stays correct."
```

---

## Task 10: Manual multi-monitor verification, full check, release

**Files:** none (verification only — no automated test exercises two real,
simultaneously-connected WebRTC sessions end to end, same posture this
project already takes for `MonitorSession`/`ParentSession`; see Tasks 3/5/6's
own notes).

- [ ] **Step 1: Build and install the debug dev client**

```bash
cd android && ./gradlew assembleDebug
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
```
Repeat on every connected device. If fewer than three physical devices are
available, `tools/test-parent.html` (added earlier this session) can stand in
for extra Parent phones — it speaks the same relay protocol; it does not need
updating for this plan (it never sends or needs to understand the
`monitorName`/`setMonitorName` signals, and already ignores unrecognized
JSON fields gracefully).

- [ ] **Step 2: Verify naming, both directions**

Phone A: "Use this device as a monitor" — confirm an auto-generated name
(e.g. "raring-rabbit") appears immediately, with a pencil icon next to it.
Pair Phone B to it. Confirm B's Home row shows that same name. On A, tap the
pencil and rename it — confirm B's Home row updates live, with no reconnect.
On B, open the Parent detail screen and use its own rename (if the UI
exposes one there; otherwise use Home's) — confirm A's own screen updates to
the new name too.

- [ ] **Step 3: Verify simultaneous multi-monitor listening**

Pair Phone B to a second Monitor (Phone C, or a second `MonitorSession`
instance via `tools/test-parent.html`'s Monitor-side equivalent if available,
otherwise a second physical device). Confirm B's Home dashboard shows both
monitors as "Connected" at the same time, and that audio from *both* plays
simultaneously (mixed) — make noise near each Monitor in turn and confirm
both are audible without one displacing the other.

- [ ] **Step 4: Verify connections survive navigation**

On B, open Monitor 1's detail screen, then navigate back to Home, then open
Monitor 2's detail screen. Confirm Monitor 1 never shows as disconnected at
any point in this sequence — check its Home row status before and after.

- [ ] **Step 5: Verify cry/noise alerts and the activity log stay per-monitor**

Make a sustained loud noise near Monitor 1 only. Confirm B gets an alert
naming Monitor 1's label, and that Monitor 1's own activity log (not
Monitor 2's) records it.

- [ ] **Step 6: Verify push-to-talk doesn't disturb the shared notification or
  the other monitor**

While connected to both, hold-to-talk on Monitor 1. Confirm the persistent
notification updates to reflect the `MICROPHONE` type is active, Monitor 2's
audio is unaffected, and releasing downgrades the notification back to
`MEDIA_PLAYBACK`-only *only if* nothing else is currently talking.

- [ ] **Step 7: Verify the invite-a-listener QR still works end to end**

On B, "Invite a listener" for Monitor 1. Confirm a code/QR appears (not
blank/broken — this is exactly the relay-URL path Task 10 of this plan's
predecessor round fixed). Scan or enter it on a fourth device/tab and confirm
it connects.

- [ ] **Step 8: Verify removing a monitor stops its session cleanly**

Remove one paired monitor from B's Home screen while it's connected. Confirm
its audio stops immediately, the notification's monitor count updates, and
the other monitor is unaffected.

- [ ] **Step 9: Final full check**

```bash
make check
```
Expected: typecheck and the full Jest suite (both app projects) pass clean.

- [ ] **Step 10: Push and cut a new beta**

```bash
git push origin main
```
Follow this repo's existing release process (`make prepare-release
TAG=v1.0.0-beta.N CHANGELOG=...`, tag, push) once every manual verification
step above has passed on real devices — do not cut a release before that,
since this feature has no automated coverage for the actual simultaneous
multi-session path end to end.
