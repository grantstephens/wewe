import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { SETTINGS_KEYS } from '../domain/store';
import { openNodeSqlite } from '../storage/nodeSqlite';
import { SqliteStore } from '../storage/SqliteStore';
import { lightTheme } from '../theme';
import { WeweProvider } from '../WeweContext';
import { SettingsScreen } from './Settings';
import type { Store } from '../domain/store';

let store: Store;
beforeEach(async () => {
  store = await SqliteStore.open(openNodeSqlite(':memory:'));
});
afterEach(async () => {
  await store.close();
});

function renderSettings() {
  return render(
    <PaperProvider theme={lightTheme}>
      <WeweProvider store={store}>
        <SettingsScreen />
      </WeweProvider>
    </PaperProvider>,
  );
}

test('cry beep toggle defaults on and can be switched off and saved', async () => {
  const { getByText, getByTestId } = await renderSettings();

  await waitFor(() => expect(getByTestId('cry-beep-switch').props.value).toBe(true));

  await fireEvent(getByTestId('cry-beep-switch'), 'onValueChange', false);
  await fireEvent.press(getByText('Save'));

  await waitFor(async () => expect(await store.getSetting(SETTINGS_KEYS.cryBeepEnabled)).toBe('false'));
});
