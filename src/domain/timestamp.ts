/**
 * Activity-log timestamps are RFC3339 UTC with no fractional seconds,
 * everywhere: storage, and any future export. Lexicographic order on the
 * result is chronological order. Same convention as the sibling DriveWell
 * project's `domain/timestamp.ts`.
 */
export function formatTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}
