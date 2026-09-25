# Ephemeral, Rotating Pairing Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the pairing code's two conflated jobs (stable relay room name, one-time
invite secret) apart: a persistent, unguessable `monitorRoomId` (never shown) carries
every real WebRTC connection; the displayed six-digit code becomes a short-lived,
rotating, relay-aliased invite token with a 60-second window that must be explicitly
re-armed once it lapses.

**Architecture:** A new relay-side alias map (`Map<alias, roomId>`, its own TTL,
mirroring the existing room-TTL pattern) lets a Parent join using either the rotating
code (resolved transparently) or, from then on, the Monitor's real stable room
directly. `MonitorSession` owns code generation/rotation/broadcast entirely;
`ParentSession`/`Parent.tsx` learn and persist the stable room id from the relay's
`joined` ack and never touch the rotating code again after their first successful join.

**Tech Stack:** Same as the rest of the project — TypeScript, `ws` (signal-server),
`react-native-webrtc`, Jest (`node:sqlite`/plain-node for domain+relay, `jest-expo` for
screens, untested by established project convention).

**Spec:** [`docs/superpowers/specs/2026-09-25-ephemeral-rotating-pairing-codes-design.md`](../specs/2026-09-25-ephemeral-rotating-pairing-codes-design.md)

## Global Constraints

- No migration path for pairings made before this ships — existing beta pairings need
  to be re-added once this lands (spec's explicit Non-goal).
- `InviteMode` (`src/domain/inviteMode.ts`) and `decideListener` stay unchanged — the
  spec is explicit that authorization logic is untouched; only code
  generation/rotation/discovery changes.
- The relay stays fully stateless in the same sense as today: nothing the alias map
  holds survives past its own short TTL.
- Two independently-configured 60-second defaults (the relay's `aliasTtlMs`, the app's
  client-side invite-window timer) intentionally are NOT shared across the
  app/signal-server package boundary — same duplication-by-design reasoning as
  `DEFAULT_ICE_SERVERS` and the wire-protocol mirror already in this codebase. Keep
  both at 60,000ms; a comment at each declaration says so.

## Review Focus

- **A Parent's `joined` ack arrives with the room resolved via an alias vs. a direct
  (already-known stable) room name** — both must persist correctly and identically; the
  Parent-side code must not assume "aliased" is the only path that teaches it a room
  id. Task 9 pins this.
- **The invite window's 60-second timer firing while a remote Parent (not just the
  Monitor's own screen) is the one holding it open** — that Parent's UI must be told the
  code died, not left silently showing a dead code forever. Task 5 pins this via
  `remoteHolders` broadcast.
- **A device that scans a code, gets its `PairedMonitor` record persisted, but is
  rejected (invite window closes before authorization completes)** — must still have
  learned the real `roomId` from the `joined` ack (which fires before authorization is
  decided), so a later invite doesn't require rescanning. Task 9's ordering
  (`onRoomResolved` before any accept/reject outcome) pins this.
- **`set-alias` from a role that isn't `monitor`, or before joining at all** — must be
  rejected, not silently accepted or silently ignored in a way that leaves the sender
  guessing. Task 1 pins this with dedicated tests.
- **Re-arming while listeners are already connected** — must not disturb any
  already-established peer connection; only the invite/discovery path is affected.
  Task 5's `armInvite`/`expireInvite` never touch `this.peers`. Task 10's manual
  checklist pins this on real devices.

---

## Task 1: Relay — alias map for rotating pairing codes

**Files:**
- Modify: `signal-server/src/protocol.ts`
- Modify: `signal-server/src/server.ts`
- Modify: `signal-server/src/server.test.ts`

**Interfaces:**
- Produces: `SetAliasMessage`, `JoinedMessage.room?: string` (always present for a
  `parent` join, absent for `monitor`), `SignalingServerOptions.aliasTtlMs`. Consumed
  by Task 3 (`SignalingClient`'s app-side mirror; independently duplicated, not
  type-shared, per this project's established cross-package convention).

- [ ] **Step 1: Update `protocol.ts`**

Replace the whole file:

```ts
/** See README.md for the full wire-protocol contract this file types. */

export type Role = 'monitor' | 'parent';

export interface JoinMessage {
  type: 'join';
  room: string;
  role: Role;
  /** Required when role is 'parent' — identifies this specific device across reconnects. Not used for 'monitor' (a room only ever has one). */
  deviceId?: string;
}

export interface SignalMessage {
  type: 'signal';
  payload: unknown;
  /** Which Parent to route to. Required from the Monitor (which may have several Parents connected); omitted from a Parent (there's only one Monitor to reach). */
  to?: string;
}

export interface SetAliasMessage {
  type: 'set-alias';
  /** A short-lived name that currently resolves to the sender's own room — see server.ts's alias map. Monitor-only. */
  alias: string;
}

export type ClientMessage = JoinMessage | SignalMessage | SetAliasMessage;

export interface JoinedMessage {
  type: 'joined';
  role: Role;
  /** The room this join actually resolved to. Always present for role 'parent' (whether `room` on the way in was a live alias or already the real room name); never present for role 'monitor' (a Monitor always joins its own room directly — no aliasing applies to its own join). */
  room?: string;
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
  /** Present only in the message sent to the Monitor, identifying which Parent joined. Absent in the message sent to a Parent (it only ever has the Monitor as a peer). */
  deviceId?: string;
}

export interface PeerLeftMessage {
  type: 'peer-left';
  /** Same deviceId convention as PeerJoinedMessage. */
  deviceId?: string;
}

export type ErrorReason = 'role-taken' | 'must-join-first' | 'invalid-message' | 'room-expired' | 'rate-limited';

export interface ErrorMessage {
  type: 'error';
  message: ErrorReason;
}

export interface ServerSignalMessage {
  type: 'signal';
  payload: unknown;
  /** The sending Parent's deviceId, present only in messages delivered to the Monitor. */
  from?: string;
}

export type ServerMessage = JoinedMessage | PeerJoinedMessage | PeerLeftMessage | ErrorMessage | ServerSignalMessage;

const MAX_ALIAS_LENGTH = 64;

/** True iff `value` is a well-formed ClientMessage; narrows the parsed JSON before it's trusted. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const v = value as { type: unknown };
  if (v.type === 'join') {
    const j = value as Partial<JoinMessage>;
    if (typeof j.room !== 'string' || j.room.length === 0) return false;
    if (j.role !== 'monitor' && j.role !== 'parent') return false;
    if (j.role === 'parent' && typeof j.deviceId !== 'string') return false;
    return true;
  }
  if (v.type === 'signal') {
    if (!('payload' in value)) return false;
    const s = value as Partial<SignalMessage>;
    return s.to === undefined || typeof s.to === 'string';
  }
  if (v.type === 'set-alias') {
    const a = value as Partial<SetAliasMessage>;
    return typeof a.alias === 'string' && a.alias.length > 0 && a.alias.length <= MAX_ALIAS_LENGTH;
  }
  return false;
}
```

- [ ] **Step 2: Write the new/updated failing tests**

In `signal-server/src/server.test.ts`, first update the three existing assertions that
now need a `room` field (the direct, non-aliased case — `room` equals whatever name was
sent, since resolution falls through to the literal name when nothing aliases it).

Replace (line ~120, inside `'the second peer to join notifies both sides'`):
```ts
    await expect(parent.next()).resolves.toEqual({ type: 'joined', role: 'parent' });
```
with:
```ts
    await expect(parent.next()).resolves.toEqual({ type: 'joined', role: 'parent', room: 'r1' });
```

Replace (line ~198, inside the simultaneous-multi-parent test, `parentB` — which joins
room `'r1'`):
```ts
    await expect(parentB.next()).resolves.toEqual({ type: 'joined', role: 'parent' });
```
with:
```ts
    await expect(parentB.next()).resolves.toEqual({ type: 'joined', role: 'parent', room: 'r1' });
```

Replace (line ~225, inside the same-deviceId-reconnect test — also room `'r1'`):
```ts
    await expect(parent2.next()).resolves.toEqual({ type: 'joined', role: 'parent' });
```
with:
```ts
    await expect(parent2.next()).resolves.toEqual({ type: 'joined', role: 'parent', room: 'r1' });
```

Then add a new top-level `describe` block, after the existing `describe('per-IP join
rate limiting', ...)` block, for the alias mechanism:

```ts
describe('pairing-code aliases', () => {
  let server: RunningServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  test('a parent joining via a live alias resolves to the aliased room', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'stable-1', role: 'monitor' });
    await monitor.next(); // joined

    monitor.send({ type: 'set-alias', alias: '482913' });

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: '482913', role: 'parent', deviceId: 'dev-1' });

    await expect(parent.next()).resolves.toEqual({ type: 'joined', role: 'parent', room: 'stable-1' });
    await expect(parent.next()).resolves.toEqual({ type: 'peer-joined' });
    await expect(monitor.next()).resolves.toEqual({ type: 'peer-joined', deviceId: 'dev-1' });

    await monitor.close();
    await parent.close();
  });

  test('an unknown alias falls through to literal room-name behavior, same as a wrong code', async () => {
    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: '000000', role: 'parent', deviceId: 'dev-1' });
    await expect(parent.next()).resolves.toEqual({ type: 'joined', role: 'parent', room: '000000' });
    await parent.close();
  });

  test('an alias expires after its TTL — a subsequent join using it no longer resolves', async () => {
    const SHORT_ALIAS_TTL_MS = 50;
    const shortServer = await startServer({ aliasTtlMs: SHORT_ALIAS_TTL_MS });

    const monitor = await TestClient.connect(shortServer.url);
    monitor.send({ type: 'join', room: 'stable-2', role: 'monitor' });
    await monitor.next(); // joined
    monitor.send({ type: 'set-alias', alias: '111111' });

    await new Promise((resolve) => setTimeout(resolve, SHORT_ALIAS_TTL_MS + 20));

    const parent = await TestClient.connect(shortServer.url);
    parent.send({ type: 'join', room: '111111', role: 'parent', deviceId: 'dev-1' });
    // No longer aliased to stable-2 — resolves to the literal (now empty) room '111111'.
    await expect(parent.next()).resolves.toEqual({ type: 'joined', role: 'parent', room: '111111' });

    await monitor.close();
    await parent.close();
    await shortServer.close();
  });

  test('set-alias from a parent is rejected with invalid-message', async () => {
    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });
    await parent.next(); // joined

    parent.send({ type: 'set-alias', alias: '482913' });
    await expect(parent.next()).resolves.toEqual({ type: 'error', message: 'invalid-message' });
  });

  test('set-alias before joining is rejected with must-join-first', async () => {
    const socket = await TestClient.connect(server.url);
    socket.send({ type: 'set-alias', alias: '482913' });
    await expect(socket.next()).resolves.toEqual({ type: 'error', message: 'must-join-first' });
  });

  test('re-registering a different alias does not disturb resolution via the previous one until it separately expires', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'stable-3', role: 'monitor' });
    await monitor.next(); // joined

    monitor.send({ type: 'set-alias', alias: '222222' });
    monitor.send({ type: 'set-alias', alias: '333333' });

    const parentOld = await TestClient.connect(server.url);
    parentOld.send({ type: 'join', room: '222222', role: 'parent', deviceId: 'dev-old' });
    await expect(parentOld.next()).resolves.toEqual({ type: 'joined', role: 'parent', room: 'stable-3' });

    const parentNew = await TestClient.connect(server.url);
    parentNew.send({ type: 'join', room: '333333', role: 'parent', deviceId: 'dev-new' });
    await expect(parentNew.next()).resolves.toEqual({ type: 'joined', role: 'parent', room: 'stable-3' });

    await monitor.close();
    await parentOld.close();
    await parentNew.close();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm test --prefix signal-server
```
Expected: FAIL — the three updated assertions fail because `joined` doesn't carry
`room` yet; the new `describe('pairing-code aliases', ...)` block's tests fail because
`set-alias` isn't recognized (`isClientMessage` already accepts it from Step 1, but
`server.ts` doesn't act on it yet, so aliasing/resolution/room-in-ack don't happen).

- [ ] **Step 4: Update `server.ts`**

`server.ts`'s existing import line (`import { isClientMessage, type ErrorReason, type
Role, type ServerMessage } from './protocol';`) needs no change — `SetAliasMessage`
isn't referenced by name in `server.ts` (message shapes flow through the already-
imported `isClientMessage` narrowing).

Replace:
```ts
/** A lone side waiting for its match gets disconnected after this long — see `SignalingServerOptions.roomTtlMs`'s doc comment for why. */
const DEFAULT_ROOM_TTL_MS = 5 * 60 * 1000;

