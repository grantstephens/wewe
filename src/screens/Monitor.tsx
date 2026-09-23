import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ProgressBar, Text, useTheme } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';

import { NoiseGate } from '../domain/noiseGate';
import { generatePairingCode, pairingUri } from '../domain/pairing';
import { SETTINGS_KEYS } from '../domain/store';
import type { RootStackParamList } from '../navigation';
import { MonitorAdvertiser } from '../platform/discovery';
import { AndroidForegroundServiceType, startForegroundSession, stopForegroundSession } from '../platform/foregroundService';
import { useMicLevel } from '../platform/micLevel';
import { useWewe } from '../WeweContext';
import { MonitorSession } from '../webrtc/monitorSession';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'Monitor'>;

/** dBFS below this is rendered as an empty meter; matches a typical adaptive noise floor's low end. */
const METER_FLOOR_DB = -60;

/** Maps a dBFS reading onto a 0-1 progress-bar fraction, clamped at both ends. */
function levelToFraction(levelDb: number): number {
  return Math.max(0, Math.min(1, (levelDb - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/**
 * Monitor turns this device into the "I have the microphone" side: it
 * generates a fresh pairing code, advertises it on the local network,
 * displays it as a QR code for AddMonitor to scan, and streams audio to
 * whichever Parent joins — gated by the local NoiseGate exactly the way
 * PLAN.md describes, so quiet nursery time transmits nothing.
 */
export function MonitorScreen({ navigation }: Props) {
  const theme = useTheme();
  const { store } = useWewe();
  const { levelDb, isReady } = useMicLevel();

  const [pairingCode] = React.useState(() => generatePairingCode());
  // undefined: getSetting hasn't resolved yet. null: resolved, and it's unset
  // (Store.getSetting's documented "never set" value) — these must stay
  // distinguishable or this screen can't tell "still loading" from "loaded,
  // but nothing to show" and gets stuck on the loading branch forever.
  const [relayUrl, setRelayUrl] = React.useState<string | null | undefined>(undefined);
  const [connectionState, setConnectionState] = React.useState('idle');
  const [reconnecting, setReconnecting] = React.useState<number | null>(null);
  const [gateOpen, setGateOpen] = React.useState(false);

  const sessionRef = React.useRef<MonitorSession | null>(null);
  const gateRef = React.useRef(new NoiseGate());
  const advertiserRef = React.useRef(new MonitorAdvertiser());

  React.useEffect(() => {
    store.getSetting(SETTINGS_KEYS.signalingServerUrl).then(setRelayUrl);
  }, [store]);

  React.useEffect(() => {
    if (!relayUrl) return;

    const session = new MonitorSession(
      { signalingUrl: relayUrl, pairingCode },
      {
        onConnectionStateChange: setConnectionState,
        onSignalingReconnecting: (attempt) => setReconnecting(attempt),
        onSignalingReconnected: () => setReconnecting(null),
      },
    );
    sessionRef.current = session;
    session.start().catch(() => setConnectionState('failed'));

    advertiserRef.current.publish(pairingCode, pairingCode);
    startForegroundSession('Wewe is monitoring', 'Listening for noise and crying', [
      AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
    ]).catch(() => {});

    return () => {
      session.stop();
      advertiserRef.current.unpublish(pairingCode);
      stopForegroundSession().catch(() => {});
    };
  }, [relayUrl, pairingCode]);

  React.useEffect(() => {
    if (levelDb === null) return;
    const open = gateRef.current.push(levelDb, Date.now());
    setGateOpen(open);
    sessionRef.current?.setGateOpen(open);
  }, [levelDb]);

  if (relayUrl === undefined) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <Text>Loading…</Text>
      </View>
    );
  }

  if (relayUrl === null) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <Text variant="titleMedium" style={styles.centeredText}>
          Set a signaling server first
        </Text>
        <Button mode="contained" onPress={() => navigation.navigate('Settings')} style={styles.button}>
          Go to Settings
        </Button>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        This device is the monitor
      </Text>

      <View style={styles.qrWrap}>
        <QRCode value={pairingUri(pairingCode, relayUrl)} size={200} />
      </View>
      <Text variant="headlineMedium" style={styles.code}>
        {pairingCode}
      </Text>
      <Text variant="bodyMedium" style={styles.centeredText}>
        Scan this on the parent's phone, or enter the code by hand.
      </Text>

      <View style={styles.meterSection}>
        <Text variant="labelLarge">{gateOpen ? 'Streaming' : 'Quiet'}</Text>
        <ProgressBar progress={levelDb === null ? 0 : levelToFraction(levelDb)} style={styles.meter} />
        <Text variant="bodySmall">
          {!isReady
            ? 'Requesting microphone…'
            : reconnecting !== null
              ? `Reconnecting to relay (attempt ${reconnecting})…`
              : `Connection: ${connectionState}`}
        </Text>
      </View>

      <Button mode="outlined" onPress={() => navigation.goBack()} style={styles.button}>
        Stop monitoring
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, alignItems: 'center' },
  centered: { justifyContent: 'center' },
  centeredText: { textAlign: 'center', marginBottom: 16 },
  title: { marginBottom: 16, textAlign: 'center' },
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 16 },
  code: { letterSpacing: 4, marginBottom: 8 },
  meterSection: { width: '100%', marginTop: 24, alignItems: 'center', gap: 8 },
  meter: { width: '100%', height: 12, borderRadius: 6 },
  button: { marginTop: 24 },
});
