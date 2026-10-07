/**
 * react-native-webrtc ships ESM that jest's "logic" project (plain node
 * environment, no RN transform — see jest.config.js) can't load, so it's
 * mocked wholesale here rather than transformed. Everything below is a
 * minimal stand-in for the real native module's surface, not a faithful
 * reimplementation.
 */
class MockPeerConnection {
  connectionState = 'new';
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { streams: unknown[] }) => void) | null = null;
  closed = false;

  async setRemoteDescription(): Promise<void> {}
  async setLocalDescription(): Promise<void> {}
  async createAnswer(): Promise<{ sdp: string; type: string }> {
    return { sdp: 'fake-answer-sdp', type: 'answer' };
  }
  async createOffer(): Promise<{ sdp: string; type: string }> {
    return { sdp: 'fake-offer-sdp', type: 'offer' };
  }
  async addIceCandidate(): Promise<void> {}
  addedTracks: unknown[] = [];
  addTrack(track: unknown): void {
    this.addedTracks.push(track);
  }
  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return new Map();
  }
  close(): void {
    this.closed = true;
  }
}

const mockPeerConnectionInstances: MockPeerConnection[] = [];

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn().mockImplementation(() => {
    const pc = new MockPeerConnection();
    mockPeerConnectionInstances.push(pc);
    return pc;
  }),
  RTCIceCandidate: jest.fn().mockImplementation((init: unknown) => init),
  RTCSessionDescription: jest.fn().mockImplementation((init: unknown) => init),
  mediaDevices: { getUserMedia: jest.fn() },
}));

// eslint-disable-next-line import/first -- must follow jest.mock('react-native-webrtc', ...) above
import { mediaDevices } from 'react-native-webrtc';
import { ParentSession } from './parentSession';

/** Reaches the private handleSignal — TS privacy is compile-time only, and this is the seam the bug actually lives in. */
function handleSignal(session: ParentSession, payload: unknown): Promise<void> {
  return (session as unknown as { handleSignal(payload: unknown): Promise<void> }).handleSignal(payload);
}

describe('ParentSession — fresh offer while the old peer connection looks alive', () => {
  beforeEach(() => {
    mockPeerConnectionInstances.length = 0;
  });

  it('tears down and creates a new RTCPeerConnection for a fresh offer even if the old one still reports "connected"', async () => {
    const session = new ParentSession({ signalingUrl: 'wss://example.invalid', room: 'room-1', deviceId: 'device-1' });

    await handleSignal(session, { sdp: { sdp: 'offer-1', type: 'offer' } });
    expect(mockPeerConnectionInstances).toHaveLength(1);

    // The exact race this bug lives in: the Monitor already tore down and
    // recreated its own peer (a fresh esp_peer object, new DTLS certs) and
    // sent a brand-new offer, but this side's RTCPeerConnection.connectionState
    // hasn't transitioned away from "connected" yet — libwebrtc's own state
    // propagation lags the Monitor's near-instant local recreation.
    mockPeerConnectionInstances[0]!.connectionState = 'connected';

    await handleSignal(session, { sdp: { sdp: 'offer-2', type: 'offer' } });

    expect(mockPeerConnectionInstances).toHaveLength(2);
    expect(mockPeerConnectionInstances[0]!.closed).toBe(true);
    expect(mockPeerConnectionInstances[1]).not.toBe(mockPeerConnectionInstances[0]);
  });
});

describe('ParentSession — talk-back survives a Monitor-initiated reconnect', () => {
  beforeEach(() => {
    mockPeerConnectionInstances.length = 0;
  });

  it('re-adds the talk-back track to the new RTCPeerConnection created for a fresh offer', async () => {
    const fakeTrack = { enabled: true };
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
      getAudioTracks: () => [fakeTrack],
    });
    const session = new ParentSession({ signalingUrl: 'wss://example.invalid', room: 'room-1', deviceId: 'device-1' });

    await handleSignal(session, { sdp: { sdp: 'offer-1', type: 'offer' } });
    await session.startTalking();
    expect(mockPeerConnectionInstances[0]!.addedTracks).toContain(fakeTrack);

    // The Monitor restarted — a fresh offer tears down and replaces the pc,
    // same as the test above. Before this fix, the new pc never got the
    // talk-back track re-added, so push-to-talk silently transmitted
    // nothing after any Monitor-initiated reconnect.
    await handleSignal(session, { sdp: { sdp: 'offer-2', type: 'offer' } });

    expect(mockPeerConnectionInstances).toHaveLength(2);
    expect(mockPeerConnectionInstances[1]!.addedTracks).toContain(fakeTrack);
  });
});

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
