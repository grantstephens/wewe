import { generateDeviceId, getOrCreateDeviceId, getOrCreateMonitorRoomId } from './deviceId';
import { SETTINGS_KEYS, type Store } from './store';

function fakeStore(initial: Record<string, string> = {}): Store {
  const settings = new Map(Object.entries(initial));
  return {
    addMonitor: async () => {},
    monitors: async () => [],
    removeMonitor: async () => {},
    appendEvent: async () => {},
    events: async () => [],
    getSetting: async (key) => settings.get(key) ?? null,
    setSetting: async (key, value) => {
      settings.set(key, value);
    },
    isListenerAuthorized: async () => false,
    authorizeListener: async () => {},
    close: async () => {},
  };
}

describe('generateDeviceId', () => {
  test('produces a 32-character lowercase hex string with the default RNG', () => {
    expect(generateDeviceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  test('is deterministic under an injected RNG, matching generatePairingCode\'s pattern', () => {
    let calls = 0;
    const fixed = () => {
      calls += 1;
      return 0;
    };
    expect(generateDeviceId(fixed)).toBe('0'.repeat(32));
    expect(calls).toBe(16);
  });
});

describe('getOrCreateDeviceId', () => {
  test('generates and persists one on first use', async () => {
    const store = fakeStore();
    const id = await getOrCreateDeviceId(store);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await expect(store.getSetting(SETTINGS_KEYS.deviceId)).resolves.toBe(id);
  });

  test('returns the same id on every subsequent call', async () => {
    const store = fakeStore();
    const first = await getOrCreateDeviceId(store);
    const second = await getOrCreateDeviceId(store);
    expect(second).toBe(first);
  });

  test('returns an already-persisted id without generating a new one', async () => {
    const store = fakeStore({ [SETTINGS_KEYS.deviceId]: 'existing-id' });
    await expect(getOrCreateDeviceId(store)).resolves.toBe('existing-id');
  });
});

describe('getOrCreateMonitorRoomId', () => {
  test('generates and persists one on first use', async () => {
    const store = fakeStore();
    const id = await getOrCreateMonitorRoomId(store);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await expect(store.getSetting(SETTINGS_KEYS.monitorRoomId)).resolves.toBe(id);
  });

  test('returns the same id on every subsequent call', async () => {
    const store = fakeStore();
    const first = await getOrCreateMonitorRoomId(store);
    const second = await getOrCreateMonitorRoomId(store);
    expect(second).toBe(first);
  });

  test('returns an already-persisted id without generating a new one', async () => {
    const store = fakeStore({ [SETTINGS_KEYS.monitorRoomId]: 'existing-room-id' });
    await expect(getOrCreateMonitorRoomId(store)).resolves.toBe('existing-room-id');
  });

  test('is independent of the Parent-side deviceId, even in the same store', async () => {
    const store = fakeStore();
    const deviceId = await getOrCreateDeviceId(store);
    const roomId = await getOrCreateMonitorRoomId(store);
    expect(roomId).not.toBe(deviceId);
  });
});
