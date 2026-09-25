import { SqliteStore } from './SqliteStore';
import { openNodeSqlite } from './nodeSqlite';
import { runStoreContract } from './storeContract';
import type { SqlDatabase } from './sql';

// The shared behavioural contract, run against real SQLite via node:sqlite —
// the whole point of the SqlDatabase seam. expo-sqlite on device runs the
// identical queries through the identical store code.
runStoreContract('SqliteStore (node:sqlite)', () => SqliteStore.open(openNodeSqlite(':memory:')));

// Fault injection the shared contract cannot express: a write that fails
// mid-flight must not leave a phantom row readable afterwards.
test('SqliteStore: a failed addMonitor leaves no trace', async () => {
  const store = await SqliteStore.open(openNodeSqlite(':memory:'));
  try {
    await expect(
      store.addMonitor({
        // id is the NOT NULL primary key: null makes the write fail where no
        // amount of odd strings can.
        id: null as unknown as string,
        label: 'Nursery',
        roomId: '482913',
        addedAt: '2026-09-20T08:00:00Z',
      }),
    ).rejects.toThrow();
    await expect(store.monitors()).resolves.toEqual([]);
  } finally {
    await store.close();
  }
});

// Reproduces a real, on-device bug: a device that installed the app before
// the 2026-09-25 pairing-code rework has a `monitors` table with the old
// `lastPairingCode` column, not `roomId`. `CREATE TABLE IF NOT EXISTS` is a
// no-op against an already-existing table, so opening the store on such a
// device crashed every `monitors()` call with "no such column: roomId".
test('SqliteStore: opening a database with the pre-rework lastPairingCode column migrates it to roomId', async () => {
  const db: SqlDatabase = openNodeSqlite(':memory:');
  // Simulates a device's existing on-disk schema from before the rename —
  // deliberately not using SqliteStore.open for this part, since that's the
  // current (already-renamed) schema.
  await db.exec(`
    CREATE TABLE monitors (
      id              TEXT PRIMARY KEY NOT NULL,
      label           TEXT NOT NULL,
      lastPairingCode TEXT NOT NULL,
      addedAt         TEXT NOT NULL
    );
  `);
  await db.run('INSERT INTO monitors (id, label, lastPairingCode, addedAt) VALUES (?, ?, ?, ?)', [
    'm1',
    'Nursery',
    'stable-room-1',
    '2026-09-20T08:00:00Z',
  ]);

  const store = await SqliteStore.open(db);
  try {
    await expect(store.monitors()).resolves.toEqual([
      { id: 'm1', label: 'Nursery', roomId: 'stable-room-1', addedAt: '2026-09-20T08:00:00Z' },
    ]);
    // The migrated store is fully live, not just readable — a rename
    // through the normal write path must keep working afterward too.
    await store.addMonitor({ id: 'm1', label: 'Nursery', roomId: 'stable-room-2', addedAt: '2026-09-20T08:00:00Z' });
    await expect(store.monitors()).resolves.toEqual([
      { id: 'm1', label: 'Nursery', roomId: 'stable-room-2', addedAt: '2026-09-20T08:00:00Z' },
    ]);
  } finally {
    await store.close();
  }
});
