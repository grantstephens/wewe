/**
 * Describes live per-monitor connection state for the persistent
 * foreground-service notification (see platform/foregroundService.ts) —
 * the notification already exists and is already persistent (`ongoing:
 * true`); this only changes its body text from a static "Watching N
 * monitors" count to something that reflects whether they're actually
 * reachable right now.
 */
export function describeConnectionStates(states: string[]): string {
  const total = states.length;
  if (total === 0) return 'No monitors paired';

  const connected = states.filter((s) => s === 'connected').length;

  if (connected === total) {
    return total === 1 ? 'Monitor connected' : `All ${total} monitors connected`;
  }
  if (connected === 0) {
    return total === 1 ? 'Reconnecting…' : `Reconnecting to ${total} monitors…`;
  }
  return `${connected} of ${total} connected`;
}
