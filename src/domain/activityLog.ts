/**
 * The activity log's event vocabulary. Kept intentionally small and
 * append-only — see `src/storage` for persistence — mirroring DriveWell's
 * "stats are always derived, trips are the only source of truth" rule:
 * here, the log itself is the only source of truth, nothing derives a
 * competing summary that could drift from it.
 */
export type ActivityEventKind = 'noise' | 'cry_alert' | 'connected' | 'disconnected' | 'monitor_added';

export interface ActivityEvent {
  id: string;
  monitorId: string;
  kind: ActivityEventKind;
  /** RFC3339 UTC, see `formatTimestamp`. */
  occurredAt: string;
  detail?: string;
}
