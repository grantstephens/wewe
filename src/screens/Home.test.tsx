import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import type { Store } from '../domain/store';
import { openNodeSqlite } from '../storage/nodeSqlite';
import { SqliteStore } from '../storage/SqliteStore';
import { lightTheme } from '../theme';
import { WeweProvider } from '../WeweContext';
import { HomeScreen } from './Home';

let store: Store;
beforeEach(async () => {
  store = await SqliteStore.open(openNodeSqlite(':memory:'));
});
afterEach(async () => {
  await store.close();
});

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
  await store.addMonitor({ id: 'm1', label: 'Nursery', lastPairingCode: '482913', addedAt: '2026-09-20T08:00:00Z' });
  await renderHome(jest.fn());
  await screen.findByText('Nursery');
});

test('tapping "Use this device as a monitor" navigates to Monitor', async () => {
  const navigate = jest.fn();
  await renderHome(navigate);
  await fireEvent.press(await screen.findByText('Use this device as a monitor'));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('Monitor'));
});

test('tapping a paired monitor navigates to Parent with its id', async () => {
  await store.addMonitor({ id: 'm1', label: 'Nursery', lastPairingCode: '482913', addedAt: '2026-09-20T08:00:00Z' });
  const navigate = jest.fn();
  await renderHome(navigate);
  await fireEvent.press(await screen.findByText('Nursery'));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('Parent', { monitorId: 'm1' }));
});
