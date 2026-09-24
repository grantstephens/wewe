import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Text, useTheme } from 'react-native-paper';

import { CryAlertClassifier } from '../domain/cryAlert';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS, type PairedMonitor } from '../domain/store';
import type { ActivityEvent } from '../domain/activityLog';
import { formatTimestamp } from '../domain/timestamp';
import type { RootStackParamList } from '../navigation';
import { fireConnectionLostAlert, fireCryAlert } from '../platform/alerts';
import { AndroidForegroundServiceType, startForegroundSession, stopForegroundSession } from '../platform/foregroundService';
import { useWewe } from '../WeweContext';
import { ParentSession } from '../webrtc/parentSession';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'Parent'>;

/** How often to poll `getStats()` for the inbound audio level driving `CryAlertClassifier`. */
const LEVEL_POLL_MS = 500;

function newEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Parent watches one paired monitor: connects as the WebRTC answerer,
 * surfaces connection state, runs `CryAlertClassifier` against the inbound
 * audio level to decide when to interrupt the parent, and offers
 * push-to-talk. Everything here is agnostic to whether the other side is a
 * phone in Monitor mode or an ESP32 — both speak the same WebRTC/signaling
 * contract (see PLAN.md).
 */
export function ParentScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { store } = useWewe();
  const { monitorId } = route.params;

  const [monitor, setMonitor] = React.useState<PairedMonitor | null>(null);
  const [connectionState, setConnectionState] = React.useState('idle');
  const [reconnecting, setReconnecting] = React.useState<number | null>(null);
  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
  const [talking, setTalking] = React.useState(false);

  const sessionRef = React.useRef<ParentSession | null>(null);
  const classifierRef = React.useRef(new CryAlertClassifier());
  const wasConnectedRef = React.useRef(false);

  const refreshEvents = React.useCallback(() => {
    store.events(monitorId).then(setEvents);
  }, [store, monitorId]);

  const logEvent = React.useCallback(
    async (kind: ActivityEvent['kind'], detail?: string) => {
      const event: ActivityEvent = { id: newEventId(), monitorId, kind, occurredAt: formatTimestamp(new Date()), ...(detail ? { detail } : {}) };
      await store.appendEvent(event);
      refreshEvents();
    },
    [store, monitorId, refreshEvents],
  );

  React.useEffect(() => {
    store.monitors().then((all) => setMonitor(all.find((m) => m.id === monitorId) ?? null));
    refreshEvents();
  }, [store, monitorId, refreshEvents]);

  React.useEffect(() => {
    if (!monitor) return;
    let cancelled = false;

    store.getSetting(SETTINGS_KEYS.signalingServerUrl).then((value) => {
      const relayUrl = value || DEFAULT_SIGNALING_SERVER_URL;
      if (cancelled) return;

      const session = new ParentSession(
        { signalingUrl: relayUrl, pairingCode: monitor.lastPairingCode },
        {
          onConnectionStateChange: (state) => {
            setConnectionState(state);
            if (state === 'connected') {
              wasConnectedRef.current = true;
            } else if ((state === 'disconnected' || state === 'failed') && wasConnectedRef.current) {
              wasConnectedRef.current = false;
              fireConnectionLostAlert(monitor.label).catch(() => {});
              logEvent('disconnected').catch(() => {});
            }
          },
          onSignalingReconnecting: (attempt) => setReconnecting(attempt),
          onSignalingReconnected: () => setReconnecting(null),
        },
      );
      sessionRef.current = session;
      session.start().catch(() => setConnectionState('failed'));
      startForegroundSession('Wewe', `Watching ${monitor.label}`, [
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      ]).catch(() => {});
    });

    return () => {
      cancelled = true;
      sessionRef.current?.stop();
      sessionRef.current = null;
      stopForegroundSession().catch(() => {});
    };
  }, [monitor, store, logEvent]);

  React.useEffect(() => {
    const interval = setInterval(async () => {
      const levelDb = await sessionRef.current?.getRemoteAudioLevel();
      if (levelDb == null) {
        classifierRef.current.reset();
        return;
      }
      const shouldAlert = classifierRef.current.push(levelDb, Date.now());
      if (shouldAlert && monitor) {
        fireCryAlert(monitor.label).catch(() => {});
        logEvent('cry_alert').catch(() => {});
      }
    }, LEVEL_POLL_MS);
    return () => clearInterval(interval);
  }, [monitor, logEvent]);

  const toggleTalk = async () => {
    if (talking) {
      sessionRef.current?.stopTalking();
      setTalking(false);
    } else {
      await sessionRef.current?.startTalking();
      setTalking(true);
    }
  };

  if (!monitor) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <Text>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        {monitor.label}
      </Text>
      <Text variant="bodyMedium" style={styles.status}>
        {reconnecting !== null
          ? `Reconnecting to relay (attempt ${reconnecting})…`
          : `Connection: ${connectionState}`}
      </Text>

      <Button
        mode={talking ? 'contained' : 'outlined'}
        icon="microphone"
        onPressIn={toggleTalk}
        onPressOut={toggleTalk}
        style={styles.talkButton}
      >
        {talking ? 'Release to stop talking' : 'Hold to talk'}
      </Button>

      <Text variant="titleMedium" style={styles.logTitle}>
        Activity
      </Text>
      {events.map((event) => (
        <List.Item
          key={event.id}
          title={event.kind.replace('_', ' ')}
          description={event.occurredAt}
          left={(props) => <List.Icon {...props} icon="bell-outline" />}
        />
      ))}

      <Button onPress={() => navigation.goBack()} style={styles.back}>
        Back
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  title: { marginBottom: 4 },
  status: { marginBottom: 24 },
  talkButton: { marginBottom: 24 },
  logTitle: { marginBottom: 8 },
  back: { marginTop: 16 },
});
