# Multi-listener support with invite-gated pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let more than one Parent listen to a Monitor simultaneously, and make new-device pairing time-boxed to when someone already inside (the Monitor, or an already-authorized Parent) is actively holding an invite screen open — instead of the persisted pairing code being a standing secret good forever.

**Architecture:** The relay (`signal-server`) gains a `deviceId`-addressed, multi-parent room model but stays fully stateless and decision-blind — it lets any well-formed join succeed and tells the Monitor who joined, never deciding who's *allowed*. All authorization lives client-side on the Monitor: a new pure `InviteMode`/`decideListener` domain module (open/closed holders, accept/reject decision) backed by a new local SQLite table of previously-authorized `deviceId`s. `MonitorSession` moves from one `RTCPeerConnection` to a `Map<deviceId, RTCPeerConnection>`, all sharing one mic track. `ParentSession` gains a persistent local `deviceId`, handles an explicit rejection signal, and can itself open/close invite mode.

**Tech Stack:** TypeScript, `ws` (signal-server), `react-native-webrtc`, `expo-sqlite`/`node:sqlite`, Jest (two projects: plain-node `logic`, RN `screens`).

**Spec:** `docs/superpowers/specs/2026-09-24-multi-listener-invite-gated-pairing-design.md`

## Global Constraints

- The relay never persists anything beyond an open room's in-memory state, and never makes an authorization decision — copied verbatim from the spec's "Why authorization stays client-side" section. No task may add a database, file, or other persistence to `signal-server`.
- An already-authorized `deviceId` can always reconnect, any time, regardless of invite-mode state — this is the invariant fixed earlier today (persisted `SETTINGS_KEYS.monitorPairingCode`) and this feature must not regress it.
- `InviteMode` tracks holders as a `Set<string>`, never a boolean — one holder closing its own invite must never close another holder's still-open one.
- New Store methods reject with an `Error` on failure rather than throwing synchronously, matching every existing `Store` method (see `src/domain/store.ts`'s interface doc comment).

## Review Focus

- **A `deviceId` reconnecting while its old socket is still technically open** (not yet closed by the network) — the relay must not let closing the old socket wipe out the new one's room membership. Task 1's reconnect test pins this.
- **A rejected Parent retrying immediately** — must get rejected again, not locked out entirely, not accidentally let in. Task 7's/manual-test coverage.
- **An unauthorized `deviceId` sending an `inviteMode` signal** to try to open the door for itself — must be ignored; only an already-connected (and therefore already-authorized) peer's invite toggle counts. Task 7 pins this via `decideListener`/`InviteMode` plus an explicit MonitorSession guard.
- **The Monitor's own screen and a Parent's invite screen closing in either order** — invite mode must stay open until *both* close, not just whichever closes second. Task 2's `InviteMode` tests pin this directly.
- **A signal message from the Monitor missing `to`** (a Monitor-side bug, not a client mistake to silently swallow) — must be a loud `invalid-message` error, not a silently dropped message. Task 1 pins this.

---

## Task 1: Relay — device identity + multi-parent rooms

**Files:**
- Modify: `signal-server/src/protocol.ts`
- Modify: `signal-server/src/server.ts`
- Modify: `signal-server/src/server.test.ts`

**Interfaces:**
- Produces: `JoinMessage.deviceId?: string`, `SignalMessage.to?: string` (client→server), `PeerJoinedMessage.deviceId?: string`, `PeerLeftMessage.deviceId?: string`, server-sent `SignalMessage` gains `from?: string`. All consumed by Task 5 (`SignalingClient`).

- [ ] **Step 1: Update `protocol.ts`'s types and `isClientMessage`**

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

export type ClientMessage = JoinMessage | SignalMessage;

export interface JoinedMessage {
  type: 'joined';
  role: Role;
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
  return false;
}
```

- [ ] **Step 2: Rewrite `server.ts`'s room model and message handling**

Replace the whole file:

```ts
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { isClientMessage, type ErrorReason, type Role, type ServerMessage } from './protocol';

/**
 * A room holds at most one Monitor and any number of Parents, each keyed by
 * deviceId. Rooms with no occupants left are deleted, so memory never grows
 * with churn.
 */
interface Room {
  monitor?: WebSocket;
  parents: Map<string, WebSocket>;
}

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

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function closeWithError(socket: WebSocket, message: ErrorReason): void {
  send(socket, { type: 'error', message });
  socket.close();
}

/** A fixed-window join-attempt counter per remote address. Resets once `windowMs` has elapsed since the window started. */
class JoinRateLimiter {
  private readonly windows = new Map<string, { count: number; windowStartMs: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records one join attempt from `address`; returns false once `address` has exceeded its budget for the current window. */
  attempt(address: string): boolean {
    const now = Date.now();
    const entry = this.windows.get(address);
    if (entry === undefined || now - entry.windowStartMs >= this.windowMs) {
      this.windows.set(address, { count: 1, windowStartMs: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }
}

/**
 * attachSignalingServer wires the relay's room logic onto a `ws` server.
 * Exported separately from `main` so tests can attach it to an ephemeral
 * port instead of whatever PORT the process would otherwise bind, and so
 * they can pass short TTL/rate-limit values instead of the production
 * defaults.
 */
export function attachSignalingServer(wss: WebSocketServer, options: SignalingServerOptions = {}): void {
  const roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
  const rateLimiter = new JoinRateLimiter(
    options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX,
    options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  );

  const rooms = new Map<string, Room>();
  const roomTimers = new Map<string, NodeJS.Timeout>();
  // Sockets that have been replaced by a same-deviceId reconnect before
  // they finished closing on their own — their close handler must not run
  // the normal room-cleanup logic, or it would delete the *new* socket's
  // room membership out from under it (both entries live under the same
  // deviceId key; the close handler only knows "my deviceId", not "am I
  // still the current socket for it").
  const supersededSockets = new WeakSet<WebSocket>();

  function clearRoomTimer(roomName: string): void {
    const timer = roomTimers.get(roomName);
    if (timer !== undefined) {
      clearTimeout(timer);
      roomTimers.delete(roomName);
    }
  }

  function occupants(room: Room): WebSocket[] {
    const list = [...room.parents.values()];
    if (room.monitor !== undefined) list.push(room.monitor);
    return list;
  }

  /** Called whenever a room's occupancy might have changed — arms the TTL only when exactly one side (Monitor alone, or Parent(s) alone) is present; disarms it once both sides are present or the room is empty (empty rooms are deleted outright, not timed). */
  function rearmRoomTimer(roomName: string, room: Room): void {
    clearRoomTimer(roomName);
    const hasMonitor = room.monitor !== undefined;
    const hasAnyParent = room.parents.size > 0;
    if (hasMonitor === hasAnyParent) return; // both present (matched) or both absent (empty)

    const timer = setTimeout(() => {
      roomTimers.delete(roomName);
      const current = rooms.get(roomName);
      if (current === undefined) return;
      for (const socket of occupants(current)) {
        closeWithError(socket, 'room-expired');
      }
      rooms.delete(roomName);
    }, roomTtlMs);
    // A lone side's TTL timer must never keep the process alive on its own.
    timer.unref?.();
    roomTimers.set(roomName, timer);
  }

  wss.on('connection', (socket, request: IncomingMessage) => {
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    let joinedRoom: string | null = null;
    let joinedRole: Role | null = null;
    let joinedDeviceId: string | null = null;

    socket.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        closeWithError(socket, 'invalid-message');
        return;
      }
      if (!isClientMessage(parsed)) {
        closeWithError(socket, 'invalid-message');
        return;
      }

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

      // type === 'signal'
      if (joinedRoom === null || joinedRole === null) {
        closeWithError(socket, 'must-join-first');
        return;
      }
      const room = rooms.get(joinedRoom);
      if (room === undefined) return;

      if (joinedRole === 'monitor') {
        if (parsed.to === undefined) {
          closeWithError(socket, 'invalid-message');
          return;
        }
        const target = room.parents.get(parsed.to);
        if (target !== undefined) {
          send(target, { type: 'signal', payload: parsed.payload });
        }
        return;
      }

      // joinedRole === 'parent': the only possible recipient is the Monitor.
      if (room.monitor !== undefined) {
        send(room.monitor, { type: 'signal', payload: parsed.payload, from: joinedDeviceId as string });
      }
    });

    socket.on('close', () => {
      if (supersededSockets.has(socket)) return;
      if (joinedRoom === null || joinedRole === null) return;
      const room = rooms.get(joinedRoom);
      if (room === undefined) return;

      if (joinedRole === 'monitor') {
        delete room.monitor;
        for (const parentSocket of room.parents.values()) {
          send(parentSocket, { type: 'peer-left' });
        }
      } else {
        const deviceId = joinedDeviceId as string;
        // Guard against the same reconnect race from this direction too: if
        // a newer socket already took over this deviceId, this stale
        // close must not delete its (unrelated) current entry.
        if (room.parents.get(deviceId) === socket) {
          room.parents.delete(deviceId);
          if (room.monitor !== undefined) {
            send(room.monitor, { type: 'peer-left', deviceId });
          }
        }
      }

      if (room.monitor === undefined && room.parents.size === 0) {
        clearRoomTimer(joinedRoom);
        rooms.delete(joinedRoom);
      } else {
        rearmRoomTimer(joinedRoom, room);
      }
    });
  });
}

/** Only runs when this file is executed directly (`npm start`), not when imported by tests. */
if (require.main === module) {
  const port = Number(process.env.PORT ?? 8787);
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  attachSignalingServer(wss);
  httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`wewe-signal-server listening on :${port}`);
  });
}
```

- [ ] **Step 3: Update existing tests for the new `deviceId`-bearing messages**

Every existing `role: 'parent'` join in `server.test.ts` needs a `deviceId`, and every `peer-joined`/`peer-left` the Monitor receives now carries one. Apply these exact replacements (each `old_string` is unique in the file):

Replace:
```ts
  test('the second peer to join notifies both sides', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next(); // joined

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent' });

    await expect(parent.next()).resolves.toEqual({ type: 'joined', role: 'parent' });
    await expect(parent.next()).resolves.toEqual({ type: 'peer-joined' });
    await expect(monitor.next()).resolves.toEqual({ type: 'peer-joined' });

    await monitor.close();
    await parent.close();
  });
