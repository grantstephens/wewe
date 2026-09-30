import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

// expo-audio's native module isn't available under jest-expo, and its own
// module-scope code patches AudioModule.AudioPlayer.prototype at import
// time (not lazily) — importing it unmocked crashes immediately with
// "Cannot read properties of undefined (reading 'prototype')", regardless
// of whether audio playback is actually exercised by a given test. Same
// structural issue this codebase already handles per-file for
// react-native-webrtc (see parentSession.test.ts/monitorSession.test.ts).
jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({ play: jest.fn(), release: jest.fn() })),
}));

// eslint-disable-next-line import/first -- must follow jest.mock('expo-audio', ...) above
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
