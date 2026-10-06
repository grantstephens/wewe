import { act, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

/**
 * react-native-webrtc isn't available under jest-expo without a mock (same
 * reason parentSession.test.ts/monitorSession.test.ts mock it) — ParentSession
 * is mocked wholesale here, capturing its constructor's events object so a
 * test can drive onConnectionStateChange directly, the way the real relay
 * would, without a real WebRTC stack or signaling server.
 */
let capturedEvents: Record<string, (...args: any[]) => void> = {};
const mockStart = jest.fn().mockResolvedValue(undefined);

jest.mock('./webrtc/parentSession', () => ({
  ParentSession: jest.fn().mockImplementation((_options: unknown, events: Record<string, (...args: any[]) => void>) => {
    capturedEvents = events;
    return {
      start: mockStart,
      stop: jest.fn(),
      getRemoteAudioLevel: jest.fn().mockResolvedValue(null),
      setListenRequest: jest.fn(),
      setInviteMode: jest.fn(),
      renameMonitor: jest.fn(),
      startTalking: jest.fn().mockResolvedValue(undefined),
      stopTalking: jest.fn(),
    };
  }),
}));

const mockStartForegroundSession = jest.fn().mockResolvedValue(undefined);
jest.mock('./platform/foregroundService', () => ({
  AndroidForegroundServiceType: {
    FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK: 'mediaPlayback',
    FOREGROUND_SERVICE_TYPE_MICROPHONE: 'microphone',
  },
  startForegroundSession: (...args: unknown[]) => mockStartForegroundSession(...args),
  stopForegroundSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./platform/alerts', () => ({
  fireConnectionLostAlert: jest.fn().mockResolvedValue(undefined),
  fireCryAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./platform/sounds', () => ({
  playBeep: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line import/first -- must follow the jest.mock(...) calls above
import { ParentSessionsProvider } from './ParentSessionsContext';
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

/**
 * Deterministically drains pending promise chains (the provider's own
 * startup sequence is plain `.then()` chaining, no timers involved) —
 * replaces real-timer `waitFor` polling, which raced the provider's own
 * real `setInterval` against test assertions and intermittently tripped
 * "database is not open" when a tick's in-flight store read outlived the
 * test's own afterEach.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
}

beforeEach(async () => {
  jest.useFakeTimers();
  store = await SqliteStore.open(openNodeSqlite(':memory:'));
  await store.addMonitor(monitor);
  mockStartForegroundSession.mockClear();
  mockStart.mockClear();
  capturedEvents = {};
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
          <></>
        </ParentSessionsProvider>
      </WeweProvider>
    </PaperProvider>,
  );
}

describe('ParentSessionsProvider — persistent notification', () => {
  it('refreshes the notification text when connection state changes, not only on pair/talk/unpair', async () => {
    renderProvider();
    await flush();
    await flush();

    expect(mockStart).toHaveBeenCalled();
    expect(capturedEvents.onConnectionStateChange).toBeDefined();

    mockStartForegroundSession.mockClear();
    act(() => {
      capturedEvents.onConnectionStateChange!('connected');
    });
    await flush();

    expect(mockStartForegroundSession).toHaveBeenCalled();
    const lastCall = mockStartForegroundSession.mock.calls.at(-1)!;
    expect(lastCall[1]).toBe('Monitor connected');
  });
});
