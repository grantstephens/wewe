import type { ActivityEvent } from '../domain/activityLog';
import type { PairedMonitor, Store } from '../domain/store';
import { formatTimestamp } from '../domain/timestamp';
import type { SqlDatabase } from './sql';

const MONITOR_COLUMNS = 'id, label, lastPairingCode, addedAt';
const EVENT_COLUMNS = 'id, monitorId, kind, occurredAt, detail';

const PUT_MONITOR = `
  INSERT INTO monitors (${MONITOR_COLUMNS})
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    label = excluded.label,
    lastPairingCode = excluded.lastPairingCode
`;

const DEFAULT_EVENT_LIMIT = 200;

interface MonitorRow {
  id: string;
  label: string;
  lastPairingCode: string;
  addedAt: string;
}
function toMonitor(row: MonitorRow): PairedMonitor {
  // Copied field by field rather than spread: node:sqlite returns
  // null-prototype objects, and this keeps a plain one crossing the boundary.
  return { id: row.id, label: row.label, lastPairingCode: row.lastPairingCode, addedAt: row.addedAt };
}

interface EventRow {
  id: string;
  monitorId: string;
  kind: string;
  occurredAt: string;
  detail: string | null;
}
function toEvent(row: EventRow): ActivityEvent {
  const event: ActivityEvent = {
    id: row.id,
    monitorId: row.monitorId,
    kind: row.kind as ActivityEvent['kind'],
    occurredAt: row.occurredAt,
  };
  if (row.detail !== null) event.detail = row.detail;
  return event;
}

/**
 * SqliteStore is the app's Store: one row per paired monitor keyed by id,
 * one row per activity-log entry keyed by its own id. `addedAt`/`occurredAt`
 * are fixed-width RFC3339 UTC (see domain/timestamp.ts), so `ORDER BY` on
 * either is chronological with no secondary index.
 */
export class SqliteStore implements Store {
  private constructor(private readonly db: SqlDatabase) {}

  static async open(db: SqlDatabase): Promise<SqliteStore> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS monitors (
        id              TEXT PRIMARY KEY NOT NULL,
        label           TEXT NOT NULL,
        lastPairingCode TEXT NOT NULL,
        addedAt         TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY NOT NULL,
        monitorId   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        occurredAt  TEXT NOT NULL,
        detail      TEXT
      );
      CREATE INDEX IF NOT EXISTS events_by_monitor ON events (monitorId, occurredAt);
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authorized_listeners (
        deviceId TEXT PRIMARY KEY NOT NULL,
        addedAt  TEXT NOT NULL
      );
    `);
    return new SqliteStore(db);
  }

  async addMonitor(monitor: PairedMonitor): Promise<void> {
    await this.db.run(PUT_MONITOR, [monitor.id, monitor.label, monitor.lastPairingCode, monitor.addedAt]);
  }

  async monitors(): Promise<PairedMonitor[]> {
    const rows = await this.db.all<MonitorRow>(`SELECT ${MONITOR_COLUMNS} FROM monitors ORDER BY addedAt`);
    return rows.map(toMonitor);
  }

  async removeMonitor(id: string): Promise<void> {
    await this.db.run('DELETE FROM monitors WHERE id = ?', [id]);
    await this.db.run('DELETE FROM events WHERE monitorId = ?', [id]);
  }

  async appendEvent(event: ActivityEvent): Promise<void> {
    await this.db.run(`INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [
      event.id,
      event.monitorId,
      event.kind,
      event.occurredAt,
      event.detail ?? null,
    ]);
  }

  async events(monitorId: string, limit = DEFAULT_EVENT_LIMIT): Promise<ActivityEvent[]> {
    const rows = await this.db.all<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE monitorId = ? ORDER BY occurredAt DESC LIMIT ?`,
      [monitorId, limit],
    );
    return rows.map(toEvent);
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.db.all<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  async isListenerAuthorized(deviceId: string): Promise<boolean> {
    const rows = await this.db.all<{ deviceId: string }>('SELECT deviceId FROM authorized_listeners WHERE deviceId = ?', [
      deviceId,
    ]);
    return rows.length > 0;
  }

  async authorizeListener(deviceId: string): Promise<void> {
    // addedAt is diagnostic-only (never surfaced in the UI today), so it's
    // computed here rather than threaded through every call site — unlike
    // addMonitor/appendEvent's addedAt/occurredAt, which are
    // domain-meaningful and always caller-supplied.
    await this.db.run(
      'INSERT INTO authorized_listeners (deviceId, addedAt) VALUES (?, ?) ON CONFLICT(deviceId) DO NOTHING',
      [deviceId, formatTimestamp(new Date())],
    );
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
