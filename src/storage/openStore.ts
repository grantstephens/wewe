import type { Store } from '../domain/store';
import { openExpoSqlite } from './expoSqlite';
import { SqliteStore } from './SqliteStore';

/** The database name. Uninstalling the app deletes it — stated plainly, nothing here syncs anywhere. */
const DATABASE = 'wewe.db';

/**
 * openStore opens the app's Store: SQLite on Android via expo-sqlite.
 * Android is the only shipping target, so there is no platform branch — and
 * no test: this file is two delegations, everything it stands for is
 * covered by the contract suite running SqliteStore against node:sqlite.
 */
export async function openStore(): Promise<Store> {
  return SqliteStore.open(await openExpoSqlite(DATABASE));
}
