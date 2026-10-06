import { act, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

/**
 * Kept in its own file, not merged into ParentSessionsContext.test.tsx:
 * both files render the same ParentSessionsProvider under jest-expo's fake
 * timers, and running them in the same file (same module registry) left
 * the second describe block's React tree never mounting (`useParentSessions`
 * context staying null even after many flushes) — each test passed cleanly
 * in isolation, so this is a same-file RTL/fake-timer interaction, not a
 * production bug. Splitting sidesteps it: Jest gives each test file its own
 * module registry.
 */
let capturedEvents: Record<string, (...args: any[]) => void> = {};
const mockStart = jest.fn().mockResolvedValue(undefined);
const mockGetRemoteAudioLevel = jest.fn().mockResolvedValue(null);

jest.mock('./webrtc/parentSession', () => ({
  ParentSession: jest.fn().mockImplementation((_options: unknown, events: Record<string, (...args: any[]) => void>) => {
    capturedEvents = events;
    return {
      start: mockStart,
      stop: jest.fn(),
      getRemoteAudioLevel: mockGetRemoteAudioLevel,
      setListenRequest: jest.fn(),
      setInviteMode: jest.fn(),
      renameMonitor: jest.fn(),
      startTalking: jest.fn().mockResolvedValue(undefined),
      stopTalking: jest.fn(),
    };
  }),
}));

jest.mock('./platform/foregroundService', () => ({
  AndroidForegroundServiceType: {
    FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK: 'mediaPlayback',
    FOREGROUND_SERVICE_TYPE_MICROPHONE: 'microphone',
  },
  startForegroundSession: jest.fn().mockResolvedValue(undefined),
  stopForegroundSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./platform/alerts', () => ({
  fireConnectionLostAlert: jest.fn().mockResolvedValue(undefined),
  fireCryAlert: (...args: unknown[]) => mockFireCryAlert(...args),
}));
const mockFireCryAlert = jest.fn().mockResolvedValue(undefined);

jest.mock('./platform/sounds', () => ({
  playBeep: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line import/first -- must follow the jest.mock(...) calls above
import { ParentSessionsProvider, useParentSessions, type ParentSessionsValue } from './ParentSessionsContext';
import type { PairedMonitor, Store } from './domain/store';
import { openNodeSqlite } from './storage/nodeSqlite';
import { SqliteStore } from './storage/SqliteStore';
import { lightTheme } from './theme';
import { WeweProvider } from './WeweContext';

const monitor: PairedMonitor = {
  id: 'monitor-1',
  label: 'Nursery',
  roomId: 'room-1',
  addedAt: '2026-01-01T00:00:00Z',
};

let store: Store;

let latestSessionsValue: ParentSessionsValue | null = null;
function Consumer() {
  latestSessionsValue = useParentSessions();
  return null;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  jest.useFakeTimers();
  store = await SqliteStore.open(openNodeSqlite(':memory:'));
  await store.addMonitor(monitor);
  mockStart.mockClear();
  mockFireCryAlert.mockClear();
  mockGetRemoteAudioLevel.mockReset().mockResolvedValue(null);
  capturedEvents = {};
  latestSessionsValue = null;
});

afterEach(async () => {
  await flush();
  await store.close();
  jest.useRealTimers();
});

function renderProvider() {
  return render(
    <PaperProvider theme={lightTheme}>
      <WeweProvider store={store}>
        <ParentSessionsProvider>
          <Consumer />
        </ParentSessionsProvider>
      </WeweProvider>
    </PaperProvider>,
  );
}

describe('ParentSessionsProvider — Listen vs. cry alerting', () => {
  it('does not raise a cry alert from audio opened by a Listen request', async () => {
    // instantAlertDb defaults to -18 — a single loud sample fed through the
    // classifier alerts immediately, so a loud resolved level here is a
    // faithful stand-in for "Listen is genuinely routing live audio".
    mockGetRemoteAudioLevel.mockResolvedValue(-10);
    renderProvider();
    await flush();
    await flush();

    expect(latestSessionsValue).not.toBeNull();
    act(() => {
      latestSessionsValue!.setListening('monitor-1', true);
    });
    await flush();

    // Two 500ms poll-interval ticks while Listen is on.
    await flush(500);
    await flush(500);

    expect(mockGetRemoteAudioLevel.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockFireCryAlert).not.toHaveBeenCalled();
  });
});
