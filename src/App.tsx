import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  DarkTheme as NavigationDarkTheme,
  DefaultTheme as NavigationDefaultTheme,
  NavigationContainer,
} from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ActivityIndicator, adaptNavigationTheme, PaperProvider, Text } from 'react-native-paper';

import type { RootStackParamList } from './navigation';
import { AddMonitorScreen } from './screens/AddMonitor';
import { HomeScreen } from './screens/Home';
import { MonitorScreen } from './screens/Monitor';
import { ParentScreen } from './screens/Parent';
import { SettingsScreen } from './screens/Settings';
import { openStore } from './storage/openStore';
import { darkTheme, lightTheme, type Theme } from './theme';
import type { Store } from './domain/store';
import { ParentSessionsProvider } from './ParentSessionsContext';
import { WeweProvider } from './WeweContext';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Bridges our generated Material 3 palettes into react-navigation's own
 * Theme shape (colors *and* fonts) — computed once, not per render, since
 * neither palette ever changes at runtime. Same pattern as DriveWell.
 */
const { LightTheme: NAV_LIGHT_THEME, DarkTheme: NAV_DARK_THEME } = adaptNavigationTheme({
  reactNavigationLight: NavigationDefaultTheme,
  reactNavigationDark: NavigationDarkTheme,
  materialLight: lightTheme,
  materialDark: darkTheme,
});

export default function App() {
  const scheme = useColorScheme();
  const theme = scheme === 'dark' ? darkTheme : lightTheme;
  const navTheme = scheme === 'dark' ? NAV_DARK_THEME : NAV_LIGHT_THEME;
  const [store, setStore] = useState<Store | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    openStore().then(
      (opened) => {
        if (cancelled) {
          opened.close().catch(() => {});
          return;
        }
        setStore(opened);
      },
      (err: unknown) => {
        if (!cancelled) setFailure(err as Error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PaperProvider theme={theme}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      {failure !== null ? (
        <ErrorScreen error={failure} theme={theme} />
      ) : store === null ? (
        <View style={[styles.centre, { backgroundColor: theme.colors.background }]}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : (
        <SafeAreaProvider>
          <WeweProvider store={store}>
            <ParentSessionsProvider>
              <NavigationContainer theme={navTheme}>
                <Stack.Navigator screenOptions={{ headerShown: true }}>
                  <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Wewe' }} />
                  <Stack.Screen name="Monitor" component={MonitorScreen} options={{ title: 'Monitor' }} />
                  <Stack.Screen name="Parent" component={ParentScreen} options={{ title: 'Watching' }} />
                  <Stack.Screen name="AddMonitor" component={AddMonitorScreen} options={{ title: 'Add a monitor' }} />
                  <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
                </Stack.Navigator>
              </NavigationContainer>
            </ParentSessionsProvider>
          </WeweProvider>
        </SafeAreaProvider>
      )}
    </PaperProvider>
  );
}

function ErrorScreen({ error, theme }: { error: Error; theme: Theme }) {
  return (
    <View style={[styles.centre, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.errorTitle}>
        Could not open your data
      </Text>
      <Text variant="bodyMedium" style={styles.errorBody}>
        {error.message}
      </Text>
      <Text variant="bodyMedium" style={[styles.errorBody, { color: theme.colors.onSurfaceVariant }]}>
        Your paired monitors and activity log are still on this device. Restarting the app is
        usually enough.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorTitle: { marginBottom: 12, textAlign: 'center' },
  errorBody: { textAlign: 'center', marginBottom: 8 },
});