```
with:
```ts
  test('the second peer to join notifies both sides', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next(); // joined

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });

    await expect(parent.next()).resolves.toEqual({ type: 'joined', role: 'parent' });
    await expect(parent.next()).resolves.toEqual({ type: 'peer-joined' });
    await expect(monitor.next()).resolves.toEqual({ type: 'peer-joined', deviceId: 'dev-1' });

    await monitor.close();
    await parent.close();
  });
```

Replace:
```ts
  test('signal messages are relayed to the other role only, verbatim', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent' });
    await parent.next(); // joined
    await monitor.next(); // peer-joined
    await parent.next(); // peer-joined

    monitor.send({ type: 'signal', payload: { sdp: 'offer-blob' } });
    await expect(parent.next()).resolves.toEqual({ type: 'signal', payload: { sdp: 'offer-blob' } });

    await monitor.close();
    await parent.close();
  });
```
with:
```ts
  test('signal messages are relayed to the targeted parent, verbatim', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });
    await parent.next(); // joined
    await monitor.next(); // peer-joined
    await parent.next(); // peer-joined

    monitor.send({ type: 'signal', payload: { sdp: 'offer-blob' }, to: 'dev-1' });
    await expect(parent.next()).resolves.toEqual({ type: 'signal', payload: { sdp: 'offer-blob' } });

    await monitor.close();
    await parent.close();
  });

  test('a signal from the parent arrives at the monitor tagged with its deviceId', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });
    await parent.next();
    await monitor.next(); // peer-joined
    await parent.next(); // peer-joined

    parent.send({ type: 'signal', payload: { sdp: 'answer-blob' } });
    await expect(monitor.next()).resolves.toEqual({ type: 'signal', payload: { sdp: 'answer-blob' }, from: 'dev-1' });

    await monitor.close();
    await parent.close();
  });

  test('a signal from the monitor missing "to" is rejected', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    monitor.send({ type: 'signal', payload: { sdp: 'x' } });
    await expect(monitor.next()).resolves.toEqual({ type: 'error', message: 'invalid-message' });
  });
```

Replace:
```ts
  test('a second socket claiming an already-taken role is rejected', async () => {
    const monitor1 = await TestClient.connect(server.url);
    monitor1.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor1.next();

    const monitor2 = await TestClient.connect(server.url);
    monitor2.send({ type: 'join', room: 'r1', role: 'monitor' });
    await expect(monitor2.next()).resolves.toEqual({ type: 'error', message: 'role-taken' });

    await monitor1.close();
  });
```
with:
```ts
  test('a second monitor joining an already-occupied room is rejected', async () => {
    const monitor1 = await TestClient.connect(server.url);
    monitor1.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor1.next();

    const monitor2 = await TestClient.connect(server.url);
    monitor2.send({ type: 'join', room: 'r1', role: 'monitor' });
    await expect(monitor2.next()).resolves.toEqual({ type: 'error', message: 'role-taken' });

    await monitor1.close();
  });

  test('a second, different-deviceId parent joins alongside the first — both connected simultaneously', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parentA = await TestClient.connect(server.url);
    parentA.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-a' });
    await parentA.next(); // joined
    await monitor.next(); // peer-joined dev-a
    await parentA.next(); // peer-joined (monitor)

    const parentB = await TestClient.connect(server.url);
    parentB.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-b' });
    await expect(parentB.next()).resolves.toEqual({ type: 'joined', role: 'parent' });
    await expect(parentB.next()).resolves.toEqual({ type: 'peer-joined' });
    await expect(monitor.next()).resolves.toEqual({ type: 'peer-joined', deviceId: 'dev-b' });

    monitor.send({ type: 'signal', payload: 'for-a', to: 'dev-a' });
    monitor.send({ type: 'signal', payload: 'for-b', to: 'dev-b' });
    await expect(parentA.next()).resolves.toEqual({ type: 'signal', payload: 'for-a' });
    await expect(parentB.next()).resolves.toEqual({ type: 'signal', payload: 'for-b' });

    await monitor.close();
    await parentA.close();
    await parentB.close();
  });

  test('a join with the same deviceId as an already-connected parent replaces it silently — no peer-left/peer-joined churn', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parent1 = await TestClient.connect(server.url);
    parent1.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });
    await parent1.next();
    await monitor.next(); // peer-joined dev-1
    await parent1.next(); // peer-joined

    const parent2 = await TestClient.connect(server.url);
    parent2.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });
    await expect(parent2.next()).resolves.toEqual({ type: 'joined', role: 'parent' });
    await expect(parent2.next()).resolves.toEqual({ type: 'peer-joined' });

    // Old socket getting superseded must not tell the monitor peer-left,
    // and no fresh peer-joined for the same deviceId either.
    const gotChurn = await Promise.race([
      monitor.next().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(gotChurn).toBe(false);

    // The new socket, not the old one, is now live for this deviceId.
    monitor.send({ type: 'signal', payload: 'still-here', to: 'dev-1' });
    await expect(parent2.next()).resolves.toEqual({ type: 'signal', payload: 'still-here' });

    await monitor.close();
    await parent1.close();
    await parent2.close();
  });
```

Replace:
```ts
  test('when one peer disconnects, the other is told peer-left', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent' });
    await parent.next();
    await monitor.next(); // peer-joined
    await parent.next(); // peer-joined

    const peerLeft = monitor.next();
    await parent.close();
    await expect(peerLeft).resolves.toEqual({ type: 'peer-left' });

    await monitor.close();
  });
