import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import { attachSignalingServer, type SignalingServerOptions } from './server';
import type { ClientMessage, ServerMessage } from './protocol';

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

/** Starts a fresh relay on an ephemeral port and returns its ws:// base URL plus a teardown function. */
function startServer(options: SignalingServerOptions = {}): Promise<RunningServer> {
  const { promise, resolve } = Promise.withResolvers<RunningServer>();
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  attachSignalingServer(wss, options);
  httpServer.listen(0, () => {
    const { port } = httpServer.address() as AddressInfo;
    resolve({
      url: `ws://127.0.0.1:${port}`,
      close: () => {
        const closed = Promise.withResolvers<void>();
        wss.close();
        httpServer.close(() => closed.resolve());
        return closed.promise;
      },
    });
  });
  return promise;
}

/**
 * A test client wrapping a raw `ws` socket with a message queue.
 *
 * A one-off `.once('message', …)` re-attached only after each `await`
 * resolves loses messages: when the server sends two messages back-to-back
 * in one synchronous burst (e.g. `joined` immediately followed by
 * `peer-joined`), both frames can arrive in the same underlying `data`
 * event and get emitted synchronously one after another — before this
 * test's `await` for the first message has had a chance to run its
 * continuation and attach a fresh listener for the second. A persistent
 * listener queuing every message as it arrives, regardless of whether
 * anything is currently awaiting one, has no such race.
 */
class TestClient {
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: Array<(msg: ServerMessage) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  static connect(url: string): Promise<TestClient> {
    const { promise, resolve } = Promise.withResolvers<TestClient>();
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(new TestClient(socket)));
    return promise;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Sends a raw string frame, bypassing JSON encoding — for exercising the server's malformed-input handling. */
  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  /** Resolves with the next message this client hasn't yet consumed, waiting for it to arrive if necessary. */
  next(): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const { promise, resolve } = Promise.withResolvers<ServerMessage>();
    this.waiters.push(resolve);
    return promise;
  }

  /** Closes the socket and waits for its own close event — a near-deterministic proxy for "the server has finished processing this disconnect", since `ws` fires the client close event once the closing handshake the server participates in completes. */
  close(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.socket.once('close', () => resolve());
    this.socket.close();
    return promise;
  }
}

describe('signaling relay', () => {
  let server: RunningServer;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
  });

  test('joining alone gets acknowledged with no peer-joined', async () => {
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await expect(monitor.next()).resolves.toEqual({ type: 'joined', role: 'monitor' });
    await monitor.close();
  });

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

    // parent1 is not closed here: the server already closed its connection
    // when parent2 superseded it (that's what this test exercises) — its
    // 'close' event fired before a listener could ever be attached for it,
    // so awaiting a fresh TestClient.close() on it here would wait on an
    // event that will never come again.
    await monitor.close();
    await parent2.close();
  });

  test('two different rooms do not see each other\'s signals', async () => {
    const monitorA = await TestClient.connect(server.url);
    monitorA.send({ type: 'join', room: 'roomA', role: 'monitor' });
    await monitorA.next();

    const parentB = await TestClient.connect(server.url);
    parentB.send({ type: 'join', room: 'roomB', role: 'parent', deviceId: 'dev-b' });
    await parentB.next();

    monitorA.send({ type: 'signal', payload: 'hello', to: 'dev-b' });

    // Proving a negative ("parentB never receives anything") has no event to
    // await — this is the documented exception for a genuine wall-clock
    // wait: a short race against the message event is the only way to
    // observe silence, not a stand-in for a condition we could await instead.
    const gotSomething = await Promise.race([
      parentB.next().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(gotSomething).toBe(false);

    await monitorA.close();
    await parentB.close();
  });

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

  test('a room can be reused after both peers leave', async () => {
    const monitor1 = await TestClient.connect(server.url);
    monitor1.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor1.next();
    await monitor1.close();

    const monitor2 = await TestClient.connect(server.url);
    monitor2.send({ type: 'join', room: 'r1', role: 'monitor' });
    await expect(monitor2.next()).resolves.toEqual({ type: 'joined', role: 'monitor' });
    await monitor2.close();
  });

  test('sending signal before joining is rejected', async () => {
    const client = await TestClient.connect(server.url);
    client.send({ type: 'signal', payload: 'x' });
    await expect(client.next()).resolves.toEqual({ type: 'error', message: 'must-join-first' });
    await client.close();
  });

  test('malformed JSON is rejected', async () => {
    const client = await TestClient.connect(server.url);
    client.sendRaw('not json');
    await expect(client.next()).resolves.toEqual({ type: 'error', message: 'invalid-message' });
    await client.close();
  });
});

