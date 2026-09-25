import { CameraView, useCameraPermissions } from 'expo-camera';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Text, TextInput, useTheme } from 'react-native-paper';

import { generateDeviceId } from '../domain/deviceId';
import { isValidPairingCode, parsePairingUri } from '../domain/pairing';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS, type PairedMonitor } from '../domain/store';
import { formatTimestamp } from '../domain/timestamp';
import type { RootStackParamList } from '../navigation';
import { DiscoveryScanner, type DiscoveredMonitor } from '../platform/discovery';
import { useWewe } from '../WeweContext';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'AddMonitor'>;

/**
 * AddMonitor offers three ways to pair, none of them mandatory over the
 * others (see PLAN.md: mDNS is UX sugar, never the only path — plenty of
 * "IoT" and guest WiFi networks block multicast entirely): scan the
 * monitor's QR code, pick one already found on the local network, or type
 * its six-digit code by hand.
 */
export function AddMonitorScreen({ navigation }: Props) {
  const theme = useTheme();
  const { store, bump } = useWewe();
  const [permission, requestPermission] = useCameraPermissions();
  const [manualCode, setManualCode] = React.useState('');
  const [discovered, setDiscovered] = React.useState<DiscoveredMonitor[]>([]);
  const [scannedOnce, setScannedOnce] = React.useState(false);

  React.useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, [permission, requestPermission]);

  React.useEffect(() => {
    const scanner = new DiscoveryScanner();
    scanner.start(setDiscovered);
    return () => scanner.stop();
  }, []);

  const pairWith = React.useCallback(
    async (code: string, relayUrl: string, label: string) => {
      const existingRelay = await store.getSetting(SETTINGS_KEYS.signalingServerUrl);
      if (!existingRelay) {
        await store.setSetting(SETTINGS_KEYS.signalingServerUrl, relayUrl);
      }
      const monitor: PairedMonitor = {
        // A fresh, stable local id — no longer the pairing code, which now
        // rotates and can't identify anything durably. roomId starts as the
        // scanned code (what we're about to try connecting to); Parent.tsx
        // updates it in place once the relay's joined ack reports the real,
        // stable room this resolved to.
        id: generateDeviceId(),
        label,
        roomId: code,
        addedAt: formatTimestamp(new Date()),
      };
      await store.addMonitor(monitor);
      bump();
      navigation.replace('Parent', { monitorId: monitor.id });
    },
    [store, bump, navigation],
  );

  const onScanned = ({ data }: { data: string }) => {
    if (scannedOnce) return;
    const parsed = parsePairingUri(data);
    if (!parsed) return;
    setScannedOnce(true);
    pairWith(parsed.code, parsed.signalingServerUrl, 'Nursery').catch(() => setScannedOnce(false));
  };

  const connectManually = async () => {
    if (!isValidPairingCode(manualCode)) return;
    const relayUrl = (await store.getSetting(SETTINGS_KEYS.signalingServerUrl)) || DEFAULT_SIGNALING_SERVER_URL;
    await pairWith(manualCode, relayUrl, 'Nursery');
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        Add a monitor
      </Text>

      {permission?.granted ? (
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
        </View>
      ) : (
        <Text variant="bodyMedium" style={styles.help}>
          Camera access is needed to scan a monitor's QR code.
        </Text>
      )}

      {discovered.length > 0 && (
        <View style={styles.discoveredWrap}>
          <Text variant="titleMedium">Found on this network</Text>
          {discovered.map((m) => (
            <List.Item
              key={m.name}
              title={m.name}
              description={m.host}
              left={(props) => <List.Icon {...props} icon="wifi" />}
              onPress={() => m.pairingCode && setManualCode(m.pairingCode)}
            />
          ))}
        </View>
      )}

      <Text variant="titleMedium" style={styles.sectionTitle}>
        Or enter the code
      </Text>
      <TextInput
        label="Pairing code"
        keyboardType="number-pad"
        maxLength={6}
        value={manualCode}
        onChangeText={setManualCode}
      />
      <Button mode="contained" onPress={connectManually} style={styles.button} disabled={!isValidPairingCode(manualCode)}>
        Connect
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  title: { marginBottom: 16 },
  cameraWrap: { height: 240, borderRadius: 12, overflow: 'hidden', marginBottom: 16 },
  help: { marginBottom: 16 },
  discoveredWrap: { marginBottom: 16 },
  sectionTitle: { marginBottom: 8 },
  button: { marginTop: 16 },
});
