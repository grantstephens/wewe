/**
 * The pure state-transition logic behind ParentSessionsContext's per-monitor
 * connect-timeout watchdog: given the previous state and a fresh
 * RTCPeerConnection.connectionState report, decides what changed and
 * whether a "connection lost" alert is warranted.
 *
 * Separated out because ParentSession now tears down and recreates its
 * RTCPeerConnection outright the instant a fresh offer arrives (see
 * parentSession.ts), rather than waiting for the old one to decay through
 * 'disconnected'/'failed' first — that decay was racy, and often never
 * happened before the new offer showed up. A healthy reconnect can now jump
 * straight from 'connected' to 'new'/'connecting' on the replacement pc,
 * skipping 'disconnected'/'failed' entirely. connectStartedAt must still
 * reset whenever a fresh attempt genuinely begins (leaving 'connected'), or
 * the 20s watchdog measures elapsed time from the original connection's
 * start — long since passed — and fires within the very next poll tick even
 * though the reconnect is perfectly healthy.
 */
export interface ConnectWatchdogState {
  connectionState: string;
  connectStartedAt: number;
  wasConnected: boolean;
  connectTimedOut: boolean;
}

export function applyConnectionStateChange(
  prev: ConnectWatchdogState,
  connectionState: string,
  now: number,
): { next: ConnectWatchdogState; fireLostAlert: boolean } {
  if (connectionState === 'connected') {
    return {
      next: { ...prev, connectionState, connectTimedOut: false, wasConnected: true },
      fireLostAlert: false,
    };
  }

  const leavingConnected = prev.connectionState === 'connected';
  const fireLostAlert = (connectionState === 'disconnected' || connectionState === 'failed') && prev.wasConnected;

  return {
    next: {
      ...prev,
      connectionState,
      connectStartedAt: leavingConnected ? now : prev.connectStartedAt,
      wasConnected: fireLostAlert ? false : prev.wasConnected,
    },
    fireLostAlert,
  };
}
