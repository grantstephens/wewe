import type { ActivityEvent } from './activityLog';

/** A monitor a parent has paired with, remembered so it can be reconnected to without repairing. */
export interface PairedMonitor {
  id: string;
  label: string;
  /**
   * The Monitor's persistent, unguessable relay room id — never a displayed
   * pairing code. Learned from the relay's `joined` ack on first pairing
   * (see `src/webrtc/signalingClient.ts`'s `onJoined` handler) and updated
   * in place if it wasn't already known at record-creation time (see
   * `AddMonitor.tsx`); every reconnect after that uses this directly,
   * never a rotating code.
   */
  roomId: string;
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

  /** isListenerAuthorized returns true iff this deviceId has previously been let in (see authorizeListener). Global to this installation — a device only ever monitors as itself, so there's no "which monitor" to scope it to. */
  isListenerAuthorized(deviceId: string): Promise<boolean>;

  /** authorizeListener remembers a deviceId as authorized. Calling it again for an already-authorized deviceId is not an error. */
  authorizeListener(deviceId: string): Promise<void>;

  /** close releases the underlying resources. */
  close(): Promise<void>;
}

/** Well-known `getSetting`/`setSetting` keys, kept in one place so a typo can't silently create a second setting. */
export const SETTINGS_KEYS = {
  signalingServerUrl: 'signalingServerUrl',
  noiseGateSensitivity: 'noiseGateSensitivity',
  deviceId: 'deviceId',
  /** This install's persistent, never-displayed relay room id when acting as a Monitor — see `getOrCreateMonitorRoomId`. */
  monitorRoomId: 'monitorRoomId',
  /** This install's current display name when acting as a Monitor — see `getOrCreateMonitorName`/`setMonitorName` in `src/domain/monitorName.ts`. */
  monitorName: 'monitorName',
} as const;

/**
 * The convenience default for `SETTINGS_KEYS.signalingServerUrl` when
 * nothing's been explicitly configured — a relay the project maintainer
 * runs, not a hard requirement. Settings screen still lets anyone point at
 * their own instead; this just means the app works out of the box rather
 * than every install needing `signal-server` self-hosted before pairing
 * works at all.
 */
export const DEFAULT_SIGNALING_SERVER_URL = 'wss://wewe-api.hub13.xyz';
