import { generateMonitorName, getOrCreateMonitorName, setMonitorName } from './monitorName';
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

describe('generateMonitorName', () => {
  test('produces an adjective-animal name using the injected RNG', () => {
    // 0 picks the first adjective and first animal from each list.
    const name = generateMonitorName(() => 0);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  test('is deterministic under an injected RNG', () => {
    const name1 = generateMonitorName(() => 0);
    const name2 = generateMonitorName(() => 0);
    expect(name1).toBe(name2);
  });

  test('varies with a different injected value', () => {
    const first = generateMonitorName(() => 0);
    const second = generateMonitorName((maxExclusive) => maxExclusive - 1);
    expect(first).not.toBe(second);
  });
});

describe('getOrCreateMonitorName', () => {
  test('generates and persists one on first use', async () => {
    const store = fakeStore();
    const name = await getOrCreateMonitorName(store);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    await expect(store.getSetting(SETTINGS_KEYS.monitorName)).resolves.toBe(name);
  });

  test('returns the same name on every subsequent call', async () => {
    const store = fakeStore();
    const first = await getOrCreateMonitorName(store);
    const second = await getOrCreateMonitorName(store);
    expect(second).toBe(first);
  });

  test('returns an already-persisted name without generating a new one', async () => {
    const store = fakeStore({ [SETTINGS_KEYS.monitorName]: 'existing-name' });
    await expect(getOrCreateMonitorName(store)).resolves.toBe('existing-name');
  });
});

describe('setMonitorName', () => {
  test('persists a name, overwriting whatever was there before', async () => {
    const store = fakeStore({ [SETTINGS_KEYS.monitorName]: 'old-name' });
    await setMonitorName(store, 'new-name');
    await expect(store.getSetting(SETTINGS_KEYS.monitorName)).resolves.toBe('new-name');
  });
});
