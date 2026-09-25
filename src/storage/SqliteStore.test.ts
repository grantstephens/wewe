import { SqliteStore } from './SqliteStore';
import { openNodeSqlite } from './nodeSqlite';
import { runStoreContract } from './storeContract';

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
