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
