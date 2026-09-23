import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { isClientMessage, type ErrorReason, type Role, type ServerMessage } from './protocol';

/** A room holds at most one socket per role. Rooms with no sockets left are deleted, so memory never grows with churn. */
type Room = Partial<Record<Role, WebSocket>>;

const OTHER_ROLE: Record<Role, Role> = { monitor: 'parent', parent: 'monitor' };

/** A lone peer waiting for its match gets disconnected after this long — see `SignalingServerOptions.roomTtlMs`'s doc comment for why. */
const DEFAULT_ROOM_TTL_MS = 5 * 60 * 1000;

/** Default per-IP join-attempt budget — see `SignalingServerOptions.rateLimitMax`'s doc comment. */
const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export interface SignalingServerOptions {
  /**
   * How long a room may hold exactly one peer before that lone peer is
   * disconnected with `room-expired` and the room is forgotten. Pairing
   * codes are short (six digits — one million possibilities) and reused as
   * the room name directly, so an attacker guessing codes could otherwise
   * camp in a real monitor's room indefinitely, waiting to receive its next
   * offer. Bounding how long an unclaimed room stays open bounds that
   * exposure window without changing the pairing UX.
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

  function clearRoomTimer(roomName: string): void {
    const timer = roomTimers.get(roomName);
    if (timer !== undefined) {
      clearTimeout(timer);
      roomTimers.delete(roomName);
    }
  }

  /** Called whenever a room's occupancy might have changed to exactly one peer, zero peers, or two peers — arms/disarms the TTL timer to match. */
  function rearmRoomTimer(roomName: string, room: Room): void {
    clearRoomTimer(roomName);
    const occupants = Object.values(room).filter((s): s is WebSocket => s !== undefined);
    if (occupants.length !== 1) return;

    const timer = setTimeout(() => {
      roomTimers.delete(roomName);
      const current = rooms.get(roomName);
      if (current === undefined) return;
      for (const socket of Object.values(current)) {
        if (socket !== undefined) closeWithError(socket, 'room-expired');
      }
      rooms.delete(roomName);
    }, roomTtlMs);
    // A lone peer's TTL timer must never keep the process alive on its own.
    timer.unref?.();
    roomTimers.set(roomName, timer);
  }

  wss.on('connection', (socket, request: IncomingMessage) => {
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    let joinedRoom: string | null = null;
    let joinedRole: Role | null = null;

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
        const room = rooms.get(parsed.room) ?? {};
        if (room[parsed.role] !== undefined) {
          closeWithError(socket, 'role-taken');
          return;
        }
        room[parsed.role] = socket;
        rooms.set(parsed.room, room);
        joinedRoom = parsed.room;
        joinedRole = parsed.role;
        rearmRoomTimer(parsed.room, room);

        send(socket, { type: 'joined', role: parsed.role });
        const other = room[OTHER_ROLE[parsed.role]];
        if (other !== undefined) {
          send(socket, { type: 'peer-joined' });
          send(other, { type: 'peer-joined' });
        }
        return;
      }

      // type === 'signal'
      if (joinedRoom === null || joinedRole === null) {
        closeWithError(socket, 'must-join-first');
        return;
      }
      const room = rooms.get(joinedRoom);
      const other = room?.[OTHER_ROLE[joinedRole]];
      if (other !== undefined) {
        send(other, { type: 'signal', payload: parsed.payload });
      }
    });

    socket.on('close', () => {
      if (joinedRoom === null || joinedRole === null) return;
      const room = rooms.get(joinedRoom);
      if (room === undefined) return;
      delete room[joinedRole];
      const other = room[OTHER_ROLE[joinedRole]];
      if (other !== undefined) {
        send(other, { type: 'peer-left' });
        rearmRoomTimer(joinedRoom, room);
      } else {
        clearRoomTimer(joinedRoom);
        rooms.delete(joinedRoom);
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
