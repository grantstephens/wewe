import { Backoff } from '../domain/backoff';
import type { ClientMessage, Role, ServerMessage } from './protocol';

/**
 * The subset of the WebSocket API this client needs, as an interface rather
 * than the global `WebSocket` type — lets tests inject an in-memory fake and
 * drive reconnect behavior deterministically instead of depending on a real
 * socket and real wall-clock retries.
 */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

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

/**
 * SignalingClient is the app-side half of `signal-server`'s room protocol:
 * join a room under a role, then exchange opaque `signal` payloads (SDP/ICE)
 * with whichever peer holds the other role. It never interprets those
 * payloads — that's `PeerSession`'s job — so the same client works
 * unchanged for both the Monitor and Parent roles.
 *
 * An unexpected disconnect (relay restart, WiFi blip) retries with
 * exponential backoff (`Backoff`) until `close()` is called explicitly —
 * without this, a dropped relay connection would silently end the session
 * with no path back to a working call.
 */
export class SignalingClient {
  private socket: WebSocketLike | null = null;
  private explicitlyClosed = false;
  private hasConnectedOnce = false;
  private reconnectAttempt = 0;
  private readonly backoff = new Backoff();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

  private attemptConnect(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = this.webSocketFactory(this.url);
    this.socket = socket;
    let joined = false;

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

    socket.onerror = () => {
      this.handlers.onError?.('socket-error');
      if (!joined) reject(new Error('socket-error'));
    };

    socket.onclose = () => {
      this.handlers.onClose?.();
      if (!this.explicitlyClosed) this.scheduleReconnect();
    };

    return promise;
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delayMs = this.backoff.nextDelayMs();
    this.handlers.onReconnecting?.(this.reconnectAttempt, delayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Rejection here just means this attempt failed; onclose above
      // schedules the next one, so there is nothing further to do with it.
      this.attemptConnect().catch(() => {});
    }, delayMs);
  }

  /** Sends an opaque signaling payload (an SDP description or an ICE candidate) to the other peer in the room. */
  sendSignal(payload: unknown): void {
    this.socket?.send(JSON.stringify({ type: 'signal', payload } satisfies ClientMessage));
  }

  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }
}