```
with:
```ts
  test('when a parent disconnects, the monitor is told peer-left with its deviceId', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });
    await parent.next();
    await monitor.next(); // peer-joined
    await parent.next(); // peer-joined

    const peerLeft = monitor.next();
    await parent.close();
    await expect(peerLeft).resolves.toEqual({ type: 'peer-left', deviceId: 'dev-1' });

    await monitor.close();
  });

  test('when the monitor disconnects, every parent is told peer-left', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parentA = await TestClient.connect(server.url);
    parentA.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-a' });
    await parentA.next();
    await monitor.next();
    await parentA.next();

    const parentB = await TestClient.connect(server.url);
    parentB.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-b' });
    await parentB.next();
    await monitor.next();
    await parentB.next();

    const leftA = parentA.next();
    const leftB = parentB.next();
    await monitor.close();
    await expect(leftA).resolves.toEqual({ type: 'peer-left' });
    await expect(leftB).resolves.toEqual({ type: 'peer-left' });

    await parentA.close();
    await parentB.close();
  });
```

Replace every remaining bare `{ type: 'join', room: '...', role: 'parent' }` (rate-limit and room-TTL `describe` blocks don't have any — only `monitor` joins appear there, confirm by search) — **search the file for `role: 'parent'` after the edits above and confirm none remain without a `deviceId`.**

- [ ] **Step 4: Run the relay's test suite**

```bash
cd signal-server && npm test
```
Expected: all tests pass, including the new ones.

- [ ] **Step 5: Typecheck the relay**

```bash
cd signal-server && npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add signal-server/src/protocol.ts signal-server/src/server.ts signal-server/src/server.test.ts
git commit -m "signal-server: device identity + multi-parent rooms

Rooms now hold one Monitor and any number of Parents (Map<deviceId,
socket>) instead of exactly one of each. join requires a deviceId for
role: parent; signal messages route by deviceId (to from the Monitor,
from delivered to it). Same-deviceId reconnect replaces the old
socket silently, no peer-left/peer-joined churn. The relay still
decides nothing about who's authorized — it only reports who joined."
```

---

## Task 2: Domain — InviteMode + decideListener

**Files:**
- Create: `src/domain/inviteMode.ts`
- Create: `src/domain/inviteMode.test.ts`

**Interfaces:**
- Produces: `class InviteMode { isOpen: boolean; open(holder: string): void; close(holder: string): void }`, `type ListenerDecision = 'accept-known' | 'accept-new' | 'reject'`, `function decideListener(isAuthorized: boolean, inviteModeOpen: boolean): ListenerDecision`. Consumed by Task 7 (`MonitorSession`).

- [ ] **Step 1: Write the failing tests**

Create `src/domain/inviteMode.test.ts`:

```ts
import { decideListener, InviteMode } from './inviteMode';

describe('InviteMode', () => {
  test('closed with no holders', () => {
    expect(new InviteMode().isOpen).toBe(false);
  });

  test('opening one holder opens it', () => {
    const mode = new InviteMode();
    mode.open('local');
    expect(mode.isOpen).toBe(true);
  });

  test('closing the only holder closes it', () => {
    const mode = new InviteMode();
    mode.open('local');
    mode.close('local');
    expect(mode.isOpen).toBe(false);
  });

  test('one holder closing does not close another still-open holder', () => {
    const mode = new InviteMode();
    mode.open('local');
    mode.open('dev-1');
    mode.close('local');
    expect(mode.isOpen).toBe(true);
    mode.close('dev-1');
    expect(mode.isOpen).toBe(false);
  });

  test('closing a holder that was never open is a no-op, not an error', () => {
    const mode = new InviteMode();
    expect(() => mode.close('dev-1')).not.toThrow();
    expect(mode.isOpen).toBe(false);
  });

  test('opening the same holder twice does not require closing it twice', () => {
    const mode = new InviteMode();
    mode.open('dev-1');
    mode.open('dev-1');
    mode.close('dev-1');
    expect(mode.isOpen).toBe(false);
  });
});