/** Default per-IP join-attempt budget — see `SignalingServerOptions.rateLimitMax`'s doc comment. */
const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export interface SignalingServerOptions {
  /**
   * How long a room may have exactly one side present (a Monitor with no
   * Parents, or one-or-more Parents with no Monitor) before every occupant
   * is disconnected with `room-expired` and the room is forgotten. Pairing
   * codes are short (six digits — one million possibilities) and reused as
   * the room name directly, so an attacker guessing codes could otherwise
   * camp in a real monitor's room indefinitely. Bounding how long an
   * unmatched room stays open bounds that exposure window without changing
   * the pairing UX.
   */
  roomTtlMs?: number;
  /**
   * Max `join` attempts one remote address may make within
   * `rateLimitWindowMs` before further attempts are rejected with
   * `rate-limited`. Raises the cost of brute-forcing the six-digit code
   * space from "instant" to impractical for a single source.
   */
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}
```
with:
```ts
/** A lone side waiting for its match gets disconnected after this long — see `SignalingServerOptions.roomTtlMs`'s doc comment for why. */
const DEFAULT_ROOM_TTL_MS = 5 * 60 * 1000;

/** Default per-IP join-attempt budget — see `SignalingServerOptions.rateLimitMax`'s doc comment. */
const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * How long a registered alias stays resolvable — see `SignalingServerOptions.aliasTtlMs`'s
 * doc comment. Kept in sync with the app's own client-side invite-window timer
 * (`src/webrtc/monitorSession.ts`'s `INVITE_WINDOW_MS`) by convention, not by shared
 * code — same cross-package duplication this project already accepts for
 * `DEFAULT_ICE_SERVERS` and the wire-protocol types themselves.
 */
const DEFAULT_ALIAS_TTL_MS = 60 * 1000;

export interface SignalingServerOptions {
  /**
   * How long a room may have exactly one side present (a Monitor with no
   * Parents, or one-or-more Parents with no Monitor) before every occupant
   * is disconnected with `room-expired` and the room is forgotten. Rooms are
   * now keyed by a Monitor's own persistent, unguessable room id rather than
   * the displayed pairing code (see `SetAliasMessage`), so this bounds
   * abandoned-room memory growth rather than brute-force exposure — that's
   * `aliasTtlMs`'s job now.
   */
  roomTtlMs?: number;
  /**
   * Max `join` attempts one remote address may make within
   * `rateLimitWindowMs` before further attempts are rejected with
   * `rate-limited`. Raises the cost of brute-forcing the six-digit alias
   * space from "instant" to impractical for a single source.
   */
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  /**
   * How long a `set-alias` registration stays resolvable before a `join`
   * using it falls through to literal (almost certainly empty) room-name
   * behavior. This is the actual security boundary for how long a
   * displayed pairing code can be used to find a Monitor's room — the
   * client-side countdown UI is just a reflection of this, not the
   * enforcement.
   */
  aliasTtlMs?: number;
}
```

Replace:
```ts
export function attachSignalingServer(wss: WebSocketServer, options: SignalingServerOptions = {}): void {
  const roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
  const rateLimiter = new JoinRateLimiter(
    options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
    options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  );

  const rooms = new Map<string, Room>();
  const roomTimers = new Map<string, NodeJS.Timeout>();
```
with:
```ts
export function attachSignalingServer(wss: WebSocketServer, options: SignalingServerOptions = {}): void {
  const roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
  const aliasTtlMs = options.aliasTtlMs ?? DEFAULT_ALIAS_TTL_MS;
  const rateLimiter = new JoinRateLimiter(
    options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
    options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  );

  const rooms = new Map<string, Room>();
  const roomTimers = new Map<string, NodeJS.Timeout>();
  // alias -> the real room name it currently resolves to. A Parent joining
  // with `room` matching a live key here lands in that room instead,
  // transparently. Cleared per-alias by its own TTL timer, never by a
  // Monitor's own disconnect — a stale alias pointing at a since-vacated
  // room just resolves to an empty room that behaves exactly like a
  // wrong/expired code, so there's nothing to clean up eagerly.
  const aliases = new Map<string, string>();
  const aliasTimers = new Map<string, NodeJS.Timeout>();
```

Replace:
```ts
  function clearRoomTimer(roomName: string): void {
    const timer = roomTimers.get(roomName);
    if (timer !== undefined) {
      clearTimeout(timer);
      roomTimers.delete(roomName);
    }
  }
```
with:
```ts
  function clearRoomTimer(roomName: string): void {
    const timer = roomTimers.get(roomName);
    if (timer !== undefined) {
      clearTimeout(timer);
      roomTimers.delete(roomName);
    }
  }

  function clearAliasTimer(alias: string): void {
    const timer = aliasTimers.get(alias);
    if (timer !== undefined) {
      clearTimeout(timer);
      aliasTimers.delete(alias);
    }
  }
```

Replace the `if (parsed.type === 'join') {` block's room lookup/creation. Replace:
```ts
      if (parsed.type === 'join') {
        if (joinedRoom !== null) {
          closeWithError(socket, 'invalid-message');
          return;
        }
        if (!rateLimiter.attempt(remoteAddress)) {
          closeWithError(socket, 'rate-limited');
          return;
        }
        const room = rooms.get(parsed.room) ?? { parents: new Map<string, WebSocket>() };
        rooms.set(parsed.room, room);

        if (parsed.role === 'monitor') {
          if (room.monitor !== undefined) {
            closeWithError(socket, 'role-taken');
            return;
          }
          room.monitor = socket;
          joinedRoom = parsed.room;
          joinedRole = 'monitor';
          rearmRoomTimer(parsed.room, room);

          send(socket, { type: 'joined', role: 'monitor' });
          for (const [deviceId, parentSocket] of room.parents) {
            send(socket, { type: 'peer-joined', deviceId });
            send(parentSocket, { type: 'peer-joined' });
          }
          return;
        }

        // role === 'parent'; isClientMessage guarantees deviceId is a string here.
        const deviceId = parsed.deviceId as string;
        const existing = room.parents.get(deviceId);
        if (existing !== undefined && existing !== socket) {
          supersededSockets.add(existing);
          existing.close();
        }
        room.parents.set(deviceId, socket);
        joinedRoom = parsed.room;
        joinedRole = 'parent';
        joinedDeviceId = deviceId;
        rearmRoomTimer(parsed.room, room);

        send(socket, { type: 'joined', role: 'parent' });
        if (room.monitor !== undefined) {
          send(socket, { type: 'peer-joined' });
          // Only a genuinely new device needs telling the Monitor about —
          // a reconnect's deviceId is already known to it.
          if (existing === undefined) {
            send(room.monitor, { type: 'peer-joined', deviceId });
          }
        }
        return;
      }
```
with:
```ts
      if (parsed.type === 'join') {
        if (joinedRoom !== null) {
          closeWithError(socket, 'invalid-message');
          return;
        }
        if (!rateLimiter.attempt(remoteAddress)) {
          closeWithError(socket, 'rate-limited');
          return;
        }

        // A Monitor always joins its own room name directly — aliasing only
        // ever applies to a Parent's incoming `room` value.
        const resolvedRoomName = parsed.role === 'parent' ? (aliases.get(parsed.room) ?? parsed.room) : parsed.room;
        const room = rooms.get(resolvedRoomName) ?? { parents: new Map<string, WebSocket>() };
        rooms.set(resolvedRoomName, room);

        if (parsed.role === 'monitor') {
          if (room.monitor !== undefined) {
            closeWithError(socket, 'role-taken');
            return;
          }
          room.monitor = socket;
          joinedRoom = resolvedRoomName;
          joinedRole = 'monitor';
          rearmRoomTimer(resolvedRoomName, room);

          send(socket, { type: 'joined', role: 'monitor' });
          for (const [deviceId, parentSocket] of room.parents) {
            send(socket, { type: 'peer-joined', deviceId });
            send(parentSocket, { type: 'peer-joined' });
          }
          return;
        }

        // role === 'parent'; isClientMessage guarantees deviceId is a string here.
        const deviceId = parsed.deviceId as string;
        const existing = room.parents.get(deviceId);
        if (existing !== undefined && existing !== socket) {
          supersededSockets.add(existing);
          existing.close();
        }
        room.parents.set(deviceId, socket);
        joinedRoom = resolvedRoomName;
        joinedRole = 'parent';
        joinedDeviceId = deviceId;
        rearmRoomTimer(resolvedRoomName, room);

        send(socket, { type: 'joined', role: 'parent', room: resolvedRoomName });
        if (room.monitor !== undefined) {
          send(socket, { type: 'peer-joined' });
          // Only a genuinely new device needs telling the Monitor about —
          // a reconnect's deviceId is already known to it.
          if (existing === undefined) {
            send(room.monitor, { type: 'peer-joined', deviceId });
          }
        }
        return;
      }

      if (parsed.type === 'set-alias') {
        if (joinedRoom === null || joinedRole === null) {
          closeWithError(socket, 'must-join-first');
          return;
        }
        if (joinedRole !== 'monitor') {
          closeWithError(socket, 'invalid-message');
          return;
        }
        clearAliasTimer(parsed.alias);
        aliases.set(parsed.alias, joinedRoom);
        const timer = setTimeout(() => {
          aliasTimers.delete(parsed.alias);
          aliases.delete(parsed.alias);
        }, aliasTtlMs);
        timer.unref?.();
        aliasTimers.set(parsed.alias, timer);
        return;
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test --prefix signal-server
```
Expected: PASS, all tests including the seven new ones.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck --prefix signal-server
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add signal-server/src/protocol.ts signal-server/src/server.ts signal-server/src/server.test.ts
git commit -m "signal-server: rotating pairing codes via a short-lived alias map

New set-alias message (Monitor-only): registers the currently-displayed
six-digit code as a TTL-bound alias for the sender's own room, so a
Parent joining with that code transparently resolves into the real
room. joined now always reports the resolved room to a Parent, whether
it arrived via a live alias or a room name that was already real -
this is how a Parent learns the Monitor's stable, never-displayed
monitorRoomId for every future reconnect."
```

---

## Task 2: Store — `roomId` rename + `monitorRoomId`

**Files:**
- Modify: `src/domain/store.ts`
- Modify: `src/domain/deviceId.ts`
- Modify: `src/domain/deviceId.test.ts`
- Modify: `src/storage/SqliteStore.ts`
- Modify: `src/storage/storeContract.ts`
- Modify: `src/storage/SqliteStore.test.ts`
- Modify: `src/screens/Home.test.tsx`

**Interfaces:**
- Produces: `PairedMonitor.roomId: string` (was `lastPairingCode`),
  `SETTINGS_KEYS.monitorRoomId`, `getOrCreateMonitorRoomId(store): Promise<string>`.
  Consumed by Task 5 (`MonitorSession`), Task 8 (`AddMonitor.tsx`), Task 9
  (`Parent.tsx`).

- [ ] **Step 1: Rewrite the failing/updated tests first**

In `src/storage/storeContract.ts`, replace:
```ts
function monitor(id: string, addedAt: string, label = 'Nursery'): PairedMonitor {
  return { id, label, lastPairingCode: '482913', addedAt };
}
```
with:
```ts
function monitor(id: string, addedAt: string, label = 'Nursery'): PairedMonitor {
  return { id, label, roomId: '482913', addedAt };
}
```

In `src/storage/SqliteStore.test.ts`, replace:
```ts
        id: null as unknown as string,
        label: 'Nursery',
        lastPairingCode: '482913',
        addedAt: '2026-09-20T08:00:00Z',
```
with:
```ts
        id: null as unknown as string,
        label: 'Nursery',
        roomId: '482913',
        addedAt: '2026-09-20T08:00:00Z',
```

In `src/screens/Home.test.tsx`, replace both occurrences of:
```ts
  await store.addMonitor({ id: 'm1', label: 'Nursery', lastPairingCode: '482913', addedAt: '2026-09-20T08:00:00Z' });
```
with:
```ts
  await store.addMonitor({ id: 'm1', label: 'Nursery', roomId: '482913', addedAt: '2026-09-20T08:00:00Z' });
```

In `src/domain/deviceId.test.ts`, replace:
```ts
import { generateDeviceId, getOrCreateDeviceId } from './deviceId';
```
with:
```ts
import { generateDeviceId, getOrCreateDeviceId, getOrCreateMonitorRoomId } from './deviceId';
```

Add, after the closing `});` of the existing `describe('getOrCreateDeviceId', ...)` block:
```ts

describe('getOrCreateMonitorRoomId', () => {
  test('generates and persists one on first use', async () => {
    const store = fakeStore();
    const id = await getOrCreateMonitorRoomId(store);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await expect(store.getSetting(SETTINGS_KEYS.monitorRoomId)).resolves.toBe(id);
  });

  test('returns the same id on every subsequent call', async () => {
    const store = fakeStore();
    const first = await getOrCreateMonitorRoomId(store);
    const second = await getOrCreateMonitorRoomId(store);
    expect(second).toBe(first);
  });

  test('returns an already-persisted id without generating a new one', async () => {
    const store = fakeStore({ [SETTINGS_KEYS.monitorRoomId]: 'existing-room-id' });
    await expect(getOrCreateMonitorRoomId(store)).resolves.toBe('existing-room-id');
  });

  test('is independent of the Parent-side deviceId, even in the same store', async () => {
    const store = fakeStore();
    const deviceId = await getOrCreateDeviceId(store);
    const roomId = await getOrCreateMonitorRoomId(store);
    expect(roomId).not.toBe(deviceId);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest src/domain/deviceId.test.ts src/storage src/screens/Home.test.tsx
```
Expected: FAIL — `getOrCreateMonitorRoomId` isn't exported yet; `PairedMonitor` still
requires `lastPairingCode`, not `roomId`, so the contract/SqliteStore/Home test fixtures
using `roomId` fail to satisfy the type (surfaces as a runtime property-shape mismatch
under Jest's non-typechecking transform — confirm the real type error separately with
`npm run typecheck`, which should show several `lastPairingCode`/`roomId` mismatches).

- [ ] **Step 3: Update `store.ts`**

Replace:
```ts
/** A monitor a parent has paired with, remembered so it can be reconnected to without repairing. */
export interface PairedMonitor {
  id: string;
  label: string;
  lastPairingCode: string;
  /** RFC3339 UTC. */
  addedAt: string;
}
```
with:
```ts
/** A monitor a parent has paired with, remembered so it can be reconnected to without repairing. */
export interface PairedMonitor {
  id: string;
  label: string;
  /**
   * The Monitor's persistent, unguessable relay room id — never a displayed
   * pairing code. Learned from the relay's `joined` ack on first pairing
   * (see `src/webrtc/signalingClient.ts`'s `onJoined` handler) and updated
   * in place if it wasn't already known at record-creation time (see
   * `AddMonitor.tsx`); every reconnect after that uses this directly,
   * never a rotating code.
   */
  roomId: string;
  /** RFC3339 UTC. */
  addedAt: string;
}
```

Replace:
```ts
export const SETTINGS_KEYS = {
  signalingServerUrl: 'signalingServerUrl',
  noiseGateSensitivity: 'noiseGateSensitivity',
  monitorPairingCode: 'monitorPairingCode',
  deviceId: 'deviceId',
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
} as const;
```

(`monitorPairingCode` is removed outright — nothing about the rotating code persists
across a restart anymore; see the spec's "Monitor-side behavior" section.)

- [ ] **Step 4: Update `deviceId.ts`**

Add, at the end of the file:
```ts

/**
 * Returns this Monitor install's persistent, unguessable relay room id,
 * generating and persisting one on first use — the same shape as
 * `getOrCreateDeviceId`, just a different settings key and a different
 * purpose (a room a Monitor always joins directly, never a token proving
 * "the same device as before"). Deliberately independent of `deviceId`:
 * a device could in principle run both a Monitor session and, at some
 * later point, pair as a Parent to a different Monitor — the two
 * identities must never collide.
 */
export async function getOrCreateMonitorRoomId(store: Store): Promise<string> {
  const existing = await store.getSetting(SETTINGS_KEYS.monitorRoomId);
  if (existing) return existing;
  const id = generateDeviceId();
  await store.setSetting(SETTINGS_KEYS.monitorRoomId, id);
  return id;
}
```

- [ ] **Step 5: Update `SqliteStore.ts`**

Replace:
```ts
const MONITOR_COLUMNS = 'id, label, lastPairingCode, addedAt';
```
with:
```ts
const MONITOR_COLUMNS = 'id, label, roomId, addedAt';
```

Replace:
```ts
const PUT_MONITOR = `
  INSERT INTO monitors (${MONITOR_COLUMNS})
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    label = excluded.label,
    lastPairingCode = excluded.lastPairingCode
`;
```
with:
```ts
const PUT_MONITOR = `
  INSERT INTO monitors (${MONITOR_COLUMNS})
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    label = excluded.label,
    roomId = excluded.roomId
`;
```

Replace:
```ts
interface MonitorRow {
  id: string;
  label: string;
  lastPairingCode: string;
  addedAt: string;
}
function toMonitor(row: MonitorRow): PairedMonitor {
  // Copied field by field rather than spread: node:sqlite returns
  // null-prototype objects, and this keeps a plain one crossing the boundary.
  return { id: row.id, label: row.label, lastPairingCode: row.lastPairingCode, addedAt: row.addedAt };
}
```
with:
```ts
interface MonitorRow {
  id: string;
  label: string;
  roomId: string;
  addedAt: string;
}
function toMonitor(row: MonitorRow): PairedMonitor {
  // Copied field by field rather than spread: node:sqlite returns
  // null-prototype objects, and this keeps a plain one crossing the boundary.
  return { id: row.id, label: row.label, roomId: row.roomId, addedAt: row.addedAt };
}
```

Replace:
```ts
      CREATE TABLE IF NOT EXISTS monitors (
        id              TEXT PRIMARY KEY NOT NULL,
        label           TEXT NOT NULL,
        lastPairingCode TEXT NOT NULL,
        addedAt         TEXT NOT NULL
      );
```
with:
```ts
      CREATE TABLE IF NOT EXISTS monitors (
        id              TEXT PRIMARY KEY NOT NULL,
        label           TEXT NOT NULL,
        roomId          TEXT NOT NULL,
        addedAt         TEXT NOT NULL
      );
```

Replace:
```ts
  async addMonitor(monitor: PairedMonitor): Promise<void> {
    await this.db.run(PUT_MONITOR, [monitor.id, monitor.label, monitor.lastPairingCode, monitor.addedAt]);
  }
```
with:
```ts
  async addMonitor(monitor: PairedMonitor): Promise<void> {
    await this.db.run(PUT_MONITOR, [monitor.id, monitor.label, monitor.roomId, monitor.addedAt]);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx jest src/domain/deviceId.test.ts src/storage src/screens/Home.test.tsx
```
Expected: PASS.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```
Expected: errors remain in `src/screens/AddMonitor.tsx`, `src/screens/Monitor.tsx`,
`src/screens/Parent.tsx`, `src/webrtc/monitorSession.ts`, `src/webrtc/parentSession.ts`
(all still reference the old `lastPairingCode` field or the removed
`SETTINGS_KEYS.monitorPairingCode` — fixed in later tasks). Confirm no *other* errors
appeared, and confirm `src/domain/deviceId.ts`, `src/storage/SqliteStore.ts`,
`src/storage/storeContract.ts` themselves are clean.

- [ ] **Step 8: Commit**

```bash
git add src/domain/store.ts src/domain/deviceId.ts src/domain/deviceId.test.ts src/storage/SqliteStore.ts src/storage/storeContract.ts src/storage/SqliteStore.test.ts src/screens/Home.test.tsx
git commit -m "store: rename lastPairingCode to roomId, add monitorRoomId

PairedMonitor.roomId replaces lastPairingCode - same field, different
meaning: a stable relay room id instead of a value that happens to
currently be a valid pairing code. New getOrCreateMonitorRoomId
mirrors getOrCreateDeviceId exactly, for a Monitor's own persistent,
never-displayed room identity."
```

---

## Task 3: App-side signaling protocol — `set-alias` + `onJoined`

**Files:**
- Modify: `src/webrtc/protocol.ts`
- Modify: `src/webrtc/signalingClient.ts`
- Modify: `src/webrtc/signalingClient.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks in this plan (independently mirrors Task 1's
  wire format, per this project's established cross-package duplication).
- Produces: `SignalingClient.setAlias(alias: string): void`,
  `SignalingHandlers.onJoined?: (room?: string) => void`. Consumed by Task 5
  (`MonitorSession.rearmInvite`'s use of `setAlias`), Task 7 (`ParentSession`'s use of
  `onJoined` to learn the resolved room).

- [ ] **Step 1: Update `protocol.ts`**

Replace the whole file:

```ts
/**
 * The client-side half of `signal-server`'s wire protocol — see
 * `signal-server/README.md` for the authoritative contract. Duplicated
 * rather than shared via a package because this crosses a network boundary
 * between two independently deployed processes (the app and any relay
 * instance a user points it at); keeping both typed independently is the
 * same reasoning as versioning any wire format, not accidental drift.
 */
export type Role = 'monitor' | 'parent';

export type ClientMessage =
  | { type: 'join'; room: string; role: Role; deviceId?: string }
  | { type: 'signal'; payload: unknown; to?: string }
  | { type: 'set-alias'; alias: string };

export type ServerMessage =
  | { type: 'joined'; role: Role; room?: string }
  | { type: 'peer-joined'; deviceId?: string }
  | { type: 'peer-left'; deviceId?: string }
  | { type: 'signal'; payload: unknown; from?: string }
  | { type: 'error'; message: string };
```

- [ ] **Step 2: Write the new/updated failing tests**

In `src/webrtc/signalingClient.test.ts`, add these tests inside the
`describe('SignalingClient', ...)` block, after the last existing `it(...)`:

```ts
  it('fires onJoined with the acked room on every successful join', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);
    const onJoined = jest.fn();

    const connected = client.connect('482913', 'parent', { onJoined }, 'dev-1');
    sockets[0]!.simulateOpen();
    sockets[0]!.simulateMessage({ type: 'joined', role: 'parent', room: 'stable-1' });
    await connected;

    expect(onJoined).toHaveBeenCalledWith('stable-1');
  });

  it('fires onJoined with undefined room for a monitor join', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);
    const onJoined = jest.fn();

    const connected = client.connect('stable-1', 'monitor', { onJoined });
    sockets[0]!.simulateOpen();
    sockets[0]!.simulateMessage({ type: 'joined', role: 'monitor' });
    await connected;

    expect(onJoined).toHaveBeenCalledWith(undefined);
  });

  it('sends a set-alias message', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);

    await Promise.all([client.connect('stable-1', 'monitor', {}), Promise.resolve(joinSocket(sockets[0]!))]);
    sockets[0]!.sent.length = 0; // clear the join message
    client.setAlias('482913');

    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'set-alias', alias: '482913' });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx jest src/webrtc/signalingClient.test.ts
```
Expected: FAIL — `onJoined` isn't a recognized handler yet (never called), and
`client.setAlias` doesn't exist (TypeScript error surfaces as a Jest/babel runtime
issue since this project's Jest transform doesn't typecheck; confirm with `npm run
typecheck`).

- [ ] **Step 4: Update `signalingClient.ts`**

Replace the `SignalingHandlers` interface:
```ts
export interface SignalingHandlers {
  /** deviceId is present only when this client is the Monitor (identifying which Parent joined) — see protocol.ts's PeerJoinedMessage doc. */
  onPeerJoined?: (deviceId?: string) => void;
  /** Same deviceId convention as onPeerJoined. */
  onPeerLeft?: (deviceId?: string) => void;
  /** from is present only when this client is the Monitor (identifying which Parent sent it). */
  onSignal?: (payload: unknown, from?: string) => void;
  /** Fires on a relay-reported error or a socket-level failure; the connection is not usable afterward. */
  onError?: (message: string) => void;
  /** Fires when the underlying socket closes for any reason, including a clean one. */
  onClose?: () => void;
  /** Fires each time a retry is scheduled after an unexpected disconnect — never after `close()` was called explicitly. */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Fires once a retry successfully rejoins the room. Never fires for the very first, initial connect. */
  onReconnected?: () => void;
}
```
with:
```ts
export interface SignalingHandlers {
  /** deviceId is present only when this client is the Monitor (identifying which Parent joined) — see protocol.ts's PeerJoinedMessage doc. */
  onPeerJoined?: (deviceId?: string) => void;
  /** Same deviceId convention as onPeerJoined. */
  onPeerLeft?: (deviceId?: string) => void;
  /** from is present only when this client is the Monitor (identifying which Parent sent it). */
  onSignal?: (payload: unknown, from?: string) => void;
  /** Fires on a relay-reported error or a socket-level failure; the connection is not usable afterward. */
  onError?: (message: string) => void;
  /** Fires when the underlying socket closes for any reason, including a clean one. */
  onClose?: () => void;
  /** Fires each time a retry is scheduled after an unexpected disconnect — never after `close()` was called explicitly. */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Fires once a retry successfully rejoins the room. Never fires for the very first, initial connect. */
  onReconnected?: () => void;
  /** Fires on every successful join (initial and each reconnect) with the room the relay actually resolved to — present for a Parent (whether it arrived via a live alias or a room name that was already real), undefined for a Monitor. */
  onJoined?: (room?: string) => void;
}
```

Update the `joined` case inside `attemptConnect`'s `socket.onmessage`. Replace:
```ts
        case 'joined':
          joined = true;
          this.backoff.reset();
          this.reconnectAttempt = 0;
          if (this.hasConnectedOnce) this.handlers.onReconnected?.();
          this.hasConnectedOnce = true;
          resolve();
          break;
```
with:
```ts
        case 'joined':
          joined = true;
          this.backoff.reset();
          this.reconnectAttempt = 0;
          if (this.hasConnectedOnce) this.handlers.onReconnected?.();
          this.hasConnectedOnce = true;
          this.handlers.onJoined?.(message.room);
          resolve();
          break;
```

Add a `setAlias` method, after `sendSignal`:
```ts
  /** Registers `alias` as a short-lived name for this client's own room — Monitor-only; the relay rejects it from a Parent. */
  setAlias(alias: string): void {
    this.socket?.send(JSON.stringify({ type: 'set-alias', alias } satisfies ClientMessage));
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx jest src/webrtc/signalingClient.test.ts
```
Expected: PASS, all tests including the three new ones.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: same set of pre-existing errors as Task 2's Step 7 left (AddMonitor/Monitor/
Parent screens, MonitorSession/ParentSession) — confirm no *new* ones appeared, and
that `src/webrtc/protocol.ts`/`signalingClient.ts` themselves are clean.

- [ ] **Step 7: Commit**

```bash
git add src/webrtc/protocol.ts src/webrtc/signalingClient.ts src/webrtc/signalingClient.test.ts
git commit -m "webrtc: SignalingClient gains setAlias and onJoined

Client-side mirror of Task 1's relay protocol change. setAlias sends
the new set-alias message; onJoined fires on every successful join
(initial and reconnect) with whatever room the relay actually
resolved to, letting a Parent learn the Monitor's stable room id."
```

---

## Task 4: `peerConnectionHelpers` — the `inviteCode` signal payload

**Files:**
- Modify: `src/webrtc/peerConnectionHelpers.ts`

**Interfaces:**
- Produces: `SignalPayload` gains `{ inviteCode: string | null }`,
  `isInviteCodeSignal(payload): payload is { inviteCode: string | null }`. Consumed by
  Task 5 (`MonitorSession`, sending it) and Task 7 (`ParentSession`, receiving it).

- [ ] **Step 1: Extend the payload union and add the guard**

Replace:
```ts
export type SignalPayload =
  | { sdp: WireSdp }
  | { candidate: WireIceCandidate }
  | { rejected: true; reason: string }
  | { inviteMode: 'open' | 'closed' };
```
with:
```ts
export type SignalPayload =
  | { sdp: WireSdp }
  | { candidate: WireIceCandidate }
  | { rejected: true; reason: string }
  | { inviteMode: 'open' | 'closed' }
  | { inviteCode: string | null };
```

Add, after `isInviteModeSignal`:
```ts

/** True iff `payload` is the Monitor telling a remote invite-mode holder what the currently-live pairing code is — `null` means the invite window has closed and there's nothing to show anymore. */
export function isInviteCodeSignal(payload: unknown): payload is { inviteCode: string | null } {
  return typeof payload === 'object' && payload !== null && 'inviteCode' in payload;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: same pre-existing error set as before this task (no new ones) — this file
has no dedicated test suite, same posture as its existing guards (exercised indirectly
through Task 5/7's sessions; verified by typecheck plus Task 10's manual test).

- [ ] **Step 3: Commit**

```bash
git add src/webrtc/peerConnectionHelpers.ts
git commit -m "webrtc: add inviteCode signal payload shape

Carries the Monitor's currently-live pairing code to a remote
invite-mode holder (an already-connected, inviting Parent) over the
existing opaque signal channel — null means the invite window closed."
```

---

## Task 5: `MonitorSession` — stable room, rotating invite code

**Files:**
- Modify: `src/webrtc/monitorSession.ts`

**Interfaces:**
- Consumes: `getOrCreateMonitorRoomId` (Task 2), `SignalingClient.setAlias`/`onJoined`
  (Task 3), `isInviteCodeSignal` (Task 4), `generatePairingCode` (existing,
  `src/domain/pairing.ts`).
- Produces: `MonitorSessionOptions` (no more `pairingCode`),
  `.rearmInvite(): void` (replaces `.openLocalInvite()`), `.closeLocalInvite(): void`
  (unchanged signature/behavior), `MonitorSessionEvents.onInviteCodeChange?: (code:
  string | null, expiresAt: number | null) => void`. Consumed by Task 6
  (`Monitor.tsx`).

No automated test for this file — same as its current (untested) state; see Task 7 of
the prior multi-listener plan for the established rationale (native `RTCPeerConnection`/
`mediaDevices`, no mock in this project's Jest config). Verified by typecheck (Step 2)
plus the manual multi-device test in Task 10.

- [ ] **Step 1: Rewrite `monitorSession.ts`**

Replace the whole file:

```ts
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { MediaStream } from 'react-native-webrtc';

import { getOrCreateMonitorRoomId } from '../domain/deviceId';
import { decideListener, InviteMode } from '../domain/inviteMode';
import { generatePairingCode } from '../domain/pairing';
import type { Store } from '../domain/store';
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteModeSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
import { DEFAULT_ICE_SERVERS } from './rtcConfig';
import { SignalingClient } from './signalingClient';

export interface MonitorSessionOptions {
  signalingUrl: string;
  iceServers?: RTCIceServer[];
}

export interface MonitorSessionEvents {
  /** Fires whenever the number of currently-connected (RTCPeerConnection state 'connected') listeners changes. */
  onListenerCountChange?: (count: number) => void;
  /** Fires whenever the currently-displayable pairing code changes — a fresh code (armed or re-armed), or null (the invite window closed). `expiresAt` is a `Date.now()`-comparable epoch ms timestamp, null iff `code` is null. */
  onInviteCodeChange?: (code: string | null, expiresAt: number | null) => void;
  /** Fires each time the signaling connection retries after an unexpected drop. */
  onSignalingReconnecting?: (attempt: number) => void;
  /** Fires once a signaling retry successfully rejoins the room. */
  onSignalingReconnected?: () => void;
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure. */
  onError?: (message: string) => void;
}

/** How long a newly-armed (or re-armed) invite code stays valid before it must be explicitly re-armed. Kept in sync with signal-server's own `DEFAULT_ALIAS_TTL_MS` by convention, not shared code — see that constant's doc comment. */
const INVITE_WINDOW_MS = 60 * 1000;

interface Peer {
  pc: RTCPeerConnection;
  iceQueue: IceCandidateQueue;
}

/**
 * MonitorSession is the "I have the microphone" side of a call: it owns the
 * local mic track and is always the offerer for each Parent that joins,
 * since it's the side with media to send. `setGateOpen` is the one method
 * the local `NoiseGate` drives — toggling `track.enabled` costs no
 * renegotiation and no bandwidth while closed, and propagates to every
 * connected listener at once since they all share the same track.
 *
 * Holds one RTCPeerConnection per authorized, connected Parent (deviceId),
 * not just one — see
 * docs/superpowers/specs/2026-09-24-multi-listener-invite-gated-pairing-design.md.
 * Authorization itself is decided entirely here (via `store` +
 * `InviteMode`/`decideListener`), never by the relay — a rejected Parent
 * gets an application-level signal, not a relay-level one, because the
 * relay never learns who's authorized in the first place.
 *
 * Joins its own persistent, never-displayed room (`getOrCreateMonitorRoomId`)
 * directly — the displayed six-digit code is a short-lived relay *alias* for
 * that room (`SignalingClient.setAlias`), not the room itself, per
 * docs/superpowers/specs/2026-09-25-ephemeral-rotating-pairing-codes-design.md.
 * `rearmInvite` generates a fresh code and a fresh `INVITE_WINDOW_MS` window
 * every time it's called; letting that window elapse closes invite mode for
 * everyone currently holding it open, not just whoever started the clock —
 * the code and its lifetime are entirely Monitor-owned.
 */
export class MonitorSession {
  private readonly signaling: SignalingClient;
  private readonly peers = new Map<string, Peer>();
  private readonly inviteMode = new InviteMode();
  /** Remote (Parent) invite-mode holders — a subset of what's in `inviteMode`, tracked separately since `InviteMode` itself doesn't expose holder iteration (deliberately kept minimal/pure — see its own module doc). Used only to know who to notify when the current code changes. */
  private readonly remoteHolders = new Set<string>();
  private localStream: MediaStream | null = null;
  private currentCode: string | null = null;
  private codeExpiresAt: number | null = null;
  private inviteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: MonitorSessionOptions,
    private readonly store: Store,
    private readonly events: MonitorSessionEvents = {},
  ) {
    this.signaling = new SignalingClient(options.signalingUrl);
  }

  /** Requests the mic and joins this install's own persistent room. Call once; call `stop()` before starting again. */
  async start(): Promise<void> {
    this.localStream = (await mediaDevices.getUserMedia({ audio: true })) as MediaStream;
    const roomId = await getOrCreateMonitorRoomId(this.store);

    await this.signaling.connect(roomId, 'monitor', {
      onPeerJoined: (deviceId) => {
        if (deviceId === undefined) return;
        this.handlePeerJoined(deviceId).catch(() => {
          this.teardownPeer(deviceId);
        });
      },
      onPeerLeft: (deviceId) => {
        if (deviceId === undefined) return;
        this.teardownPeer(deviceId);
        this.inviteMode.close(deviceId);
        this.remoteHolders.delete(deviceId);
        this.events.onListenerCountChange?.(this.countConnected());
      },
      onSignal: (payload, from) => {
        this.handleSignal(payload, from).catch(() => {});
      },
      onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
      onReconnected: () => this.events.onSignalingReconnected?.(),
      onError: (message) => this.events.onError?.(message),
    });
  }

  /** Generates a fresh pairing code, registers it as a relay alias for this room, opens this device's own invite-mode hold, and starts a fresh `INVITE_WINDOW_MS` countdown. Call after `start()` resolves, and again whenever the user explicitly asks to re-open pairing. */
  rearmInvite(): void {
    this.inviteMode.open('local');
    this.armInvite();
  }

  /** Call in the pairing screen's unmount cleanup. Does not affect the code's own countdown or any other holder — see the class doc comment. */
  closeLocalInvite(): void {
    this.inviteMode.close('local');
  }

  /** Enables or disables the outgoing mic track on every connected peer without renegotiating — the local NoiseGate's hook into this session. */
  setGateOpen(open: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = open;
    }
  }

  stop(): void {
    if (this.inviteTimer !== null) {
      clearTimeout(this.inviteTimer);
      this.inviteTimer = null;
    }
    for (const deviceId of [...this.peers.keys()]) this.teardownPeer(deviceId);
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.signaling.close();
  }

  private armInvite(): void {
    if (this.inviteTimer !== null) {
      clearTimeout(this.inviteTimer);
    }
    const code = generatePairingCode();
    this.currentCode = code;
    this.codeExpiresAt = Date.now() + INVITE_WINDOW_MS;
    this.signaling.setAlias(code);
    this.broadcastInviteCode();
    this.inviteTimer = setTimeout(() => this.expireInvite(), INVITE_WINDOW_MS);
  }

  private expireInvite(): void {
    this.inviteTimer = null;
    this.currentCode = null;
    this.codeExpiresAt = null;
    this.inviteMode.close('local');
    for (const holder of this.remoteHolders) this.inviteMode.close(holder);
    this.remoteHolders.clear();
    this.broadcastInviteCode();
  }

  private broadcastInviteCode(): void {
    this.events.onInviteCodeChange?.(this.currentCode, this.codeExpiresAt);
    for (const holder of this.remoteHolders) {
      this.signaling.sendSignal({ inviteCode: this.currentCode }, holder);
    }
  }

  /** A remote (already-authorized, already-connected) Parent asked to open invite mode. Reuses the currently-live code if there is one, rather than clobbering whatever the Monitor's own screen (or another Parent) might already be showing — only arms fresh if nothing is currently live. */
  private ensureInviteArmed(holder: string): void {
    this.remoteHolders.add(holder);
    this.inviteMode.open(holder);
    if (this.currentCode === null) {
      this.armInvite();
    } else {
      this.signaling.sendSignal({ inviteCode: this.currentCode }, holder);
    }
  }

  private closeRemoteInvite(holder: string): void {
    this.remoteHolders.delete(holder);
    this.inviteMode.close(holder);
  }

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

  private countConnected(): number {
    let count = 0;
    for (const { pc } of this.peers.values()) {
      if (pc.connectionState === 'connected') count += 1;
    }
    return count;
  }

  private async createOfferFor(deviceId: string): Promise<void> {
    const pc = this.setupPeerConnection(deviceId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendSignal({ sdp: { sdp: offer.sdp, type: offer.type } }, deviceId);
  }

  private setupPeerConnection(deviceId: string): RTCPeerConnection {
    const existing = this.peers.get(deviceId);
    if (existing) return existing.pc;

    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers ?? DEFAULT_ICE_SERVERS });
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }

    pc.onicecandidate = (event: { candidate: { candidate: string; sdpMLineIndex?: number | null; sdpMid?: string | null } | null }) => {
      if (event.candidate) {
        this.signaling.sendSignal({ candidate: event.candidate }, deviceId);
      }
    };
    pc.onconnectionstatechange = () => {
      this.events.onListenerCountChange?.(this.countConnected());
    };

    this.peers.set(deviceId, { pc, iceQueue: new IceCandidateQueue() });
    return pc;
  }

  private async handleSignal(payload: unknown, from: string | undefined): Promise<void> {
    if (from === undefined) return;

    if (isInviteModeSignal(payload)) {
      // Only an already-connected (and therefore already-authorized) peer
      // may toggle invite mode on the Monitor's behalf — a not-yet-accepted
      // deviceId trying this has no entry in `peers` yet.
      if (!this.peers.has(from)) return;
      if (payload.inviteMode === 'open') this.ensureInviteArmed(from);
      else this.closeRemoteInvite(from);
      return;
    }

    const peer = this.peers.get(from);
    if (!peer) return;
    if (isSdpSignal(payload)) {
      await handleIncomingSdp(peer.pc, payload.sdp, peer.iceQueue, (p) => this.signaling.sendSignal(p, from));
    } else if (isCandidateSignal(payload)) {
      await peer.iceQueue.add(peer.pc, payload.candidate);
    }
  }

  private teardownPeer(deviceId: string): void {
    this.peers.get(deviceId)?.pc.close();
    this.peers.delete(deviceId);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: errors remain only in `src/screens/Monitor.tsx` (still constructs
`MonitorSession` with the old options shape and event names) and, unrelated to this
task, `src/screens/AddMonitor.tsx`/`src/screens/Parent.tsx`/`src/webrtc/parentSession.ts`
(Tasks 7-9). Confirm `src/webrtc/monitorSession.ts` itself is clean.

- [ ] **Step 3: Commit**

```bash
git add src/webrtc/monitorSession.ts
git commit -m "webrtc: MonitorSession owns rotating pairing codes end to end

Joins its own persistent, never-displayed monitorRoomId directly
instead of a pairing-code room. rearmInvite generates a fresh code,
registers it as a 60s relay alias, and starts a matching client-side
countdown; letting it lapse closes invite mode for every current
holder (not just whoever started the clock) and tells every remote
holder the code died. An already-connected Parent's invite-mode
request reuses whatever code is already live instead of clobbering it
with a surprise new one."
```

---

## Task 6: `Monitor.tsx` — window/listener two-axis UI

**Files:**
- Modify: `src/screens/Monitor.tsx`

**Interfaces:**
- Consumes: `MonitorSession` (Task 5, new options/events shape, `.rearmInvite()`
  replacing `.openLocalInvite()`).

- [ ] **Step 1: Remove the persisted-pairing-code effect and related state**

Replace:
```ts
  // undefined: neither setting has resolved yet — kept distinguishable from
  // an empty/unset relayUrl (which falls back to the default below) so this
  // screen can tell "still loading" from "loaded, nothing configured".
  const [pairingCode, setPairingCode] = React.useState<string | undefined>(undefined);
  const [relayUrl, setRelayUrl] = React.useState<string | undefined>(undefined);
  const [listenerCount, setListenerCount] = React.useState(0);
  const [reconnecting, setReconnecting] = React.useState<number | null>(null);
  const [gateOpen, setGateOpen] = React.useState(false);
```
with:
```ts
  // undefined: relayUrl hasn't resolved yet — kept distinguishable from an
  // empty/unset value (which falls back to the default below) so this
  // screen can tell "still loading" from "loaded, nothing configured".
  const [relayUrl, setRelayUrl] = React.useState<string | undefined>(undefined);
  const [listenerCount, setListenerCount] = React.useState(0);
  const [inviteCode, setInviteCode] = React.useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = React.useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(null);
  const [reconnecting, setReconnecting] = React.useState<number | null>(null);
  const [gateOpen, setGateOpen] = React.useState(false);
```

Replace:
```ts
  React.useEffect(() => {
    store.getSetting(SETTINGS_KEYS.signalingServerUrl).then((value) => setRelayUrl(value || DEFAULT_SIGNALING_SERVER_URL));
  }, [store]);

  React.useEffect(() => {
    store.getSetting(SETTINGS_KEYS.monitorPairingCode).then((existing) => {
      if (existing) {
        setPairingCode(existing);
        return;
      }
      const code = generatePairingCode();
      store.setSetting(SETTINGS_KEYS.monitorPairingCode, code).then(() => setPairingCode(code));
    });
  }, [store]);
```
with:
```ts
  React.useEffect(() => {
    store.getSetting(SETTINGS_KEYS.signalingServerUrl).then((value) => setRelayUrl(value || DEFAULT_SIGNALING_SERVER_URL));
  }, [store]);
```

- [ ] **Step 2: Update the session-construction effect**

Replace:
```ts
  React.useEffect(() => {
    if (!relayUrl || !pairingCode) return;

    const session = new MonitorSession(
      { signalingUrl: relayUrl, pairingCode },
      store,
      {
        onListenerCountChange: setListenerCount,
        onSignalingReconnecting: (attempt) => setReconnecting(attempt),
        onSignalingReconnected: () => setReconnecting(null),
      },
    );
    sessionRef.current = session;
    session.start().catch(() => {});
    advertiserRef.current.publish(pairingCode, pairingCode);
    // The pairing screen being open IS this device's own invite-mode
    // holder — see InviteMode's doc comment (src/domain/inviteMode.ts).
    session.openLocalInvite();

    return () => {
      session.closeLocalInvite();
      session.stop();
      advertiserRef.current.unpublish(pairingCode);
      stopForegroundSession().catch(() => {});
    };
  }, [relayUrl, pairingCode, store]);
```
with:
```ts
  React.useEffect(() => {
    if (!relayUrl) return;

    const session = new MonitorSession(
      { signalingUrl: relayUrl },
      store,
      {
        onListenerCountChange: setListenerCount,
        onInviteCodeChange: (code, expiresAt) => {
          setInviteCode(code);
          setInviteExpiresAt(expiresAt);
        },
        onSignalingReconnecting: (attempt) => setReconnecting(attempt),
        onSignalingReconnected: () => setReconnecting(null),
      },
    );
    sessionRef.current = session;
    // rearmInvite() sends set-alias, which the relay only accepts once this
    // room has actually been joined — must wait for start() to resolve.
    session
      .start()
      .then(() => session.rearmInvite())
      .catch(() => {});

    return () => {
      session.closeLocalInvite();
      session.stop();
      stopForegroundSession().catch(() => {});
    };
  }, [relayUrl, store]);

  // mDNS re-publishes under the current code each time it rotates — separate
  // from the session effect above since inviteCode changes many times over
  // one mount, not just once.
  React.useEffect(() => {
    if (!inviteCode) return;
    advertiserRef.current.publish(inviteCode, inviteCode);
    return () => advertiserRef.current.unpublish(inviteCode);
  }, [inviteCode]);

  // Ticking countdown display, independent of the session's own internal
  // timer — this is purely a UI reflection of inviteExpiresAt.
  React.useEffect(() => {
    if (inviteExpiresAt === null) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((inviteExpiresAt - Date.now()) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [inviteExpiresAt]);
```

- [ ] **Step 3: Update the loading guard and imports**

Replace:
```ts
  if (relayUrl === undefined || pairingCode === undefined) {
```
with:
```ts
  if (relayUrl === undefined) {
```

Replace:
```ts
import { NoiseGate } from '../domain/noiseGate';
import { generatePairingCode, pairingUri } from '../domain/pairing';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS } from '../domain/store';
```
with:
```ts
import { NoiseGate } from '../domain/noiseGate';
import { pairingUri } from '../domain/pairing';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS } from '../domain/store';
```

- [ ] **Step 4: Rewrite the main render — connected banner + window state**

Replace:
```ts
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        This device is the monitor
      </Text>

      <View style={styles.qrWrap}>
        <QRCode value={pairingUri(pairingCode, relayUrl)} size={200} />
      </View>
      <Text variant="headlineMedium" style={styles.code}>
        {pairingCode}
      </Text>
      <Text variant="bodyMedium" style={styles.centeredText}>
        Scan this on the parent's phone, or enter the code by hand.
      </Text>

      <View style={styles.meterSection}>
        <Text variant="labelLarge">{gateOpen ? 'Streaming' : 'Quiet'}</Text>
        <ProgressBar progress={levelDb === null ? 0 : levelToFraction(levelDb)} style={styles.meter} />
        <Text variant="bodySmall">
          {!isReady
            ? 'Requesting microphone…'
            : reconnecting !== null
              ? `Reconnecting to relay (attempt ${reconnecting})…`
              : listenerCount === 0
                ? 'No one listening yet'
                : `${listenerCount} ${listenerCount === 1 ? 'listener' : 'listeners'} connected`}
        </Text>
      </View>

      <Button mode="outlined" onPress={() => navigation.goBack()} style={styles.button}>
        Stop monitoring
      </Button>
    </View>
  );
}
```
with:
```ts
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        This device is the monitor
      </Text>

      {listenerCount > 0 && (
        <View style={[styles.connectedBanner, { backgroundColor: theme.colors.primaryContainer }]}>
          <Text variant="titleMedium">
            ● Connected — {listenerCount} {listenerCount === 1 ? 'listener' : 'listeners'}
          </Text>
        </View>
      )}

      {inviteCode !== null ? (
        <>
          <View style={styles.qrWrap}>
            <QRCode value={pairingUri(inviteCode, relayUrl)} size={200} />
          </View>
          <Text variant="headlineMedium" style={styles.code}>
            {inviteCode}
          </Text>
          <Text variant="bodyMedium" style={styles.centeredText}>
            Scan this on the parent's phone, or enter the code by hand. Expires in {secondsLeft ?? 0}s.
          </Text>
        </>
      ) : (
        <>
          <Text variant="bodyMedium" style={styles.centeredText}>
            Pairing closed — a new device can't join until you show a code again.
          </Text>
          <Button mode="contained" onPress={() => sessionRef.current?.rearmInvite()} style={styles.button}>
            Show pairing code
          </Button>
        </>
      )}

      <View style={styles.meterSection}>
        <Text variant="labelLarge">{gateOpen ? 'Streaming' : 'Quiet'}</Text>
        <ProgressBar progress={levelDb === null ? 0 : levelToFraction(levelDb)} style={styles.meter} />
        <Text variant="bodySmall">
          {!isReady
            ? 'Requesting microphone…'
            : reconnecting !== null
              ? `Reconnecting to relay (attempt ${reconnecting})…`
              : listenerCount === 0
                ? 'No one listening yet'
                : 'Streaming to every connected listener'}
        </Text>
      </View>

      <Button mode="outlined" onPress={() => navigation.goBack()} style={styles.button}>
        Stop monitoring
      </Button>
    </View>
  );
}
```

- [ ] **Step 5: Add the `connectedBanner` style**

Replace:
```ts
const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, alignItems: 'center' },
  centered: { justifyContent: 'center' },
  centeredText: { textAlign: 'center', marginBottom: 16 },
  title: { marginBottom: 16, textAlign: 'center' },
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 16 },
  code: { letterSpacing: 4, marginBottom: 8 },
  meterSection: { width: '100%', marginTop: 24, alignItems: 'center', gap: 8 },
  meter: { width: '100%', height: 12, borderRadius: 6 },
  button: { marginTop: 24 },
});
```
with:
```ts
const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, alignItems: 'center' },
  centered: { justifyContent: 'center' },
  centeredText: { textAlign: 'center', marginBottom: 16 },
  title: { marginBottom: 16, textAlign: 'center' },
  connectedBanner: { width: '100%', padding: 12, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 16 },
  code: { letterSpacing: 4, marginBottom: 8 },
  meterSection: { width: '100%', marginTop: 24, alignItems: 'center', gap: 8 },
  meter: { width: '100%', height: 12, borderRadius: 6 },
  button: { marginTop: 24 },
});
```

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: errors remain only in `src/screens/AddMonitor.tsx`, `src/screens/Parent.tsx`,
`src/webrtc/parentSession.ts` (Tasks 7-9). Confirm `src/screens/Monitor.tsx` itself is
clean.

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```
Expected: all existing tests still pass (no `Monitor.test.tsx` exists today, so this
task's own correctness rests on typecheck plus the manual test in Task 10).

- [ ] **Step 8: Commit**

```bash
git add src/screens/Monitor.tsx
git commit -m "screens: Monitor shows a time-boxed, re-armable pairing code

Replaces the persisted, indefinitely-stable pairing code with
MonitorSession's rotating one: a countdown while the invite window is
open, 'Pairing closed' plus a re-arm button once it lapses. The
listener-count banner is now independent of window state — already-
connected listeners are unaffected by the code expiring."
```

---

## Task 7: `ParentSession` — learn and forward the resolved room

**Files:**
- Modify: `src/webrtc/parentSession.ts`

**Interfaces:**
- Consumes: `isInviteCodeSignal` (Task 4), `SignalingClient.onJoined` (Task 3).
- Produces: `ParentSessionOptions.room` (renamed from `pairingCode`),
  `ParentSessionEvents.onRoomResolved?: (room: string) => void`,
  `ParentSessionEvents.onInviteCode?: (code: string | null) => void`. Consumed by Task
  9 (`Parent.tsx`).

No automated test for this file, same reason as Task 5 (untested today, native
`RTCPeerConnection`/`getUserMedia`, no mock in this project's Jest config). Verified by
typecheck plus the manual multi-device test in Task 10.

- [ ] **Step 1: Rename the room option**

Replace:
```ts
export interface ParentSessionOptions {
  signalingUrl: string;
  pairingCode: string;
  /** This install's persistent device identifier — see src/domain/deviceId.ts. Lets the Monitor recognize a reconnect versus a new device. */
  deviceId: string;
  iceServers?: RTCIceServer[];
}
```
with:
```ts
export interface ParentSessionOptions {
  signalingUrl: string;
  /** The relay room to join — either a still-live rotating pairing code (first-time pairing) or a Monitor's stable, persistent roomId (every reconnect after that). ParentSession treats both identically; only the caller knows which kind of value this is. */
  room: string;
  /** This install's persistent device identifier — see src/domain/deviceId.ts. Lets the Monitor recognize a reconnect versus a new device. */
  deviceId: string;
  iceServers?: RTCIceServer[];
}
```

- [ ] **Step 2: Add the new events**

Replace:
```ts
  /** Fires when the Monitor rejects this device — not yet authorized, and invite mode wasn't open at the time. Retrying later (e.g. once someone opens invite mode) can still succeed. */
  onRejected?: (reason: string) => void;
}
```
with:
```ts
  /** Fires when the Monitor rejects this device — not yet authorized, and invite mode wasn't open at the time. Retrying later (e.g. once someone opens invite mode) can still succeed. */
  onRejected?: (reason: string) => void;
  /** Fires on every successful join (initial and each reconnect) with the room the relay actually resolved `options.room` to — this is how a Parent learns the Monitor's stable roomId, whether `options.room` was a live alias or already the real thing. */
  onRoomResolved?: (room: string) => void;
  /** Fires when the Monitor sends the currently-live pairing code after this Parent asked to invite a listener (see `setInviteMode`) — null means the invite window closed. */
  onInviteCode?: (code: string | null) => void;
}
```

- [ ] **Step 3: Update the import and `start()`/`setInviteMode`**

Replace:
```ts
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
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
  isRejectedSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
```

Replace:
```ts
  async start(): Promise<void> {
    this.setupPeerConnection();
    await this.signaling.connect(
      this.options.pairingCode,
      'parent',
      {
        onPeerLeft: () => this.teardownPeerConnection(),
        onSignal: (payload) => {
          this.handleSignal(payload).catch(() => {});
        },
        onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
        onReconnected: () => this.events.onSignalingReconnected?.(),
        onError: (message) => this.events.onError?.(message),
      },
      this.options.deviceId,
    );
  }
```
with:
```ts
  async start(): Promise<void> {
    this.setupPeerConnection();
    await this.signaling.connect(
      this.options.room,
      'parent',
      {
        onPeerLeft: () => this.teardownPeerConnection(),
        onSignal: (payload) => {
          this.handleSignal(payload).catch(() => {});
        },
        onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
        onReconnected: () => this.events.onSignalingReconnected?.(),
        onError: (message) => this.events.onError?.(message),
        onJoined: (room) => {
          if (room !== undefined) this.events.onRoomResolved?.(room);
        },
      },
      this.options.deviceId,
    );
  }
```

- [ ] **Step 4: Update `handleSignal`**

Replace:
```ts
  private async handleSignal(payload: unknown): Promise<void> {
    if (isRejectedSignal(payload)) {
      this.events.onRejected?.(payload.reason);
      return;
    }
    const pc = this.pc ?? this.setupPeerConnection();
    if (isSdpSignal(payload)) {
      await handleIncomingSdp(pc, payload.sdp, this.iceQueue, (p) => this.signaling.sendSignal(p));
    } else if (isCandidateSignal(payload)) {
      await this.iceQueue.add(pc, payload.candidate);
    }
  }
```
with:
```ts
  private async handleSignal(payload: unknown): Promise<void> {
    if (isRejectedSignal(payload)) {
      this.events.onRejected?.(payload.reason);
      return;
    }
    if (isInviteCodeSignal(payload)) {
      this.events.onInviteCode?.(payload.inviteCode);
      return;
    }
    const pc = this.pc ?? this.setupPeerConnection();
    if (isSdpSignal(payload)) {
      await handleIncomingSdp(pc, payload.sdp, this.iceQueue, (p) => this.signaling.sendSignal(p));
    } else if (isCandidateSignal(payload)) {
      await this.iceQueue.add(pc, payload.candidate);
    }
  }
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: errors remain only in `src/screens/AddMonitor.tsx`/`src/screens/Parent.tsx`
(Tasks 8-9, still using the old `pairingCode` option name and old QR-display logic).
Confirm `src/webrtc/parentSession.ts` itself is clean.

- [ ] **Step 6: Commit**

```bash
git add src/webrtc/parentSession.ts
git commit -m "webrtc: ParentSession learns the resolved room, forwards invite codes

options.pairingCode renamed to room (it's used for both a first-time
rotating code and a stable roomId, and ParentSession itself doesn't
care which). onRoomResolved fires from the relay's joined ack on every
successful join; onInviteCode surfaces the Monitor's current code (or
null once it expires) after this Parent asks to invite a listener."
```

---

## Task 8: `AddMonitor.tsx` — stable local `id`, initial `roomId`

**Files:**
- Modify: `src/screens/AddMonitor.tsx`

**Interfaces:**
- Consumes: `PairedMonitor.roomId` (Task 2), reuses `generateDeviceId` (existing,
  `src/domain/deviceId.ts`) for the local record id.

- [ ] **Step 1: Generate a stable local `id` instead of reusing the code**

Replace:
```ts
import { isValidPairingCode, parsePairingUri } from '../domain/pairing';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS, type PairedMonitor } from '../domain/store';
```
with:
```ts
import { generateDeviceId } from '../domain/deviceId';
import { isValidPairingCode, parsePairingUri } from '../domain/pairing';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS, type PairedMonitor } from '../domain/store';
```

Replace:
```ts
  const pairWith = React.useCallback(
    async (code: string, relayUrl: string, label: string) => {
      const existingRelay = await store.getSetting(SETTINGS_KEYS.signalingServerUrl);
      if (!existingRelay) {
        await store.setSetting(SETTINGS_KEYS.signalingServerUrl, relayUrl);
      }
      const monitor: PairedMonitor = {
        id: code,
        label,
        lastPairingCode: code,
        addedAt: formatTimestamp(new Date()),
      };
      await store.addMonitor(monitor);
      bump();
      navigation.replace('Parent', { monitorId: monitor.id });
    },
    [store, bump, navigation],
  );
```
with:
```ts
  const pairWith = React.useCallback(
    async (code: string, relayUrl: string, label: string) => {
      const existingRelay = await store.getSetting(SETTINGS_KEYS.signalingServerUrl);
      if (!existingRelay) {
        await store.setSetting(SETTINGS_KEYS.signalingServerUrl, relayUrl);
      }
      const monitor: PairedMonitor = {
        // A fresh, stable local id — no longer the pairing code, which now
        // rotates and can't identify anything durably. roomId starts as the
        // scanned code (what we're about to try connecting to); Parent.tsx
        // updates it in place once the relay's joined ack reports the real,
        // stable room this resolved to.
        id: generateDeviceId(),
        label,
        roomId: code,
        addedAt: formatTimestamp(new Date()),
      };
      await store.addMonitor(monitor);
      bump();
      navigation.replace('Parent', { monitorId: monitor.id });
    },
    [store, bump, navigation],
  );
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: errors remain only in `src/screens/Parent.tsx` (Task 9). Confirm
`src/screens/AddMonitor.tsx` itself is clean.

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```
Expected: all existing tests still pass (no `AddMonitor.test.tsx` exists today).

- [ ] **Step 4: Commit**

```bash
git add src/screens/AddMonitor.tsx
git commit -m "screens: AddMonitor generates a stable id instead of reusing the code

PairedMonitor.id can no longer be the pairing code now that it
rotates. roomId is seeded with the scanned code (the first thing
Parent.tsx will try connecting to) and gets corrected to the real,
stable value once the relay's joined ack reports it."
```

---

## Task 9: `Parent.tsx` — persist the resolved room, display Monitor-issued invite codes

**Files:**
- Modify: `src/screens/Parent.tsx`

**Interfaces:**
- Consumes: `PairedMonitor.roomId` (Task 2), `ParentSession.options.room`/
  `onRoomResolved`/`onInviteCode` (Task 7).

- [ ] **Step 1: Rename the connect option and persist the resolved room**

Replace:
```ts
        const session = new ParentSession(
          { signalingUrl: resolvedRelayUrl, pairingCode: monitor.lastPairingCode, deviceId },
          {
            onConnectionStateChange: (state) => {
              setConnectionState(state);
              if (state === 'connected') {
                clearTimeout(timeoutId);
                setConnectTimedOut(false);
                wasConnectedRef.current = true;
              } else if ((state === 'disconnected' || state === 'failed') && wasConnectedRef.current) {
                wasConnectedRef.current = false;
                fireConnectionLostAlert(monitor.label).catch(() => {});
                logEvent('disconnected').catch(() => {});
              }
            },
            onSignalingReconnecting: (attempt) => setReconnecting(attempt),
            onSignalingReconnected: () => setReconnecting(null),
            onError: () => setConnectionState('failed'),
            onRejected: (reason) => setRejected(reason),
          },
        );
```
with:
```ts
        const session = new ParentSession(
          { signalingUrl: resolvedRelayUrl, room: monitor.roomId, deviceId },
          {
            onConnectionStateChange: (state) => {
              setConnectionState(state);
              if (state === 'connected') {
                clearTimeout(timeoutId);
                setConnectTimedOut(false);
                wasConnectedRef.current = true;
              } else if ((state === 'disconnected' || state === 'failed') && wasConnectedRef.current) {
                wasConnectedRef.current = false;
                fireConnectionLostAlert(monitor.label).catch(() => {});
                logEvent('disconnected').catch(() => {});
              }
            },
            onSignalingReconnecting: (attempt) => setReconnecting(attempt),
            onSignalingReconnected: () => setReconnecting(null),
            onError: () => setConnectionState('failed'),
            onRejected: (reason) => setRejected(reason),
            onRoomResolved: (room) => {
              // Persisted only — not reflected into local `monitor` state,
              // so this doesn't retrigger the connect effect (`monitor` is
              // one of its deps) for a connection that's already live and
              // already correct. Only affects the *next* time this screen
              // mounts fresh.
              if (room !== monitor.roomId) {
                store.addMonitor({ ...monitor, roomId: room }).catch(() => {});
              }
            },
            onInviteCode: (code) => setInviteCode(code),
          },
        );
```

- [ ] **Step 2: Add `inviteCode` state, replacing the stored-code-based invite display**

Replace:
```ts
  const [connectTimedOut, setConnectTimedOut] = React.useState(false);
  const [rejected, setRejected] = React.useState<string | null>(null);
  const [invitingListener, setInvitingListener] = React.useState(false);
  const [relayUrl, setRelayUrl] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
```
with:
```ts
  const [connectTimedOut, setConnectTimedOut] = React.useState(false);
  const [rejected, setRejected] = React.useState<string | null>(null);
  const [invitingListener, setInvitingListener] = React.useState(false);
  const [inviteCode, setInviteCode] = React.useState<string | null>(null);
  const [relayUrl, setRelayUrl] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
```

- [ ] **Step 3: Update the invite button and QR display**

Replace:
```ts
      <Button
        mode={invitingListener ? 'contained' : 'outlined'}
        icon="account-plus-outline"
        onPress={() => {
          const next = !invitingListener;
          setInvitingListener(next);
          sessionRef.current?.setInviteMode(next);
        }}
        style={styles.talkButton}
      >
        {invitingListener ? 'Stop inviting' : 'Invite a listener'}
      </Button>

      {invitingListener && (
        <View style={styles.qrWrap}>
          <QRCode value={pairingUri(monitor.lastPairingCode, relayUrl ?? '')} size={200} />
          <Text variant="headlineMedium" style={styles.code}>
            {monitor.lastPairingCode}
          </Text>
        </View>
      )}
```
with:
```ts
      <Button
        mode={invitingListener ? 'contained' : 'outlined'}
        icon="account-plus-outline"
        onPress={() => {
          const next = !invitingListener;
          setInvitingListener(next);
          if (!next) setInviteCode(null);
          sessionRef.current?.setInviteMode(next);
        }}
        style={styles.talkButton}
      >
        {invitingListener ? 'Stop inviting' : 'Invite a listener'}
      </Button>

      {invitingListener && inviteCode !== null && (
        <View style={styles.qrWrap}>
          <QRCode value={pairingUri(inviteCode, relayUrl ?? '')} size={200} />
          <Text variant="headlineMedium" style={styles.code}>
            {inviteCode}
          </Text>
        </View>
      )}
      {invitingListener && inviteCode === null && (
        <Text variant="bodyMedium" style={styles.centeredText}>
          Asking the monitor for a code…
        </Text>
      )}
```

(`inviteCode` is Monitor-issued and Monitor-owned end to end — this screen never
generates one itself, and `onInviteCode` firing with `null` after the Monitor's window
lapses naturally falls back to the "Asking the monitor for a code…" branch, matching
the spec's "Parent.tsx displays whatever it's told" behavior without needing its own
separate "expired" state.)

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```
Expected: no errors anywhere in the project. This is the last task touching a screen
that referenced the old field/option names.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```
Expected: all existing tests pass (no `Parent.test.tsx` exists today).

- [ ] **Step 6: Commit**

```bash
git add src/screens/Parent.tsx
git commit -m "screens: Parent persists the resolved room, shows Monitor-issued codes

room replaces pairingCode in the ParentSession options (now the
persisted roomId, correct from the very first connect since
AddMonitor seeds it with the scanned code). onRoomResolved corrects
the stored value in place if the relay resolved to something
different, without touching local state or retriggering a live
connection. The invite-a-listener QR/code now comes entirely from the
Monitor via onInviteCode - this screen never generates one itself."
```

---

## Task 10: Manual multi-device verification, full check, release

**Files:** none (verification only — no automated test exercises the real rotating-code
+ alias-resolution + WebRTC path end to end, same posture this project already takes
for `MonitorSession`/`ParentSession`; see Tasks 5/7's own notes).

- [ ] **Step 1: Build and install the debug dev client**

```bash
cd android && ./gradlew assembleDebug
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
```
Repeat the install on every connected device. `tools/test-parent.html` (added earlier
this session) can stand in for extra Parent phones if fewer than three physical devices
are available — it speaks the same relay protocol, including the new `set-alias`
message if it's updated to send it... **note:** `tools/test-parent.html` acts as a
Parent, which never sends `set-alias` (Monitor-only) — no change needed there for this
plan; it already handles `joined`'s new optional `room` field gracefully (JSON messages
with unrecognized extra fields don't break its handlers).

- [ ] **Step 2: Verify the basic pairing flow still works, now via the alias**

Phone A: "Use this device as a monitor" — confirm a code with a visible countdown
appears immediately. Phone B: "Add a monitor", scan/enter the code. Confirm B connects
and A's listener-count banner appears ("Connected — 1 listener").

- [ ] **Step 3: Verify the window auto-closes and re-arms**

Leave Phone A's Monitor screen open with no one connecting. Confirm the code and QR
disappear at ~60s, replaced by "Pairing closed" and a "Show pairing code" button.
Confirm tapping it shows a **different** code than before, with a fresh countdown.

- [ ] **Step 4: Verify a device authorized right at the edge of the window isn't
  disconnected by the window closing**

Time Phone B's connection attempt to land in roughly the last few seconds of Phone A's
countdown. Confirm B's connection completes and stays up even after the window visibly
closes on Phone A (the connected-listener banner and B's live audio must be unaffected —
only the *discovery* path is time-boxed, never an established peer connection).

- [ ] **Step 5: Verify reconnect still works with the window closed and no code
  visible**

With B already authorized (from Step 2), force-stop and reopen B's app while A's window
is closed (no code showing). Confirm B reconnects successfully with zero code/QR
involved on either device.

- [ ] **Step 6: Verify a genuinely new device is rejected outside the window, then let
  in once invited**

With A's window closed, have Phone C (or a `tools/test-parent.html` tab with a fresh
`deviceId`, via its "New device" button) attempt to join using the last code A showed.
Confirm the join is indistinguishable from a wrong code (C just sits there, eventually
times out — matching the relay's "unknown alias" behavior from Task 1). Then tap "Show
pairing code" on A, retry C with the **new** code. Confirm C connects and A's listener
count reaches 2.

- [ ] **Step 7: Verify inviting via an already-connected Parent**

With A's window closed and B still connected, tap "Invite a listener" on B. Confirm B
shows "Asking the monitor for a code…" briefly, then a code/QR (either a freshly-armed
one, or — if A's window happened to still be open from Step 6 — the *same* one A is
showing, not a different one). Have a fourth device (or C, if its authorization was
cleared) join using B's displayed code; confirm it's let in. Confirm turning B's invite
off doesn't affect A's or C's connections.

- [ ] **Step 8: Verify a remote holder is told when the shared window expires**

With B's "Invite a listener" toggled on and no one else joining, wait out the full
window. Confirm B's own invite display updates to reflect the closed window (falls back
to "Asking the monitor for a code…", or however Step 3's `onInviteCode(null)` path
renders) rather than continuing to show a dead code indefinitely.

- [ ] **Step 9: Final full check**

```bash
make check
```
Expected: typecheck and the full Jest suite (both `logic`/`screens` app projects and
`signal-server`'s own suite) pass clean.

- [ ] **Step 10: Push and cut a new beta**

```bash
git push origin main
```
Follow this repo's existing release process (`make prepare-release
TAG=v1.0.0-beta.N CHANGELOG=...`, tag, push) once every manual verification step above
has passed on real devices — do not cut a release before that, since this feature has
no automated coverage for the actual alias-resolution-plus-multi-peer-WebRTC path end
to end.
