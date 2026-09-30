import { applyConnectionStateChange, type ConnectWatchdogState } from './connectWatchdog';

const CONNECTED: ConnectWatchdogState = {
  connectionState: 'connected',
  connectStartedAt: 0,
  wasConnected: true,
  connectTimedOut: false,
};

describe('applyConnectionStateChange', () => {
  it('restarts the connect-timeout countdown from now when a fresh reconnect attempt replaces the peer connection outright', () => {
    // ParentSession now tears down and recreates its RTCPeerConnection the
    // instant a fresh offer arrives (see parentSession.ts), rather than
    // waiting for the old one to naturally decay to 'disconnected'/'failed'
    // first — that decay was racy and often never happened before the new
    // offer showed up. So a healthy reconnect can jump straight from
    // 'connected' to 'new'/'connecting' on the new pc, skipping
    // 'disconnected'/'failed' entirely. connectStartedAt must still reset
    // here, or the 20s watchdog measures from the original connection's
    // start time — long since elapsed — and fires within the next poll
    // tick even though the reconnect is perfectly healthy.
    const longAgo = 1_000;
    const now = 10 * 60 * 1000; // ten minutes later — far past any 20s window
    const prev: ConnectWatchdogState = { ...CONNECTED, connectStartedAt: longAgo };

    const { next } = applyConnectionStateChange(prev, 'connecting', now);

    expect(next.connectStartedAt).toBe(now);
  });

  it('does not fire the connection-lost alert for a state that is not disconnected/failed', () => {
    const prev: ConnectWatchdogState = { ...CONNECTED, connectStartedAt: 1_000 };

    const { fireLostAlert } = applyConnectionStateChange(prev, 'connecting', 2_000);

    expect(fireLostAlert).toBe(false);
  });

  it('still fires the connection-lost alert for a genuine disconnected/failed transition', () => {
    const prev: ConnectWatchdogState = { ...CONNECTED, connectStartedAt: 1_000 };

    const { fireLostAlert, next } = applyConnectionStateChange(prev, 'failed', 2_000);

    expect(fireLostAlert).toBe(true);
    expect(next.wasConnected).toBe(false);
  });

  it('clears connectTimedOut once the connection reaches connected again', () => {
    const prev: ConnectWatchdogState = {
      connectionState: 'connecting',
      connectStartedAt: 1_000,
      wasConnected: false,
      connectTimedOut: true,
    };

    const { next } = applyConnectionStateChange(prev, 'connected', 50_000);

    expect(next.connectTimedOut).toBe(false);
    expect(next.wasConnected).toBe(true);
  });

  it('leaves connectStartedAt alone for a state change that was never connected in the first place', () => {
    const prev: ConnectWatchdogState = {
      connectionState: 'new',
      connectStartedAt: 1_000,
      wasConnected: false,
      connectTimedOut: false,
    };

    const { next } = applyConnectionStateChange(prev, 'connecting', 5_000);

    expect(next.connectStartedAt).toBe(1_000);
  });
});
