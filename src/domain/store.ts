import type { ActivityEvent } from './activityLog';

/** A monitor a parent has paired with, remembered so it can be reconnected to without repairing. */
export interface PairedMonitor {
  id: string;
  label: string;
  lastPairingCode: string;
  /** RFC3339 UTC. */
  addedAt: string;
}

/**
 * Store persists paired monitors and their activity log.
 *
 * Every method rejects with an Error rather than throwing synchronously or
 * crashing, because a failure on a user's phone must become an alert, not a
 * dead app. Same rule as the sibling DriveWell project's Store.
 */
export interface Store {
  /** addMonitor writes a monitor, replacing any existing monitor with the same id. */
  addMonitor(monitor: PairedMonitor): Promise<void>;

  /** monitors returns every paired monitor, ascending by addedAt. */
  monitors(): Promise<PairedMonitor[]>;

  /** removeMonitor forgets a monitor and its activity log. Removing an unknown id is not an error. */
  removeMonitor(id: string): Promise<void>;

  /** appendEvent writes one activity-log entry. */
  appendEvent(event: ActivityEvent): Promise<void>;

  /** events returns a monitor's activity log, most recent first, capped at `limit` (default 200). */
  events(monitorId: string, limit?: number): Promise<ActivityEvent[]>;

  /** getSetting returns a persisted app setting (relay URL, gate sensitivity, …), or null if never set. */
  getSetting(key: string): Promise<string | null>;

  /** setSetting persists an app setting, replacing any existing value. */
  setSetting(key: string, value: string): Promise<void>;

  /** close releases the underlying resources. */
  close(): Promise<void>;
}

/** Well-known `getSetting`/`setSetting` keys, kept in one place so a typo can't silently create a second setting. */
export const SETTINGS_KEYS = {
  signalingServerUrl: 'signalingServerUrl',
  noiseGateSensitivity: 'noiseGateSensitivity',
} as const;