describe('room TTL', () => {
  // A real (not faked) short duration: mixing Jest fake timers with real
  // socket I/O is fragile (the `ws`/net internals have their own timers),
  // so this exercises the actual wall clock at a duration short enough to
  // keep the suite fast — the documented exception for genuine timing
  // behavior, not a stand-in for an awaitable condition.
  const SHORT_TTL_MS = 60;

  test('a lone peer is disconnected with room-expired once the TTL elapses', async () => {
    const server = await startServer({ roomTtlMs: SHORT_TTL_MS });
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next(); // joined

    await expect(monitor.next()).resolves.toEqual({ type: 'error', message: 'room-expired' });

    await monitor.close();
    await server.close();
  });

  test('the TTL timer is disarmed once a second peer joins', async () => {
    const server = await startServer({ roomTtlMs: SHORT_TTL_MS });
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });
    await parent.next();
    await monitor.next(); // peer-joined
    await parent.next(); // peer-joined

    // Outlast the TTL that would have fired had the room stayed at one peer.
    await new Promise((resolve) => setTimeout(resolve, SHORT_TTL_MS * 3));
    monitor.send({ type: 'signal', payload: 'still-alive', to: 'dev-1' });
    await expect(parent.next()).resolves.toEqual({ type: 'signal', payload: 'still-alive' });

    await monitor.close();
    await parent.close();
    await server.close();
  });

  test('a room dropping back to one peer gets a fresh TTL window', async () => {
    const server = await startServer({ roomTtlMs: SHORT_TTL_MS });
    const monitor = await TestClient.connect(server.url);
    monitor.send({ type: 'join', room: 'r1', role: 'monitor' });
    await monitor.next();

    const parent = await TestClient.connect(server.url);
    parent.send({ type: 'join', room: 'r1', role: 'parent', deviceId: 'dev-1' });
    await parent.next();
    await monitor.next(); // peer-joined
    await parent.next(); // peer-joined

    await parent.close(); // room drops back to one peer (monitor)
    await expect(monitor.next()).resolves.toEqual({ type: 'peer-left', deviceId: 'dev-1' });
    await expect(monitor.next()).resolves.toEqual({ type: 'error', message: 'room-expired' });

    await monitor.close();
    await server.close();
  });
});

describe('per-IP join rate limiting', () => {
  test('further join attempts past the budget are rejected with rate-limited', async () => {
    const server = await startServer({ rateLimitMax: 3, rateLimitWindowMs: 60_000 });

    for (let i = 0; i < 3; i++) {
      const client = await TestClient.connect(server.url);
      client.send({ type: 'join', room: `room${i}`, role: 'monitor' });
      await expect(client.next()).resolves.toEqual({ type: 'joined', role: 'monitor' });
      await client.close();
    }

    const fourth = await TestClient.connect(server.url);
    fourth.send({ type: 'join', room: 'room4', role: 'monitor' });
    await expect(fourth.next()).resolves.toEqual({ type: 'error', message: 'rate-limited' });
    await fourth.close();

    await server.close();
  });

  test('the budget resets once the window elapses', async () => {
    const SHORT_WINDOW_MS = 60;
    const server = await startServer({ rateLimitMax: 1, rateLimitWindowMs: SHORT_WINDOW_MS });

    const first = await TestClient.connect(server.url);
    first.send({ type: 'join', room: 'roomA', role: 'monitor' });
    await expect(first.next()).resolves.toEqual({ type: 'joined', role: 'monitor' });
    await first.close();

    const second = await TestClient.connect(server.url);
    second.send({ type: 'join', room: 'roomB', role: 'monitor' });
    await expect(second.next()).resolves.toEqual({ type: 'error', message: 'rate-limited' });
    await second.close();

    await new Promise((resolve) => setTimeout(resolve, SHORT_WINDOW_MS * 2));

    const third = await TestClient.connect(server.url);
    third.send({ type: 'join', room: 'roomC', role: 'monitor' });
    await expect(third.next()).resolves.toEqual({ type: 'joined', role: 'monitor' });
    await third.close();

    await server.close();
  });
});