describe('decideListener', () => {
  test('an already-authorized device is accepted regardless of invite mode', () => {
    expect(decideListener(true, false)).toBe('accept-known');
    expect(decideListener(true, true)).toBe('accept-known');
  });

  test('an unauthorized device is accepted-as-new only while invite mode is open', () => {
    expect(decideListener(false, true)).toBe('accept-new');
  });

  test('an unauthorized device is rejected while invite mode is closed', () => {
    expect(decideListener(false, false)).toBe('reject');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest src/domain/inviteMode.test.ts
```
Expected: FAIL — `Cannot find module './inviteMode'`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/inviteMode.ts`:

```ts
/**
 * Tracks who currently holds a Monitor's "invite mode" open — see
 * docs/superpowers/specs/2026-09-24-multi-listener-invite-gated-pairing-design.md.
 * Multiple holders can be open at once: the Monitor's own pairing screen
 * (holder id `'local'`), and/or any number of already-connected, authorized
 * Parents each showing their own invite screen (holder id = that Parent's
 * deviceId). Open iff at least one holder exists.
 *
 * Tracked as a Set, not a boolean, specifically so one holder closing its
 * own invite screen can never incorrectly close another holder's still-open
 * one — that would let a stranger sneak in behind whichever holder happened
 * to be first to close theirs.
 */
export class InviteMode {
  private readonly holders = new Set<string>();

  get isOpen(): boolean {
    return this.holders.size > 0;
  }

  open(holder: string): void {
    this.holders.add(holder);
  }

  close(holder: string): void {
    this.holders.delete(holder);
  }
}

export type ListenerDecision = 'accept-known' | 'accept-new' | 'reject';

/**
 * Decides what MonitorSession should do with a newly-joined peer.
 * 'accept-new' means both "let it in" and "remember it as authorized from
 * now on" — MonitorSession is responsible for actually persisting that via
 * Store.authorizeListener, this function only decides.
 */
export function decideListener(isAuthorized: boolean, inviteModeOpen: boolean): ListenerDecision {
  if (isAuthorized) return 'accept-known';
  if (inviteModeOpen) return 'accept-new';
  return 'reject';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx jest src/domain/inviteMode.test.ts
```
Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/inviteMode.ts src/domain/inviteMode.test.ts
git commit -m "domain: add InviteMode + decideListener

Pure, framework-free logic for the multi-listener invite-gating
decision, extracted so the actual interesting behavior is unit tested
directly rather than only reachable through WebRTC-mocked integration
tests. MonitorSession (a later task) becomes a thin consumer."
```

---

## Task 3: Domain — persistent device identity

**Files:**
- Create: `src/domain/deviceId.ts`
- Create: `src/domain/deviceId.test.ts`
- Modify: `src/domain/store.ts`

**Interfaces:**
- Consumes: `Store.getSetting`/`setSetting` (existing).
- Produces: `function generateDeviceId(randomInt?: (maxExclusive: number) => number): string`, `function getOrCreateDeviceId(store: Store): Promise<string>`, `SETTINGS_KEYS.deviceId: 'deviceId'`. Consumed by Task 8 (`ParentSession`)/Task 10 (`Parent.tsx`).

- [ ] **Step 1: Add the new settings key**

In `src/domain/store.ts`, replace:
```ts
export const SETTINGS_KEYS = {
  signalingServerUrl: 'signalingServerUrl',
  noiseGateSensitivity: 'noiseGateSensitivity',
  monitorPairingCode: 'monitorPairingCode',
} as const;
```
with:
```ts
export const SETTINGS_KEYS = {
  signalingServerUrl: 'signalingServerUrl',
  noiseGateSensitivity: 'noiseGateSensitivity',
  monitorPairingCode: 'monitorPairingCode',
  deviceId: 'deviceId',
} as const;
```

- [ ] **Step 2: Write the failing tests**

Create `src/domain/deviceId.test.ts`:

```ts
import { generateDeviceId, getOrCreateDeviceId } from './deviceId';
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

describe('generateDeviceId', () => {
  test('produces a 32-character lowercase hex string with the default RNG', () => {
    expect(generateDeviceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  test('is deterministic under an injected RNG, matching generatePairingCode\'s pattern', () => {
    let calls = 0;
    const fixed = () => {
      calls += 1;
      return 0;
    };
    expect(generateDeviceId(fixed)).toBe('0'.repeat(32));
    expect(calls).toBe(16);
  });
});

describe('getOrCreateDeviceId', () => {
  test('generates and persists one on first use', async () => {
    const store = fakeStore();
    const id = await getOrCreateDeviceId(store);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await expect(store.getSetting(SETTINGS_KEYS.deviceId)).resolves.toBe(id);
  });

  test('returns the same id on every subsequent call', async () => {
    const store = fakeStore();
    const first = await getOrCreateDeviceId(store);
    const second = await getOrCreateDeviceId(store);
    expect(second).toBe(first);
  });

  test('returns an already-persisted id without generating a new one', async () => {
    const store = fakeStore({ [SETTINGS_KEYS.deviceId]: 'existing-id' });
    await expect(getOrCreateDeviceId(store)).resolves.toBe('existing-id');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx jest src/domain/deviceId.test.ts
```
Expected: FAIL — `Cannot find module './deviceId'`.

- [ ] **Step 4: Write the implementation**

Create `src/domain/deviceId.ts`:

```ts
import { SETTINGS_KEYS, type Store } from './store';

const DEVICE_ID_BYTES = 16; // 128 bits — see the module doc for why Math.random-grade randomness is fine here.

/** Uniform integer in [0, maxExclusive), using the platform's default RNG — same injection pattern as pairing.ts's generatePairingCode. */
function defaultRandomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/**
 * Generates a fresh, opaque device identifier. Not a bearer secret: a
 * Monitor only ever recognizes a deviceId it already authorized (see
 * Store.isListenerAuthorized), which itself requires having connected
 * while invite mode was open at least once — this token's only job is
 * letting the Monitor tell "the same device as before" apart from "a
 * stranger presenting the pairing code for the first time". That's why
 * Math.random (injectable, same pattern as generatePairingCode) is
 * sufficient — unlike the pairing code itself, this isn't the thing
 * standing between a stranger and access.
 */
export function generateDeviceId(randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  let id = '';
  for (let i = 0; i < DEVICE_ID_BYTES; i++) {
    id += randomInt(256).toString(16).padStart(2, '0');
  }
  return id;
}

/**
 * Returns this install's persistent device identifier, generating and
 * persisting one on first use. Not tied to any account or PII.
 */
export async function getOrCreateDeviceId(store: Store): Promise<string> {
  const existing = await store.getSetting(SETTINGS_KEYS.deviceId);
  if (existing) return existing;
  const id = generateDeviceId();
  await store.setSetting(SETTINGS_KEYS.deviceId, id);
  return id;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx jest src/domain/deviceId.test.ts
```
Expected: PASS, all 5 tests.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: no errors (confirms `store.ts`'s new key compiles and the fake `Store` in the test satisfies the interface — it won't yet, since `isListenerAuthorized`/`authorizeListener` aren't on the real interface until Task 4; if typecheck fails here on those two methods, that's expected and resolves once Task 4 lands — do not add them speculatively in this task).

- [ ] **Step 7: Commit**

```bash
git add src/domain/deviceId.ts src/domain/deviceId.test.ts src/domain/store.ts
git commit -m "domain: add persistent per-install deviceId

Generated once (128 bits from Math.random, injectable — same pattern
as generatePairingCode; not a bearer secret, see module doc for why
that's sufficient here) and persisted via a new SETTINGS_KEYS.deviceId.
Lets a Monitor recognize 'the same Parent as before' across
reconnects, once Task 4/7/8 wire it through."
```

---

## Task 4: Store — authorized listeners

**Files:**
- Modify: `src/domain/store.ts`
- Modify: `src/storage/SqliteStore.ts`
- Modify: `src/storage/storeContract.ts`

**Interfaces:**
- Consumes: `SqlDatabase` (existing, `src/storage/sql.ts`), `src/domain/timestamp.ts`'s `formatTimestamp` (existing).
- Produces: `Store.isListenerAuthorized(deviceId: string): Promise<boolean>`, `Store.authorizeListener(deviceId: string): Promise<void>`. Consumed by Task 7 (`MonitorSession`).

- [ ] **Step 1: Add the two methods to the `Store` interface**

In `src/domain/store.ts`, replace:
```ts
  /** setSetting persists an app setting, replacing any existing value. */
  setSetting(key: string, value: string): Promise<void>;

  /** close releases the underlying resources. */
  close(): Promise<void>;
}
```
with:
```ts
  /** setSetting persists an app setting, replacing any existing value. */
  setSetting(key: string, value: string): Promise<void>;

  /** isListenerAuthorized returns true iff this deviceId has previously been let in (see authorizeListener). Global to this installation — a device only ever monitors as itself, so there's no "which monitor" to scope it to. */
  isListenerAuthorized(deviceId: string): Promise<boolean>;

  /** authorizeListener remembers a deviceId as authorized. Calling it again for an already-authorized deviceId is not an error. */
  authorizeListener(deviceId: string): Promise<void>;

  /** close releases the underlying resources. */
  close(): Promise<void>;
}
```

- [ ] **Step 2: Add contract tests**

In `src/storage/storeContract.ts`, add before the final closing `});`:

```ts
    test('isListenerAuthorized is false for a never-authorized deviceId', async () => {
      await expect(store.isListenerAuthorized('dev-1')).resolves.toBe(false);
    });

    test('authorizeListener then isListenerAuthorized round-trips true', async () => {
      await store.authorizeListener('dev-1');
      await expect(store.isListenerAuthorized('dev-1')).resolves.toBe(true);
    });

    test('authorizeListener is idempotent — calling it twice is not an error', async () => {
      await store.authorizeListener('dev-1');
      await expect(store.authorizeListener('dev-1')).resolves.toBeUndefined();
      await expect(store.isListenerAuthorized('dev-1')).resolves.toBe(true);
    });

    test('authorization is independent per deviceId', async () => {
      await store.authorizeListener('dev-1');
      await expect(store.isListenerAuthorized('dev-2')).resolves.toBe(false);
    });
```

- [ ] **Step 3: Run the contract tests to verify they fail**

```bash
npx jest src/storage/SqliteStore.test.ts
```
Expected: FAIL — `store.isListenerAuthorized is not a function` (SqliteStore doesn't implement the interface yet, so TypeScript would also fail to compile; Jest's babel transform doesn't typecheck, so this fails at runtime instead — confirm with `npm run typecheck` too, which should show `SqliteStore` is missing the two new members).

- [ ] **Step 4: Implement in `SqliteStore`**

In `src/storage/SqliteStore.ts`, add the new table to the `CREATE TABLE` block inside `static async open`. Replace:
```ts
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
```
with:
```ts
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authorized_listeners (
        deviceId TEXT PRIMARY KEY NOT NULL,
        addedAt  TEXT NOT NULL
      );
    `);
```

Add the two methods. Insert after `setSetting`'s closing brace (before `async close`):

```ts
  async isListenerAuthorized(deviceId: string): Promise<boolean> {
    const rows = await this.db.all<{ deviceId: string }>('SELECT deviceId FROM authorized_listeners WHERE deviceId = ?', [
      deviceId,
    ]);
    return rows.length > 0;
  }

  async authorizeListener(deviceId: string): Promise<void> {
    // addedAt is diagnostic-only (never surfaced in the UI today), so it's
    // computed here rather than threaded through every call site — unlike
    // addMonitor/appendEvent's addedAt/occurredAt, which are
    // domain-meaningful and always caller-supplied.
    await this.db.run(
      'INSERT INTO authorized_listeners (deviceId, addedAt) VALUES (?, ?) ON CONFLICT(deviceId) DO NOTHING',
      [deviceId, formatTimestamp(new Date())],
    );
  }
```

Add the import at the top of the file:
```ts
import { formatTimestamp } from '../domain/timestamp';
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx jest src/storage/SqliteStore.test.ts
```
Expected: PASS, including the four new contract tests.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: no errors. This also confirms Task 3's `deviceId.test.ts` fake `Store` now satisfies the full interface — re-run `npx jest src/domain/deviceId.test.ts` and confirm it's still green.

- [ ] **Step 7: Commit**

```bash
git add src/domain/store.ts src/storage/SqliteStore.ts src/storage/storeContract.ts
git commit -m "store: add authorized-listeners persistence

New authorized_listeners table (deviceId primary key) + Store.
isListenerAuthorized/authorizeListener, following the same
upsert-is-idempotent pattern as the rest of SqliteStore. This is what
MonitorSession (a later task) checks before letting a WebRTC peer in."
```

---

## Task 5: App protocol + `SignalingClient` — deviceId and routing

**Files:**
- Modify: `src/webrtc/protocol.ts`
- Modify: `src/webrtc/signalingClient.ts`
- Modify: `src/webrtc/signalingClient.test.ts`

**Interfaces:**
- Produces: `SignalingClient.connect(room, role, handlers, deviceId?)`, `SignalingClient.sendSignal(payload, to?)`, `SignalingHandlers.onPeerJoined?: (deviceId?: string) => void`, `SignalingHandlers.onPeerLeft?: (deviceId?: string) => void`, `SignalingHandlers.onSignal?: (payload: unknown, from?: string) => void`. Consumed by Task 7 (`MonitorSession`)/Task 8 (`ParentSession`).

- [ ] **Step 1: Update `protocol.ts`'s client-side mirror**

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
  | { type: 'signal'; payload: unknown; to?: string };

export type ServerMessage =
  | { type: 'joined'; role: Role }
  | { type: 'peer-joined'; deviceId?: string }
  | { type: 'peer-left'; deviceId?: string }
  | { type: 'signal'; payload: unknown; from?: string }
  | { type: 'error'; message: string };
```

- [ ] **Step 2: Write the new/updated failing tests**

In `src/webrtc/signalingClient.test.ts`, add these tests inside the `describe('SignalingClient', ...)` block, after the last existing `it(...)`:

```ts
  it('includes deviceId in the join message when provided', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);

    const connected = client.connect('482913', 'parent', {}, 'dev-1');
    joinSocket(sockets[0]!);
    await connected;

    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'join', room: '482913', role: 'parent', deviceId: 'dev-1' });
  });

  it('omits deviceId from the join message when not provided', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);

    const connected = client.connect('482913', 'monitor', {});
    joinSocket(sockets[0]!);
    await connected;

    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'join', room: '482913', role: 'monitor' });
  });

  it('resends the same deviceId on every reconnect attempt', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);

    await Promise.all([client.connect('482913', 'parent', {}, 'dev-1'), Promise.resolve(joinSocket(sockets[0]!))]);
    sockets[0]!.simulateNetworkDrop();
    jest.advanceTimersByTime(500);
    sockets[1]!.simulateOpen();

    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ type: 'join', room: '482913', role: 'parent', deviceId: 'dev-1' });
  });

  it('passes deviceId through peer-joined and peer-left to the handlers', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);
    const onPeerJoined = jest.fn();
    const onPeerLeft = jest.fn();

    await Promise.all([
      client.connect('482913', 'monitor', { onPeerJoined, onPeerLeft }),
      Promise.resolve(joinSocket(sockets[0]!)),
    ]);

    sockets[0]!.simulateMessage({ type: 'peer-joined', deviceId: 'dev-1' });
    expect(onPeerJoined).toHaveBeenCalledWith('dev-1');

    sockets[0]!.simulateMessage({ type: 'peer-left', deviceId: 'dev-1' });
    expect(onPeerLeft).toHaveBeenCalledWith('dev-1');
  });

  it('passes from through to onSignal', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);
    const onSignal = jest.fn();

    await Promise.all([client.connect('482913', 'monitor', { onSignal }), Promise.resolve(joinSocket(sockets[0]!))]);

    sockets[0]!.simulateMessage({ type: 'signal', payload: { sdp: 'x' }, from: 'dev-1' });
    expect(onSignal).toHaveBeenCalledWith({ sdp: 'x' }, 'dev-1');
  });

  it('includes to in a sent signal message when provided', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);

    await Promise.all([client.connect('482913', 'monitor', {}), Promise.resolve(joinSocket(sockets[0]!))]);
    sockets[0]!.sent.length = 0; // clear the join message
    client.sendSignal({ sdp: 'x' }, 'dev-1');

    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ type: 'signal', payload: { sdp: 'x' }, to: 'dev-1' });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx jest src/webrtc/signalingClient.test.ts
