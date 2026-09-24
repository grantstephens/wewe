import { SignalingClient, type WebSocketFactory, type WebSocketLike } from './signalingClient';
import type { ServerMessage } from './protocol';

/** An in-memory stand-in for the WebSocket API, driven entirely by test code — no real socket, no real wall-clock wait. */
class FakeWebSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  explicitlyClosed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  /** What a real socket's `.close()` does: the app asked to disconnect, and the browser/RN runtime still fires `onclose` afterward. */
  close(): void {
    this.explicitlyClosed = true;
    this.onclose?.();
  }

  simulateOpen(): void {
    this.onopen?.();
  }

  simulateMessage(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** A network-caused disconnect the app never asked for — the case reconnect logic exists for. */
  simulateNetworkDrop(): void {
    this.onclose?.();
  }
}

function fakeFactory(): { factory: WebSocketFactory; sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  const factory: WebSocketFactory = () => {
    const socket = new FakeWebSocket();
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

/** Drives one socket through a successful join handshake. */
function joinSocket(socket: FakeWebSocket): void {
  socket.simulateOpen();
  socket.simulateMessage({ type: 'joined', role: 'parent' });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SignalingClient', () => {
  it('resolves connect() once the relay acknowledges the join', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);

    const connected = client.connect('482913', 'parent', {});
    joinSocket(sockets[0]!);
    await expect(connected).resolves.toBeUndefined();
  });

  it('reconnects after an unexpected disconnect, not after an explicit close', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);
    const onReconnecting = jest.fn();

    await Promise.all([client.connect('482913', 'parent', { onReconnecting }), Promise.resolve(joinSocket(sockets[0]!))]);

    sockets[0]!.simulateNetworkDrop();
    expect(onReconnecting).toHaveBeenCalledWith(1, 500);

    jest.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);

    // Now close explicitly: no further reconnect should be scheduled for this drop.
    onReconnecting.mockClear();
    client.close();
    sockets[1]!.simulateNetworkDrop();
    jest.advanceTimersByTime(60_000);
    expect(onReconnecting).not.toHaveBeenCalled();
  });

  it('fires onReconnected only on a retry, never on the initial connect', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);
    const onReconnected = jest.fn();

    await Promise.all([client.connect('482913', 'parent', { onReconnected }), Promise.resolve(joinSocket(sockets[0]!))]);
    expect(onReconnected).not.toHaveBeenCalled();

    sockets[0]!.simulateNetworkDrop();
    jest.advanceTimersByTime(500);
    joinSocket(sockets[1]!);
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially across repeated disconnects, and resets after a successful reconnect', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);
    const onReconnecting = jest.fn();

    await Promise.all([client.connect('482913', 'parent', { onReconnecting }), Promise.resolve(joinSocket(sockets[0]!))]);

    sockets[0]!.simulateNetworkDrop();
    expect(onReconnecting).toHaveBeenLastCalledWith(1, 500);
    jest.advanceTimersByTime(500);

    sockets[1]!.simulateNetworkDrop();
    expect(onReconnecting).toHaveBeenLastCalledWith(2, 1000);
    jest.advanceTimersByTime(1000);

    // This reconnect succeeds, so the next failure should start from 500 again, not 2000.
    joinSocket(sockets[2]!);
    sockets[2]!.simulateNetworkDrop();
    expect(onReconnecting).toHaveBeenLastCalledWith(1, 500);
  });

  it('sends the join message with the original room and role on every reconnect attempt', async () => {
    const { factory, sockets } = fakeFactory();
    const client = new SignalingClient('ws://relay.example.com', factory);

    await Promise.all([client.connect('482913', 'monitor', {}), Promise.resolve(joinSocket(sockets[0]!))]);
    sockets[0]!.simulateNetworkDrop();
    jest.advanceTimersByTime(500);
    sockets[1]!.simulateOpen();

    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ type: 'join', room: '482913', role: 'monitor' });
  });

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
});
