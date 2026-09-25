import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { Button, Dialog, IconButton, List, Portal, Text, TextInput, useTheme } from 'react-native-paper';

import { useParentSessions } from '../ParentSessionsContext';
import type { PairedMonitor } from '../domain/store';
import type { RootStackParamList } from '../navigation';
import type { Theme } from '../theme';
import { useWewe } from '../WeweContext';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

/** A short, human status line for a monitor row — mirrors the states ParentSessionState actually produces. */
function statusText(monitorId: string, states: ReturnType<typeof useParentSessions>['states']): string {
  const state = states.get(monitorId);
  if (!state) return 'Connecting…';
  if (state.rejected !== null) return 'Not let in yet';
  if (state.reconnecting !== null) return `Reconnecting (attempt ${state.reconnecting})…`;
  if (state.connectionState === 'connected') return 'Connected';
  if (state.connectTimedOut) return "Couldn't reach this monitor";
  return 'Connecting…';
}

/** The status color role — connected reads as the "good" state, a rejection/timeout as the "needs attention" state, everything else neutral. Real MD3 semantic roles, not bespoke colors. */
function statusColor(monitorId: string, states: ReturnType<typeof useParentSessions>['states'], theme: Theme): string {
  const state = states.get(monitorId);
  if (!state) return theme.colors.onSurfaceVariant;
  if (state.rejected !== null || state.connectTimedOut) return theme.colors.error;
  if (state.connectionState === 'connected') return theme.colors.primary;
  return theme.colors.onSurfaceVariant;
}

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

/**
 * Home lists paired monitors (Dormi's "add another monitor" pattern, one
 * app, many monitors, instead of Dormi²/Dormi³ separate companion apps) and
 * offers the two entry points: become a monitor, or add one to watch.
 */
export function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const { store, bump, revision } = useWewe();
  const { states, renameMonitor } = useParentSessions();
  const [monitors, setMonitors] = React.useState<PairedMonitor[]>([]);
  const [renaming, setRenaming] = React.useState<PairedMonitor | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');

  React.useEffect(() => {
    store.monitors().then(setMonitors);
  }, [store, revision]);

  const removeMonitor = (monitor: PairedMonitor) => {
    Alert.alert('Remove monitor?', `This deletes "${monitor.label}" and its activity log from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          store.removeMonitor(monitor.id).then(bump);
        },
      },
    ]);
  };

  const startRename = (monitor: PairedMonitor) => {
    setRenaming(monitor);
    setRenameDraft(monitor.label);
  };

  const saveRename = () => {
    if (!renaming) return;
    const label = renameDraft.trim();
    if (label) {
      renameMonitor(renaming.id, label);
      bump();
    }
    setRenaming(null);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="headlineMedium" style={styles.title}>
        Wewe
      </Text>
      <FlatList
        data={monitors}
        keyExtractor={(m) => m.id}
        style={styles.list}
        ListEmptyComponent={
          <Text variant="bodyMedium" style={styles.empty}>
            No monitors paired yet. Add one below, or turn this device into a monitor.
          </Text>
        }
        renderItem={({ item }) => (
          <List.Item
            title={item.label}
            titleStyle={styles.itemTitle}
            description={() => (
              <Text variant="bodyMedium" style={{ color: statusColor(item.id, states, theme) }}>
                {statusText(item.id, states)}
              </Text>
            )}
            style={styles.item}
            left={(props) => <List.Icon {...props} icon="baby-face-outline" color={statusColor(item.id, states, theme)} />}
            right={() => (
              <View style={styles.itemActions}>
                <IconButton icon="pencil-outline" onPress={() => startRename(item)} />
                <IconButton icon="delete-outline" onPress={() => removeMonitor(item)} />
              </View>
            )}
            onPress={() => navigation.navigate('Parent', { monitorId: item.id })}
          />
        )}
      />

      <Portal>
        <Dialog visible={renaming !== null} onDismiss={() => setRenaming(null)}>
          <Dialog.Title>Rename monitor</Dialog.Title>
          <Dialog.Content>
            <TextInput label="Name" value={renameDraft} onChangeText={setRenameDraft} autoFocus />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRenaming(null)}>Cancel</Button>
            <Button onPress={saveRename} disabled={!renameDraft.trim()}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <View style={styles.actions}>
        <Button
          mode="contained"
          icon={({ color, size }) => <MaterialCommunityIcons name="microphone" color={color} size={size} />}
          onPress={() => navigation.navigate('Monitor')}
          style={styles.primaryButton}
          contentStyle={styles.primaryButtonContent}
          labelStyle={styles.primaryButtonLabel}
        >
          Use this device as a monitor
        </Button>
        <Button
          mode="outlined"
          icon={({ color, size }) => <MaterialCommunityIcons name="qrcode-scan" color={color} size={size} />}
          onPress={() => navigation.navigate('AddMonitor')}
          style={styles.primaryButton}
          contentStyle={styles.primaryButtonContent}
        >
          Add a monitor
        </Button>
        <Button icon="cog-outline" onPress={() => navigation.navigate('Settings')} style={styles.button}>
          Settings
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  title: { marginBottom: 20, fontWeight: '700' },
  list: { flex: 1 },
  empty: { marginTop: 32, textAlign: 'center' },
  item: { paddingVertical: 4 },
  itemTitle: { fontWeight: '600' },
  itemActions: { flexDirection: 'row' },
  actions: { gap: 12, marginTop: 20 },
  button: {},
  primaryButton: { borderRadius: 12 },
  primaryButtonContent: { paddingVertical: 6 },
  primaryButtonLabel: { fontSize: 16, fontWeight: '600' },
});