```
Expected: FAIL — `client.connect` doesn't accept a 4th argument yet (TypeScript error surfaces as a Jest/babel runtime issue since this project's Jest transform doesn't typecheck; confirm the real type error separately with `npm run typecheck`).

- [ ] **Step 4: Update `signalingClient.ts`**

Replace the `SignalingHandlers` interface:
```ts
export interface SignalingHandlers {
  onPeerJoined?: () => void;
  onPeerLeft?: () => void;
  onSignal?: (payload: unknown) => void;
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
}
```

Add a `deviceId` field to the class and update `connect`'s signature. Replace:
```ts
  private room = '';
  private role: Role = 'parent';
  private handlers: SignalingHandlers = {};

  constructor(
    private readonly url: string,
    private readonly webSocketFactory: WebSocketFactory = defaultWebSocketFactory,
  ) {}

  /** Opens the connection and joins `room` under `role`. Resolves once the relay acknowledges the join. */
  connect(room: string, role: Role, handlers: SignalingHandlers): Promise<void> {
    this.room = room;
    this.role = role;
    this.handlers = handlers;
    this.explicitlyClosed = false;
    return this.attemptConnect();
  }
```
with:
```ts
  private room = '';
  private role: Role = 'parent';
  private deviceId: string | undefined;
  private handlers: SignalingHandlers = {};

  constructor(
    private readonly url: string,
    private readonly webSocketFactory: WebSocketFactory = defaultWebSocketFactory,
  ) {}

  /** Opens the connection and joins `room` under `role` (with `deviceId` when role is 'parent'). Resolves once the relay acknowledges the join. */
  connect(room: string, role: Role, handlers: SignalingHandlers, deviceId?: string): Promise<void> {
    this.room = room;
    this.role = role;
    this.deviceId = deviceId;
    this.handlers = handlers;
    this.explicitlyClosed = false;
    return this.attemptConnect();
  }
```

Update the join-message construction and message handlers inside `attemptConnect`. Replace:
```ts
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'join', room: this.room, role: this.role } satisfies ClientMessage));
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case 'joined':
          joined = true;
          this.backoff.reset();
          this.reconnectAttempt = 0;
          if (this.hasConnectedOnce) this.handlers.onReconnected?.();
          this.hasConnectedOnce = true;
          resolve();
          break;
        case 'peer-joined':
          this.handlers.onPeerJoined?.();
          break;
        case 'peer-left':
          this.handlers.onPeerLeft?.();
          break;
        case 'signal':
          this.handlers.onSignal?.(message.payload);
          break;
        case 'error':
          this.handlers.onError?.(message.message);
          if (!joined) reject(new Error(message.message));
          break;
      }
    };
```
with:
```ts
    socket.onopen = () => {
      socket.send(
        JSON.stringify({ type: 'join', room: this.room, role: this.role, deviceId: this.deviceId } satisfies ClientMessage),
      );
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case 'joined':
          joined = true;
          this.backoff.reset();
          this.reconnectAttempt = 0;
          if (this.hasConnectedOnce) this.handlers.onReconnected?.();
          this.hasConnectedOnce = true;
          resolve();
          break;
        case 'peer-joined':
          this.handlers.onPeerJoined?.(message.deviceId);
          break;
        case 'peer-left':
          this.handlers.onPeerLeft?.(message.deviceId);
          break;
        case 'signal':
          this.handlers.onSignal?.(message.payload, message.from);
          break;
        case 'error':
          this.handlers.onError?.(message.message);
          if (!joined) reject(new Error(message.message));
          break;
      }
    };
```

Note: `JSON.stringify` drops `undefined`-valued properties automatically, so `deviceId: this.deviceId` being `undefined` for a Monitor's join correctly produces no `deviceId` key on the wire — matches the "omits deviceId" test above.

Update `sendSignal`. Replace:
```ts
  /** Sends an opaque signaling payload (an SDP description or an ICE candidate) to the other peer in the room. */
  sendSignal(payload: unknown): void {
    this.socket?.send(JSON.stringify({ type: 'signal', payload } satisfies ClientMessage));
  }
