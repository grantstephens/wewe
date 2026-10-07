import { act, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

/**
 * Kept in its own file — see ParentSessionsContext.listen.test.tsx's header
 * comment for why multiple renders of this provider don't reliably share a
 * file under jest-expo's fake timers.
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
  fireCryAlert: jest.fn().mockResolvedValue(undefined),
}));

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

describe('ParentSessionsProvider — Listen expiry timer reset', () => {
  it('does not let an earlier expiry timer cut off a fresh Listen request started before the first one fires', async () => {
    renderProvider();
    await flush();
    await flush();

    expect(latestSessionsValue).not.toBeNull();

    // First Listen: on, then explicitly off again after 55s (before its own
    // 60s timer would have fired).
    act(() => {
      latestSessionsValue!.setListening('monitor-1', true);
    });
    await flush();
    await flush(55_000);
    act(() => {
      latestSessionsValue!.setListening('monitor-1', false);
    });
    await flush();

    // Immediately start a second, independent Listen request.
    act(() => {
      latestSessionsValue!.setListening('monitor-1', true);
    });
    await flush();
    expect(latestSessionsValue!.states.get('monitor-1')!.listening).toBe(true);

    // 6s later — only 6s into the SECOND request's own 60s window, but
    // 61s past the first request's start. An uncancelled first timer would
    // wrongly fire here and flip listening back off.
    await flush(6_000);
    expect(latestSessionsValue!.states.get('monitor-1')!.listening).toBe(true);
  });
});
