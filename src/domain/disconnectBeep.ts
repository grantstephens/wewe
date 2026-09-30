/**
 * Decides whether the Parent app should fire a disconnect beep this tick.
 * Deliberately NOT event-driven like fireConnectionLostAlert (which fires
 * once, immediately, on the disconnected/failed transition) — the user
 * explicitly wants a delay before the first beep (so a brief, self-healing
 * reconnect blip — the common case, see this session's ~90s ICE-disconnect
 * investigation — never beeps at all) and a repeat while the problem
 * persists (so a genuinely stuck connection keeps getting noticed).
 */
export function shouldFireDisconnectBeep(
  connectStartedAt: number,
  lastBeepAtMs: number | null,
  now: number,
  thresholdMs: number,
  repeatMs: number,
): boolean {
  const disconnectedForMs = now - connectStartedAt;
  if (disconnectedForMs < thresholdMs) return false;
  if (lastBeepAtMs === null) return true;
  return now - lastBeepAtMs >= repeatMs;
}