```
with:
```ts
  /** Sends an opaque signaling payload (an SDP description or an ICE candidate) to the other peer in the room. `to` is required when this client is the Monitor (routing to a specific Parent); omitted otherwise. */
  sendSignal(payload: unknown, to?: string): void {
    this.socket?.send(JSON.stringify({ type: 'signal', payload, to } satisfies ClientMessage));
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx jest src/webrtc/signalingClient.test.ts
```
Expected: PASS, all tests including the six new ones.

- [ ] **Step 6: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/webrtc/protocol.ts src/webrtc/signalingClient.ts src/webrtc/signalingClient.test.ts
git commit -m "webrtc: SignalingClient carries deviceId through join/signal/peer events

Client-side mirror of Task 1's relay protocol change. connect() gains
an optional trailing deviceId param (existing call sites unaffected);
sendSignal() gains an optional to; onPeerJoined/onPeerLeft/onSignal
all pass deviceId/from through to handlers."
```

---

## Task 6: `peerConnectionHelpers` — rejection and invite-mode signal shapes

**Files:**
- Modify: `src/webrtc/peerConnectionHelpers.ts`

**Interfaces:**
- Produces: `SignalPayload` gains `{ rejected: true; reason: string } | { inviteMode: 'open' | 'closed' }`, `isRejectedSignal(payload): payload is { rejected: true; reason: string }`, `isInviteModeSignal(payload): payload is { inviteMode: 'open' | 'closed' }`. Consumed by Task 7 (`MonitorSession`)/Task 8 (`ParentSession`).

- [ ] **Step 1: Extend the payload union and add the two guards**

Replace:
```ts
export type SignalPayload = { sdp: WireSdp } | { candidate: WireIceCandidate };

/** True iff `payload` is the SDP half of a SignalPayload. */
export function isSdpSignal(payload: unknown): payload is { sdp: WireSdp } {
  return typeof payload === 'object' && payload !== null && 'sdp' in payload;
}

/** True iff `payload` is the ICE-candidate half of a SignalPayload. */
export function isCandidateSignal(payload: unknown): payload is { candidate: WireIceCandidate } {
  return typeof payload === 'object' && payload !== null && 'candidate' in payload;
}
```
with:
```ts
export type SignalPayload =
  | { sdp: WireSdp }
  | { candidate: WireIceCandidate }
  | { rejected: true; reason: string }
  | { inviteMode: 'open' | 'closed' };

/** True iff `payload` is the SDP half of a SignalPayload. */
export function isSdpSignal(payload: unknown): payload is { sdp: WireSdp } {
  return typeof payload === 'object' && payload !== null && 'sdp' in payload;
}

/** True iff `payload` is the ICE-candidate half of a SignalPayload. */
export function isCandidateSignal(payload: unknown): payload is { candidate: WireIceCandidate } {
  return typeof payload === 'object' && payload !== null && 'candidate' in payload;
}

/** True iff `payload` is a Monitor's "you're not authorized" rejection, sent to a Parent whose deviceId isn't authorized and invite mode isn't open. */
export function isRejectedSignal(payload: unknown): payload is { rejected: true; reason: string } {
  return typeof payload === 'object' && payload !== null && 'rejected' in payload;
}

/** True iff `payload` is a Parent's request to open/close the Monitor's invite mode on its behalf — only honored by MonitorSession from an already-connected (thus already-authorized) sender. */
export function isInviteModeSignal(payload: unknown): payload is { inviteMode: 'open' | 'closed' } {
  return typeof payload === 'object' && payload !== null && 'inviteMode' in payload;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors (this file has no dedicated test suite today — its guards are exercised indirectly through Task 7/8's sessions; a manual on-device test is what actually proves the wire format round-trips correctly, per this project's existing testing posture for `monitorSession.ts`/`parentSession.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/webrtc/peerConnectionHelpers.ts
git commit -m "webrtc: add rejected/inviteMode signal payload shapes

Two new application-level signal payloads carried over the existing
opaque signal channel — the relay never needs to understand them,
matching the design's 'authorization stays client-side' principle."
```

---

## Task 7: `MonitorSession` — multi-peer + authorization

**Files:**
- Modify: `src/webrtc/monitorSession.ts`

**Interfaces:**
- Consumes: `Store` (Task 4), `InviteMode`/`decideListener` (Task 2), `isRejectedSignal`/`isInviteModeSignal`/`SignalPayload` (Task 6), `SignalingClient`/`SignalingHandlers` (Task 5).
- Produces: `new MonitorSession(options: MonitorSessionOptions, store: Store, events?: MonitorSessionEvents)`, `.openLocalInvite(): void`, `.closeLocalInvite(): void`, `MonitorSessionEvents.onListenerCountChange?: (count: number) => void`. Consumed by Task 9 (`Monitor.tsx`).

No automated test for this file — same as its current (untested) state. `RTCPeerConnection`/`mediaDevices` are native modules with no mock set up in this project's Jest config, and the actually-interesting new logic (the authorization decision, invite-mode bookkeeping) is what Task 2 already unit tests in isolation. This task's correctness is verified by Step 3 below (typecheck) plus the manual multi-phone test described in Task 11.

- [ ] **Step 1: Rewrite `monitorSession.ts`**

Replace the whole file:

```ts
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { MediaStream } from 'react-native-webrtc';

import { decideListener, InviteMode } from '../domain/inviteMode';
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
  pairingCode: string;
  iceServers?: RTCIceServer[];
}

export interface MonitorSessionEvents {
  /** Fires whenever the number of currently-connected (RTCPeerConnection state 'connected') listeners changes. */
  onListenerCountChange?: (count: number) => void;
  /** Fires each time the signaling connection retries after an unexpected drop. */
  onSignalingReconnecting?: (attempt: number) => void;
  /** Fires once a signaling retry successfully rejoins the room. */
  onSignalingReconnected?: () => void;
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure. */
  onError?: (message: string) => void;
}

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
 */
export class MonitorSession {
  private readonly signaling: SignalingClient;
  private readonly peers = new Map<string, Peer>();
  private readonly inviteMode = new InviteMode();
  private localStream: MediaStream | null = null;

  constructor(
    private readonly options: MonitorSessionOptions,
    private readonly store: Store,
    private readonly events: MonitorSessionEvents = {},
  ) {
    this.signaling = new SignalingClient(options.signalingUrl);
  }

