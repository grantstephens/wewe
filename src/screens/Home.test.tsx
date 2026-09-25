import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import type { ParentSessionState, ParentSessionsValue } from '../ParentSessionsContext';
import type { Store } from '../domain/store';
import { openNodeSqlite } from '../storage/nodeSqlite';
import { SqliteStore } from '../storage/SqliteStore';
import { lightTheme } from '../theme';
import { WeweProvider } from '../WeweContext';
import { HomeScreen } from './Home';

// See this plan's Task 8 note: importing ParentSessionsContext (and
// transitively ParentSession -> react-native-webrtc) crashes at import time
// under jest-expo with no mock in place. Home.tsx's own logic is what's
// under test here, not session/WebRTC behavior — mocking at this boundary,
// the same one Home.tsx itself depends on, keeps that logic covered without
// ever needing a real (or globally faked) native module.
let mockSessionsValue: ParentSessionsValue;
jest.mock('../ParentSessionsContext', () => ({
  useParentSessions: () => mockSessionsValue,
}));

let store: Store;
beforeEach(async () => {
  store = await SqliteStore.open(openNodeSqlite(':memory:'));
  mockSessionsValue = {
    states: new Map(),
    getSession: () => undefined,
    startTalking: async () => {},
    stopTalking: () => {},
    setInviteMode: () => {},
    renameMonitor: jest.fn(),
  };
});
afterEach(async () => {
  await store.close();
});

function stateFor(overrides: Partial<ParentSessionState> & { monitor: ParentSessionState['monitor'] }): ParentSessionState {
  return {
    relayUrl: 'wss://relay.example.com',
    connectionState: 'idle',
    reconnecting: null,
    connectTimedOut: false,
    rejected: null,
    talking: false,
    invitingListener: false,
    inviteCode: null,
    monitorName: null,
    ...overrides,
  };
}

function renderHome(navigate: jest.Mock) {
  return render(
    <PaperProvider theme={lightTheme}>
      <WeweProvider store={store}>
        <HomeScreen
          navigation={{ navigate } as never}
          route={{ key: 'Home', name: 'Home' } as never}
        />
      </WeweProvider>
    </PaperProvider>,
  );
}

test('shows the empty state with no paired monitors', async () => {
  await renderHome(jest.fn());
  await screen.findByText(/No monitors paired yet/);
});

test('lists a paired monitor once one exists', async () => {
  const monitor = { id: 'm1', label: 'Nursery', roomId: '482913', addedAt: '2026-09-20T08:00:00Z' };
  await store.addMonitor(monitor);
  mockSessionsValue.states.set('m1', stateFor({ monitor, connectionState: 'connected' }));
  await renderHome(jest.fn());
  await screen.findByText('Nursery');
  await screen.findByText(/Connected/);
});

test('shows a not-yet-connected status for a monitor with no session state yet', async () => {
  await store.addMonitor({ id: 'm1', label: 'Nursery', roomId: '482913', addedAt: '2026-09-20T08:00:00Z' });
  await renderHome(jest.fn());
  await screen.findByText('Nursery');
  await screen.findByText(/Connecting/);
});

test('tapping "Use this device as a monitor" navigates to Monitor', async () => {
  const navigate = jest.fn();
  await renderHome(navigate);
  await fireEvent.press(await screen.findByText('Use this device as a monitor'));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('Monitor'));
});

test('tapping a paired monitor navigates to Parent with its id', async () => {
  const monitor = { id: 'm1', label: 'Nursery', roomId: '482913', addedAt: '2026-09-20T08:00:00Z' };
  await store.addMonitor(monitor);
  mockSessionsValue.states.set('m1', stateFor({ monitor }));
  const navigate = jest.fn();
  await renderHome(navigate);
  await fireEvent.press(await screen.findByText('Nursery'));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('Parent', { monitorId: 'm1' }));
});
