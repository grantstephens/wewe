import type { ActivityEvent } from '../domain/activityLog';
import type { PairedMonitor, Store } from '../domain/store';

function monitor(id: string, addedAt: string, label = 'Nursery'): PairedMonitor {
  return { id, label, lastPairingCode: '482913', addedAt };
}

function event(id: string, monitorId: string, occurredAt: string, kind: ActivityEvent['kind'] = 'noise'): ActivityEvent {
  return { id, monitorId, kind, occurredAt };
}

/**
 * runStoreContract executes the full behavioural contract against stores
 * produced by newStore. Each test gets a fresh, empty store. Same shared-
 * contract pattern as the sibling DriveWell project: add a case here, never
 * to SqliteStore's own test file, so a future second backend can't drift
 * from what the tests actually exercise.
 */
export function runStoreContract(name: string, newStore: () => Promise<Store>): void {
  describe(name, () => {
    let store: Store;

    beforeEach(async () => {
      store = await newStore();
    });

    afterEach(async () => {
      await store.close();
    });

    test('monitors is empty for an empty store', async () => {
      await expect(store.monitors()).resolves.toEqual([]);
    });

    test('addMonitor then monitors round-trips every field', async () => {
      const m = monitor('m1', '2026-09-20T08:00:00Z');
      await store.addMonitor(m);
      await expect(store.monitors()).resolves.toEqual([m]);
    });

    test('monitors come back ascending by addedAt regardless of write order', async () => {
      await store.addMonitor(monitor('m1', '2026-09-21T08:00:00Z'));
      await store.addMonitor(monitor('m2', '2026-09-19T08:00:00Z'));
      await store.addMonitor(monitor('m3', '2026-09-20T08:00:00Z'));
      const ids = (await store.monitors()).map((m) => m.id);
      expect(ids).toEqual(['m2', 'm3', 'm1']);
    });

    test('addMonitor with the same id replaces rather than duplicating', async () => {
      await store.addMonitor(monitor('m1', '2026-09-20T08:00:00Z', 'Nursery'));
      await store.addMonitor(monitor('m1', '2026-09-20T08:00:00Z', 'Kids room'));
      const all = await store.monitors();
      expect(all).toHaveLength(1);
      expect(all[0]!.label).toBe('Kids room');
    });

    test('removeMonitor forgets the monitor', async () => {
      await store.addMonitor(monitor('m1', '2026-09-20T08:00:00Z'));
      await store.removeMonitor('m1');
      await expect(store.monitors()).resolves.toEqual([]);
    });

    test('removeMonitor on an unknown id is not an error', async () => {
      await expect(store.removeMonitor('nope')).resolves.toBeUndefined();
    });

    test('removeMonitor also erases that monitor\'s activity log', async () => {
      await store.addMonitor(monitor('m1', '2026-09-20T08:00:00Z'));
      await store.appendEvent(event('e1', 'm1', '2026-09-20T08:01:00Z'));
      await store.removeMonitor('m1');
      await expect(store.events('m1')).resolves.toEqual([]);
    });

    test('events is empty for a monitor with no activity', async () => {
      await expect(store.events('m1')).resolves.toEqual([]);
    });

    test('appendEvent then events round-trips every field, including detail', async () => {
      const e: ActivityEvent = { id: 'e1', monitorId: 'm1', kind: 'cry_alert', occurredAt: '2026-09-20T08:00:00Z', detail: 'loud' };
      await store.appendEvent(e);
      await expect(store.events('m1')).resolves.toEqual([e]);
    });

    test('events come back most-recent-first regardless of write order', async () => {
      await store.appendEvent(event('e1', 'm1', '2026-09-20T08:00:00Z'));
      await store.appendEvent(event('e2', 'm1', '2026-09-20T08:02:00Z'));
      await store.appendEvent(event('e3', 'm1', '2026-09-20T08:01:00Z'));
      const ids = (await store.events('m1')).map((e) => e.id);
      expect(ids).toEqual(['e2', 'e3', 'e1']);
    });

    test('events only returns entries for the requested monitor', async () => {
      await store.appendEvent(event('e1', 'm1', '2026-09-20T08:00:00Z'));
      await store.appendEvent(event('e2', 'm2', '2026-09-20T08:00:00Z'));
      await expect(store.events('m1')).resolves.toEqual([event('e1', 'm1', '2026-09-20T08:00:00Z')]);
    });

    test('events respects the limit, keeping the most recent', async () => {
      for (let i = 0; i < 5; i++) {
        await store.appendEvent(event(`e${i}`, 'm1', `2026-09-20T08:0${i}:00Z`));
      }
      const ids = (await store.events('m1', 2)).map((e) => e.id);
      expect(ids).toEqual(['e4', 'e3']);
    });

    test('getSetting is null for a never-set key', async () => {
      await expect(store.getSetting('relayUrl')).resolves.toBeNull();
    });

    test('setSetting then getSetting round-trips the value', async () => {
      await store.setSetting('relayUrl', 'wss://relay.example.com');
      await expect(store.getSetting('relayUrl')).resolves.toBe('wss://relay.example.com');
    });

    test('setSetting with the same key replaces rather than duplicating', async () => {
      await store.setSetting('relayUrl', 'wss://one.example.com');
      await store.setSetting('relayUrl', 'wss://two.example.com');
      await expect(store.getSetting('relayUrl')).resolves.toBe('wss://two.example.com');
    });

    test('settings are independent per key', async () => {
      await store.setSetting('relayUrl', 'wss://relay.example.com');
      await expect(store.getSetting('noiseGateSensitivity')).resolves.toBeNull();
    });
  });
}