  /** Requests the mic and joins the signaling room. Call once; call `stop()` before starting again. */
  async start(): Promise<void> {
    this.localStream = (await mediaDevices.getUserMedia({ audio: true })) as MediaStream;

    await this.signaling.connect(this.options.pairingCode, 'monitor', {
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

  /** Opens invite mode as this device's own screen — a not-yet-authorized Parent is let in and remembered while this (or any other holder) is open. Call in the pairing screen's mount effect. */
  openLocalInvite(): void {
    this.inviteMode.open('local');
  }

  /** Call in the pairing screen's unmount cleanup. */
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
    for (const deviceId of [...this.peers.keys()]) this.teardownPeer(deviceId);
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.signaling.close();
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
      if (payload.inviteMode === 'open') this.inviteMode.open(from);
      else this.inviteMode.close(from);
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
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/webrtc/monitorSession.ts
git commit -m "webrtc: MonitorSession supports multiple simultaneous listeners

Map<deviceId, RTCPeerConnection> instead of one, all sharing the
local mic track. Every newly-joined peer goes through
decideListener(isAuthorized, inviteMode.isOpen) before a peer
connection is ever created for it - a reject sends an application-
level signal instead, since the relay itself has no concept of
authorization. An already-connected peer can toggle invite mode
itself via an inviteMode signal."
```

---

## Task 8: `ParentSession` — device identity, rejection, invite signaling

**Files:**
- Modify: `src/webrtc/parentSession.ts`

**Interfaces:**
- Consumes: `isRejectedSignal` (Task 6), `SignalingClient.connect(..., deviceId?)`/`sendSignal(payload, to?)` (Task 5).
- Produces: `ParentSessionOptions.deviceId: string` (now required), `ParentSessionEvents.onRejected?: (reason: string) => void`, `.setInviteMode(open: boolean): void`. Consumed by Task 10 (`Parent.tsx`).

No automated test for this file, for the same reason as Task 7 (untested today, native `RTCPeerConnection`/`getUserMedia`, no mock in this project's Jest config). Verified by typecheck plus the manual multi-phone test in Task 11.

- [ ] **Step 1: Update `parentSession.ts`**

Replace:
```ts
export interface ParentSessionOptions {
  signalingUrl: string;
  pairingCode: string;
  iceServers?: RTCIceServer[];
}

export interface ParentSessionEvents {
  onConnectionStateChange?: (state: string) => void;
  /** Fires once the monitor's audio track arrives; react-native-webrtc routes it to the device speaker automatically, this is for UI state only. */
  onRemoteStream?: (stream: MediaStream) => void;
  /** Fires each time the signaling connection retries after an unexpected drop. */
  onSignalingReconnecting?: (attempt: number) => void;
  /** Fires once a signaling retry successfully rejoins the room. */
  onSignalingReconnected?: () => void;
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure — see SignalingClient.onError. */
  onError?: (message: string) => void;
}
```
with:
```ts
export interface ParentSessionOptions {
  signalingUrl: string;
  pairingCode: string;
  /** This install's persistent device identifier — see src/domain/deviceId.ts. Lets the Monitor recognize a reconnect versus a new device. */
  deviceId: string;
  iceServers?: RTCIceServer[];
}

export interface ParentSessionEvents {
  onConnectionStateChange?: (state: string) => void;
  /** Fires once the monitor's audio track arrives; react-native-webrtc routes it to the device speaker automatically, this is for UI state only. */
  onRemoteStream?: (stream: MediaStream) => void;
  /** Fires each time the signaling connection retries after an unexpected drop. */
  onSignalingReconnecting?: (attempt: number) => void;
  /** Fires once a signaling retry successfully rejoins the room. */
  onSignalingReconnected?: () => void;
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure — see SignalingClient.onError. */
  onError?: (message: string) => void;
  /** Fires when the Monitor rejects this device — not yet authorized, and invite mode wasn't open at the time. Retrying later (e.g. once someone opens invite mode) can still succeed. */
  onRejected?: (reason: string) => void;
}
```

Replace the `import` line to add `isRejectedSignal`:
```ts
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
```
with:
```ts
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isRejectedSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
```

Replace `start()`:
```ts
  async start(): Promise<void> {
    this.setupPeerConnection();
    await this.signaling.connect(this.options.pairingCode, 'parent', {
      onPeerLeft: () => this.teardownPeerConnection(),
      onSignal: (payload) => {
        this.handleSignal(payload).catch(() => {});
      },
      onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
      onReconnected: () => this.events.onSignalingReconnected?.(),
      onError: (message) => this.events.onError?.(message),
    });
  }
```
with:
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

  /** Asks the Monitor to open or close invite mode on this Parent's behalf — only honored if the Monitor still considers this deviceId connected (see MonitorSession.handleSignal). */
  setInviteMode(open: boolean): void {
    this.signaling.sendSignal({ inviteMode: open ? 'open' : 'closed' });
  }
```

Replace `handleSignal`:
```ts
  private async handleSignal(payload: unknown): Promise<void> {
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
    const pc = this.pc ?? this.setupPeerConnection();
    if (isSdpSignal(payload)) {
      await handleIncomingSdp(pc, payload.sdp, this.iceQueue, (p) => this.signaling.sendSignal(p));
    } else if (isCandidateSignal(payload)) {
      await this.iceQueue.add(pc, payload.candidate);
    }
  }
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/webrtc/parentSession.ts
git commit -m "webrtc: ParentSession sends deviceId, handles rejection, can invite

deviceId is now a required option, forwarded to SignalingClient.connect
so the Monitor can recognize reconnects. A rejected signal surfaces as
onRejected instead of silently doing nothing. setInviteMode lets an
already-authorized Parent open the door for a new device itself."
```

---

## Task 9: `Monitor.tsx` — invite mode + listener count

**Files:**
- Modify: `src/screens/Monitor.tsx`

**Interfaces:**
- Consumes: `MonitorSession` (Task 7, now takes `store` as its 2nd constructor arg and exposes `.openLocalInvite()`/`.closeLocalInvite()`, `onListenerCountChange` instead of `onConnectionStateChange`).

- [ ] **Step 1: Update the `MonitorSession` construction and connection-state UI**

Replace:
```ts
  const [connectionState, setConnectionState] = React.useState('idle');
```
with:
```ts
  const [listenerCount, setListenerCount] = React.useState(0);
```

Replace:
```ts
    const session = new MonitorSession(
      { signalingUrl: relayUrl, pairingCode },
      {
        onConnectionStateChange: setConnectionState,
        onSignalingReconnecting: (attempt) => setReconnecting(attempt),
        onSignalingReconnected: () => setReconnecting(null),
      },
    );
    sessionRef.current = session;
    session.start().catch(() => setConnectionState('failed'));
    advertiserRef.current.publish(pairingCode, pairingCode);

    return () => {
      session.stop();
      advertiserRef.current.unpublish(pairingCode);
      stopForegroundSession().catch(() => {});
    };
  }, [relayUrl, pairingCode]);
```
with:
```ts
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

Note: `session.start().catch(() => setConnectionState('failed'))` becomes `.catch(() => {})` — there's no longer a single `connectionState` to set to `'failed'`; a `start()` failure (e.g., mic permission denied) leaves `listenerCount` at its initial `0`, which the UI already renders sensibly (see Step 2).

- [ ] **Step 2: Update the status text**

Replace:
```ts
      <View style={styles.meterSection}>
        <Text variant="labelLarge">{gateOpen ? 'Streaming' : 'Quiet'}</Text>
        <ProgressBar progress={levelDb === null ? 0 : levelToFraction(levelDb)} style={styles.meter} />
        <Text variant="bodySmall">
          {!isReady
            ? 'Requesting microphone…'
            : reconnecting !== null
              ? `Reconnecting to relay (attempt ${reconnecting})…`
              : `Connection: ${connectionState}`}
        </Text>
      </View>
```
with:
```ts
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
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```
Expected: all existing tests still pass (no `Monitor.test.tsx` exists today, so this task's own correctness rests on typecheck plus the manual test in Task 11).

- [ ] **Step 5: Commit**

```bash
git add src/screens/Monitor.tsx
git commit -m "screens: Monitor shows listener count, opens invite mode while visible

Replaces the single-connection 'Connection: X' text with 'N listeners
connected', matching multi-listener support. The pairing screen being
mounted is this device's own invite-mode holder, closed again on
unmount - a stranger with the code can no longer join just because
this screen happened to be shown once in the past."
```

---

## Task 10: `Parent.tsx` — rejection handling + invite a listener

**Files:**
- Modify: `src/screens/Parent.tsx`

**Interfaces:**
- Consumes: `ParentSession` (Task 8, now requires `deviceId` in options, exposes `onRejected`/`setInviteMode`), `getOrCreateDeviceId` (Task 3).

- [ ] **Step 1: Load this device's deviceId and pass it to `ParentSession`**

Add the import:
```ts
import { getOrCreateDeviceId } from '../domain/deviceId';
```

Replace the entire connect effect:
```ts
  React.useEffect(() => {
    if (!monitor) return;
    let cancelled = false;
    setConnectTimedOut(false);

    const timeoutId = setTimeout(() => {
      if (!cancelled) setConnectTimedOut(true);
    }, CONNECT_TIMEOUT_MS);

    store.getSetting(SETTINGS_KEYS.signalingServerUrl).then((value) => {
      const relayUrl = value || DEFAULT_SIGNALING_SERVER_URL;
      if (cancelled) return;

      const session = new ParentSession(
        { signalingUrl: relayUrl, pairingCode: monitor.lastPairingCode },
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
        },
      );
      sessionRef.current = session;
      session.start().catch(() => setConnectionState('failed'));
      // MICROPHONE is deliberately not requested here: Android 14+ rejects a
      // foreground-service type unless the app is actually using it at that
      // exact moment (AppOpsManager's recording-state check), and Parent
      // isn't recording yet at connect time — only during push-to-talk (see
      // toggleTalk below). Requesting it upfront crashed with
      // "SecurityException: ... the app must be in the eligible
      // state/exemptions" on a real device.
      startForegroundSession('Wewe', `Watching ${monitor.label}`, [
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      ]).catch(() => {});
    });

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      sessionRef.current?.stop();
      sessionRef.current = null;
      stopForegroundSession().catch(() => {});
    };
  }, [monitor, store, logEvent]);
```
with:
```ts
  React.useEffect(() => {
    if (!monitor) return;
    let cancelled = false;
    setConnectTimedOut(false);
    setRejected(null);

    const timeoutId = setTimeout(() => {
      if (!cancelled) setConnectTimedOut(true);
    }, CONNECT_TIMEOUT_MS);

    Promise.all([store.getSetting(SETTINGS_KEYS.signalingServerUrl), getOrCreateDeviceId(store)]).then(
      ([value, deviceId]) => {
        const resolvedRelayUrl = value || DEFAULT_SIGNALING_SERVER_URL;
        setRelayUrl(resolvedRelayUrl);
        if (cancelled) return;

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
        sessionRef.current = session;
        session.start().catch(() => setConnectionState('failed'));
        // MICROPHONE is deliberately not requested here: Android 14+ rejects a
        // foreground-service type unless the app is actually using it at that
        // exact moment (AppOpsManager's recording-state check), and Parent
        // isn't recording yet at connect time — only during push-to-talk (see
        // toggleTalk below). Requesting it upfront crashed with
        // "SecurityException: ... the app must be in the eligible
        // state/exemptions" on a real device.
        startForegroundSession('Wewe', `Watching ${monitor.label}`, [
          AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        ]).catch(() => {});
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      sessionRef.current?.stop();
      sessionRef.current = null;
      stopForegroundSession().catch(() => {});
    };
  }, [monitor, store, logEvent]);
```

`relayUrl` is now a piece of component state (added in Step 3 below) rather than a variable local to the `.then` callback — renamed to `resolvedRelayUrl` inside the callback to avoid shadowing it.

- [ ] **Step 2: Add `rejected` state and its UI**

Replace:
```ts
  const [connectTimedOut, setConnectTimedOut] = React.useState(false);
```
with:
```ts
  const [connectTimedOut, setConnectTimedOut] = React.useState(false);
  const [rejected, setRejected] = React.useState<string | null>(null);
  const [invitingListener, setInvitingListener] = React.useState(false);
```

Replace the status `<Text>`:
```ts
      <Text variant="bodyMedium" style={styles.status}>
        {reconnecting !== null
          ? `Reconnecting to relay (attempt ${reconnecting})…`
          : connectTimedOut && connectionState !== 'connected'
            ? "Couldn't reach that monitor. Check it's still running and try again."
            : `Connection: ${connectionState}`}
      </Text>
```
with:
```ts
      <Text variant="bodyMedium" style={styles.status}>
        {rejected !== null
          ? 'Not let in yet — ask someone already connected to invite this device.'
          : reconnecting !== null
            ? `Reconnecting to relay (attempt ${reconnecting})…`
            : connectTimedOut && connectionState !== 'connected'
              ? "Couldn't reach that monitor. Check it's still running and try again."
              : `Connection: ${connectionState}`}
      </Text>
```

- [ ] **Step 3: Add the "Invite a listener" toggle**

Replace:
```ts
      <Button
        mode={talking ? 'contained' : 'outlined'}
        icon="microphone"
        onPressIn={toggleTalk}
        onPressOut={toggleTalk}
        style={styles.talkButton}
      >
        {talking ? 'Release to stop talking' : 'Hold to talk'}
      </Button>
```
with:
```ts
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

This introduces a new `relayUrl` reference the component doesn't currently keep in state (it's only used transiently inside the connect effect today) — add it:

Replace:
```ts
  const [connectTimedOut, setConnectTimedOut] = React.useState(false);
  const [rejected, setRejected] = React.useState<string | null>(null);
  const [invitingListener, setInvitingListener] = React.useState(false);
```
with:
```ts
  const [connectTimedOut, setConnectTimedOut] = React.useState(false);
  const [rejected, setRejected] = React.useState<string | null>(null);
  const [invitingListener, setInvitingListener] = React.useState(false);
  const [relayUrl, setRelayUrl] = React.useState<string | null>(null);
```

Step 1's replacement of the connect effect already declares and sets this `relayUrl` state (via `setRelayUrl(resolvedRelayUrl)`) — no further edit to that effect is needed here.

Add the needed imports:
```ts
import QRCode from 'react-native-qrcode-svg';

import { pairingUri } from '../domain/pairing';
```

Add the `qrWrap`/`code` styles (reuse Monitor.tsx's naming for consistency — check `src/screens/Monitor.tsx`'s `styles` object for the exact values and copy them verbatim into Parent.tsx's `StyleSheet.create` call):
```ts
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 16, alignItems: 'center' },
  code: { letterSpacing: 4, marginTop: 8 },
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```
Expected: no errors. If indentation from Step 1's reindent broke anything, fix it now — do not proceed to Step 5 with a red typecheck.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```
Expected: all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/screens/Parent.tsx
git commit -m "screens: Parent handles rejection, can invite another listener

A rejected connection shows a clear message instead of hanging in the
generic connect-timeout state. 'Invite a listener' toggles this
Parent's own invite-mode hold on the Monitor and shows the same
pairing code/QR the Monitor itself would, per the design's 'same code,
different holder' approach."
```

---

## Task 11: Manual multi-device verification

**Files:** none (verification only — no automated test can exercise three real WebRTC peers and two real SQLite-backed authorization decisions end to end; this is the same posture this project already takes for `MonitorSession`/`ParentSession` integration, per `AGENTS.md`'s "not yet verified on a physical device" notes elsewhere).

- [ ] **Step 1: Build and install the debug dev client on at least two, ideally three, phones**

```bash
npm run android
```
Follow up with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk` on any additional connected device (per this session's earlier established pattern for multi-device testing).

- [ ] **Step 2: Verify basic pairing still works**

Phone A: "Use this device as a monitor". Phone B: "Add a monitor", scan/enter the code. Confirm B connects and Monitor's status changes from "No one listening yet" to "1 listener connected".

- [ ] **Step 3: Verify an already-paired device reconnects without needing invite mode open**

On Phone A, navigate away from the Monitor screen (closing its own invite hold) and back in. On Phone B, force-stop and reopen the app, reconnecting to the same paired monitor. Confirm B reconnects successfully even though neither device is showing an active "invite" — this is the existing persisted-code invariant and must not regress.

- [ ] **Step 4: Verify a genuinely new device is rejected outside invite mode**

With Phone A's Monitor screen open but *not* actively re-entered (i.e., past its own mount — if the screen itself is the sole invite holder this will still be open; to test rejection, back out to Home first so the Monitor's own hold closes), have Phone C attempt to pair using the same code. Confirm C sees the "Not let in yet" message and does *not* start receiving audio.

- [ ] **Step 5: Verify inviting via the Monitor's own screen lets a new device in**

Re-open Phone A's Monitor screen (reopening its invite hold). Retry Phone C's connection (or have it connect fresh). Confirm C connects and Monitor's listener count reaches 2.

- [ ] **Step 6: Verify inviting via an already-connected Parent**

With Phone A's Monitor screen backed out again (invite closed) and Phone B still connected as an authorized listener, tap "Invite a listener" on Phone B. Confirm it shows the same code/QR Monitor would. Have a fourth device (or reuse C after removing its authorization by clearing app data) attempt to join using it, and confirm it's let in while B's invite is open, and confirm turning B's invite back off (before a new device joins) results in the same-device-not-yet-tried case being rejected again.

- [ ] **Step 7: Verify simultaneous multi-listener audio**

With two Parents connected at once (B and C), confirm both receive live audio from the Monitor, and that toggling the Monitor's noise gate (making noise near it) is reflected on both listeners' apps at once.

- [ ] **Step 8: Final full check**

```bash
make check
```
Expected: typecheck and the full Jest suite (both `logic` and `screens` projects) pass clean.

- [ ] **Step 9: Push and cut a new beta**

```bash
git push origin main
```
Follow this repo's existing release process (`make prepare-release TAG=v1.0.0-beta.N CHANGELOG=...`, tag, push) once manual verification above is complete — do not cut a release before Steps 2–7 pass on real devices, since this feature has no automated coverage for the actual multi-peer WebRTC path.
