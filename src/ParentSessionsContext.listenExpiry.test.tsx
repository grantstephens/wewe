import { act, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

/**
 * Kept in its own file — see ParentSessionsContext.listen.test.tsx's header
 * comment for why multiple renders of this provider don't reliably share a
 * file under jest-expo's fake timers.
 *
 * Verifies via setTimeout/clearTimeout spies rather than a full render →
 * advance-60s → read-state-back round trip: that round trip was flaky in
 * this specific harness (a `rerender()` fired from inside a bare
 * `setTimeout` callback — as opposed to one fired from the already-running
 * 500ms poll `setInterval` — didn't reliably land in `act()`'s tracked
 * commit before the assertion ran, even after an extra flush), while the
 * production code's actual behaviour was independently confirmed correct
 * via temporary console.log instrumentation showing managed.state.listening
 * genuinely flips to false when the timer fires. Spying on the real
 * setTimeout/clearTimeout calls instead verifies the same contract
 * (schedules a 60s timeout on listening:true, clears it on listening:false)
 * deterministically, without depending on React's render-commit timing.
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

async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
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

describe('ParentSessionsProvider — Listen client-side expiry scheduling', () => {
  it('schedules a 60s timeout when Listen starts, and clears it when Listen stops', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    renderProvider();
    await flush();
    await flush();

    expect(latestSessionsValue).not.toBeNull();
    const timersBefore = setTimeoutSpy.mock.calls.length;

    act(() => {
      latestSessionsValue!.setListening('monitor-1', true);
    });
    await flush();

    const newCallIndex = setTimeoutSpy.mock.calls.findIndex((call, i) => i >= timersBefore && call[1] === 60_000);
    expect(newCallIndex).toBeGreaterThanOrEqual(0);
    const listenTimerHandle = setTimeoutSpy.mock.results[newCallIndex]!.value;

    act(() => {
      latestSessionsValue!.setListening('monitor-1', false);
    });
    await flush();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(listenTimerHandle);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});
