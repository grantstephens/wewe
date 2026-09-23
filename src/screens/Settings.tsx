import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, HelperText, Text, TextInput, useTheme } from 'react-native-paper';

import { SETTINGS_KEYS } from '../domain/store';
import { useWewe } from '../WeweContext';

/**
 * The signaling relay URL has no default baked into the app (see PLAN.md
 * and signal-server/README.md: "There is no default public instance baked
 * into the app"). A user runs their own or points at one they trust, and
 * both Monitor and Parent screens read this same persisted value.
 */
export function SettingsScreen() {
  const theme = useTheme();
  const { store } = useWewe();
  const [relayUrl, setRelayUrl] = React.useState('');
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    store.getSetting(SETTINGS_KEYS.signalingServerUrl).then((value) => setRelayUrl(value ?? ''));
  }, [store]);

  const save = async () => {
    await store.setSetting(SETTINGS_KEYS.signalingServerUrl, relayUrl.trim());
    setSaved(true);
  };

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        Settings
      </Text>

      <Text variant="titleMedium" style={styles.sectionTitle}>
        Signaling server
      </Text>
      <Text variant="bodyMedium" style={styles.help}>
        Wewe has no server of its own beyond this: a small relay that only ever forwards call
        setup, never audio. Run your own (see signal-server/README.md) or point at one you
        trust.
      </Text>
      <TextInput
        label="Relay URL"
        placeholder="wss://relay.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        value={relayUrl}
        onChangeText={(text) => {
          setRelayUrl(text);
          setSaved(false);
        }}
      />
      <HelperText type="info" visible={saved}>
        Saved.
      </HelperText>
      <View style={styles.actions}>
        <Button mode="contained" onPress={save}>
          Save
        </Button>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 24 },
  title: { marginBottom: 16 },
  sectionTitle: { marginTop: 8, marginBottom: 4 },
  help: { marginBottom: 12 },
  actions: { marginTop: 12 },
});
