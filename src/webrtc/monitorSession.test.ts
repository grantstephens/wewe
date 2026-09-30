/**
 * react-native-webrtc ships ESM the "logic" jest project's plain node
 * environment can't load — mocked wholesale, same pattern as
 * parentSession.test.ts.
 */
class MockPeerConnection {
  connectionState = 'new';
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

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

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn().mockImplementation(() => new MockPeerConnection()),
  RTCIceCandidate: jest.fn().mockImplementation((init: unknown) => init),
  RTCSessionDescription: jest.fn().mockImplementation((init: unknown) => init),
  mediaDevices: { getUserMedia: jest.fn() },
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

/**
 * Seams into MonitorSession's private internals — TS privacy is
 * compile-time only. start() is deliberately never called here: it awaits
 * signaling.connect(), which only resolves on a real relay's join ack, so
 * calling it against a fake URL would hang the test forever. localStream
 * and handlePeerJoined are the only pieces of state start() would
 * otherwise have set up that this test actually needs.
 */
function seedLocalStream(session: MonitorSession, tracks: { enabled: boolean }[]): void {
  (session as unknown as { localStream: { getAudioTracks(): { enabled: boolean }[] } }).localStream = {
    getAudioTracks: () => tracks,
  };
}

function handlePeerJoined(session: MonitorSession, deviceId: string): Promise<void> {
  return (session as unknown as { handlePeerJoined(id: string): Promise<void> }).handlePeerJoined(deviceId);
}

function handleSignal(session: MonitorSession, payload: unknown, from: string): Promise<void> {
  return (session as unknown as { handleSignal(payload: unknown, from: string | undefined): Promise<void> }).handleSignal(payload, from);
}

describe('MonitorSession — listenRequest', () => {
  it('opens the gate for an already-connected listener on listenRequest: true, and closes it again on false', async () => {
    const session = new MonitorSession({ signalingUrl: 'wss://example.invalid' }, fakeStore());
    const tracks = [{ enabled: false }]; // simulate the gate currently closed (quiet room)
    seedLocalStream(session, tracks);
    await handlePeerJoined(session, 'device-1');

    await handleSignal(session, { listenRequest: true }, 'device-1');
    expect(tracks.every((t) => t.enabled)).toBe(true);

    await handleSignal(session, { listenRequest: false }, 'device-1');
    expect(tracks.every((t) => !t.enabled)).toBe(true);
  });

  it('ignores a listenRequest from a device that is not an already-connected listener', async () => {
    const session = new MonitorSession({ signalingUrl: 'wss://example.invalid' }, fakeStore());
    const tracks = [{ enabled: false }];
    seedLocalStream(session, tracks);

    await handleSignal(session, { listenRequest: true }, 'unknown-device');
    expect(tracks.every((t) => !t.enabled)).toBe(true);
  });
});
