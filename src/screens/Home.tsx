import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Button, List, Text, useTheme } from 'react-native-paper';

import type { PairedMonitor } from '../domain/store';
import type { RootStackParamList } from '../navigation';
import { useWewe } from '../WeweContext';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

/**
 * Home lists paired monitors (Dormi's "add another monitor" pattern, one
 * app, many monitors, instead of Dormi²/Dormi³ separate companion apps) and
 * offers the two entry points: become a monitor, or add one to watch.
 */
export function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const { store, revision } = useWewe();
  const [monitors, setMonitors] = React.useState<PairedMonitor[]>([]);

  React.useEffect(() => {
    store.monitors().then(setMonitors);
  }, [store, revision]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
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
            description="Tap to view"
            left={(props) => <List.Icon {...props} icon="baby-face-outline" />}
            onPress={() => navigation.navigate('Parent', { monitorId: item.id })}
          />
        )}
      />
      <View style={styles.actions}>
        <Button
          mode="contained"
          icon={({ color, size }) => <MaterialCommunityIcons name="microphone" color={color} size={size} />}
          onPress={() => navigation.navigate('Monitor')}
          style={styles.button}
        >
          Use this device as a monitor
        </Button>
        <Button
          mode="outlined"
          icon={({ color, size }) => <MaterialCommunityIcons name="qrcode-scan" color={color} size={size} />}
          onPress={() => navigation.navigate('AddMonitor')}
          style={styles.button}
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
  title: { marginBottom: 16 },
  list: { flex: 1 },
  empty: { marginTop: 32, textAlign: 'center' },
  actions: { gap: 12, marginTop: 16 },
  button: {},
});
