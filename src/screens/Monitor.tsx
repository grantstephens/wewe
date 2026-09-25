import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ProgressBar, Text, useTheme } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';

import { NoiseGate } from '../domain/noiseGate';
import { pairingUri } from '../domain/pairing';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS } from '../domain/store';
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
 * Monitor turns this device into the "I have the microphone" side:
 * displays a pairing code as a QR code for AddMonitor to scan, advertises
 * it on the local network, and streams audio to whichever Parent joins —
 * gated by the local NoiseGate exactly the way PLAN.md describes, so quiet
 * nursery time transmits nothing.
 *
 * The pairing code is persisted (`SETTINGS_KEYS.monitorPairingCode`), not
 * regenerated every mount: a Parent that's already paired keeps reconnecting
 * with `monitor.lastPairingCode` on every visit (see Parent.tsx), so a fresh
 * random code here on every Monitor session would silently orphan every
 * previously-paired Parent — confirmed as a real reported bug, not a
 * hypothetical. Only ever generated once per install; reused indefinitely
 * after that.
 */
export function MonitorScreen({ navigation }: Props) {
  const theme = useTheme();
  const { store } = useWewe();
  const { levelDb, isReady, isRecording } = useMicLevel();

  // undefined: relayUrl hasn't resolved yet — kept distinguishable from an
  // empty/unset value (which falls back to the default below) so this
  // screen can tell "still loading" from "loaded, nothing configured".
  const [relayUrl, setRelayUrl] = React.useState<string | undefined>(undefined);
  const [listenerCount, setListenerCount] = React.useState(0);
  const [inviteCode, setInviteCode] = React.useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = React.useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(null);
  const [reconnecting, setReconnecting] = React.useState<number | null>(null);
  const [gateOpen, setGateOpen] = React.useState(false);

  const sessionRef = React.useRef<MonitorSession | null>(null);
  const gateRef = React.useRef(new NoiseGate());
  const advertiserRef = React.useRef(new MonitorAdvertiser());

  React.useEffect(() => {
    store.getSetting(SETTINGS_KEYS.signalingServerUrl).then((value) => setRelayUrl(value || DEFAULT_SIGNALING_SERVER_URL));
  }, [store]);

  React.useEffect(() => {
    if (!relayUrl) return;

    const session = new MonitorSession(
      { signalingUrl: relayUrl },
      store,
      {
        onListenerCountChange: setListenerCount,
        onInviteCodeChange: (code, expiresAt) => {
          setInviteCode(code);
          setInviteExpiresAt(expiresAt);
        },
        onSignalingReconnecting: (attempt) => setReconnecting(attempt),
        onSignalingReconnected: () => setReconnecting(null),
      },
    );
    sessionRef.current = session;
    // rearmInvite() sends set-alias, which the relay only accepts once this
    // room has actually been joined — must wait for start() to resolve.
    session
      .start()
      .then(() => session.rearmInvite())
      .catch(() => {});

    return () => {
      session.closeLocalInvite();
      session.stop();
      stopForegroundSession().catch(() => {});
    };
  }, [relayUrl, store]);

  // mDNS re-publishes under the current code each time it rotates — separate
  // from the session effect above since inviteCode changes many times over
  // one mount, not just once.
  React.useEffect(() => {
    if (!inviteCode) return;
    advertiserRef.current.publish(inviteCode, inviteCode);
    return () => advertiserRef.current.unpublish(inviteCode);
  }, [inviteCode]);

  // Ticking countdown display, independent of the session's own internal
  // timer — this is purely a UI reflection of inviteExpiresAt.
  React.useEffect(() => {
    if (inviteExpiresAt === null) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((inviteExpiresAt - Date.now()) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [inviteExpiresAt]);

  React.useEffect(() => {
    if (levelDb === null) return;
    const open = gateRef.current.push(levelDb, Date.now());
    setGateOpen(open);
    sessionRef.current?.setGateOpen(open);
  }, [levelDb]);

  // Deliberately not started alongside the session/advertiser above: Android
  // 14+ rejects a MICROPHONE-type foreground service unless the app is
  // actually recording at that exact instant (AppOpsManager's live state,
  // not just the permission grant), and useMicLevel's own permission
  // request + recorder.record() resolve on an independent, unordered
  // effect — confirmed by two real crashes on real devices (a
  // SecurityException "the app must be in the eligible state/exemptions",
  // and a ForegroundServiceDidNotStartInTimeException when the permission
  // dialog itself ate into the 5s startForeground() SLA). Gates on
  // `isRecording`, not `isReady`/`canRecord` — canRecord means "prepared",
  // true before record() actually starts (see useMicLevel's doc comment);
  // gating on that would reproduce the same race one level down.
  React.useEffect(() => {
    if (!isRecording) return;
    startForegroundSession('Wewe is monitoring', 'Listening for noise and crying', [
      AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
    ]).catch(() => {});
  }, [isRecording]);

  if (relayUrl === undefined) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <Text>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        This device is the monitor
      </Text>

      {listenerCount > 0 && (
        <View style={[styles.connectedBanner, { backgroundColor: theme.colors.primaryContainer }]}>
          <Text variant="titleMedium">
            ● Connected — {listenerCount} {listenerCount === 1 ? 'listener' : 'listeners'}
          </Text>
        </View>
      )}

      {inviteCode !== null ? (
        <>
          <View style={styles.qrWrap}>
            <QRCode value={pairingUri(inviteCode, relayUrl)} size={200} />
          </View>
          <Text variant="headlineMedium" style={styles.code}>
            {inviteCode}
          </Text>
          <Text variant="bodyMedium" style={styles.centeredText}>
            Scan this on the parent's phone, or enter the code by hand. Expires in {secondsLeft ?? 0}s.
          </Text>
        </>
      ) : (
        <>
          <Text variant="bodyMedium" style={styles.centeredText}>
            Pairing closed — a new device can't join until you show a code again.
          </Text>
          <Button mode="contained" onPress={() => sessionRef.current?.rearmInvite()} style={styles.button}>
            Show pairing code
          </Button>
        </>
      )}

      <View style={styles.meterSection}>
        <Text variant="labelLarge">{gateOpen ? 'Streaming' : 'Quiet'}</Text>
        <ProgressBar progress={levelDb === null ? 0 : levelToFraction(levelDb)} style={styles.meter} />
        <Text variant="bodySmall">
          {!isReady
            ? 'Requesting microphone…'
            : reconnecting !== null
              ? `Reconnecting to relay (attempt ${reconnecting})…`
              : listenerCount === 0
                ? 'No one listening yet'
                : 'Streaming to every connected listener'}
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
  connectedBanner: { width: '100%', padding: 12, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 16 },
  code: { letterSpacing: 4, marginBottom: 8 },
  meterSection: { width: '100%', marginTop: 24, alignItems: 'center', gap: 8 },
  meter: { width: '100%', height: 12, borderRadius: 6 },
  button: { marginTop: 24 },
});
