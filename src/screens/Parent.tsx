import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Text, useTheme } from 'react-native-paper';

import QRCode from 'react-native-qrcode-svg';

import { CryAlertClassifier } from '../domain/cryAlert';
import { getOrCreateDeviceId } from '../domain/deviceId';
import { pairingUri } from '../domain/pairing';
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

/**
 * How long to wait for a first connection before showing "couldn't reach
 * that monitor". There's no way to distinguish "wrong/expired pairing code"
 * from "right code, monitor just hasn't joined yet" at connect time — both
 * look identical to the signaling server (see signal-server/README.md's
 * join/peer-joined protocol) — so this is a plain watchdog, not a real
 * error detector. The session keeps trying in the background past this
 * point (up to the relay's own room TTL); this only changes what the UI
 * says while that happens, instead of leaving the user staring at an
 * unchanging "Connection: idle" forever, which is what an unset, unconnected
 * session used to render.
 */
const CONNECT_TIMEOUT_MS = 20_000;

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
  const [connectTimedOut, setConnectTimedOut] = React.useState(false);
  const [rejected, setRejected] = React.useState<string | null>(null);
  const [invitingListener, setInvitingListener] = React.useState(false);
  const [relayUrl, setRelayUrl] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
  const [talking, setTalking] = React.useState(false);

  const sessionRef = React.useRef<ParentSession | null>(null);
  const classifierRef = React.useRef(new CryAlertClassifier());
  const wasConnectedRef = React.useRef(false);
  // Mirrors `talking`, but updated synchronously — `toggleTalk` is async and
  // `talking` (React state) doesn't flip until after `startTalking()`'s
  // `await getUserMedia()` resolves, so a quick tap fires onPressIn then
  // onPressOut before that state update lands and both branches read the
  // same stale `talking`. That double-invoked `startTalking()` was a real,
  // reproduced crash: two concurrent addTrack+createOffer calls on the same
  // RTCPeerConnection produced two conflicting offers ("the order of
  // m-lines in subsequent offer doesn't match order from previous
  // offer/answer"). This ref is checked and flipped before anything async
  // happens, so the second of two near-simultaneous calls always sees the
  // already-updated value.
  const talkingRef = React.useRef(false);

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
    setConnectTimedOut(false);
    setRejected(null);

    const timeoutId = setTimeout(() => {
      if (!cancelled) setConnectTimedOut(true);
    }, CONNECT_TIMEOUT_MS);

    Promise.all([store.getSetting(SETTINGS_KEYS.signalingServerUrl), getOrCreateDeviceId(store)]).then(
      ([value, deviceId]) => {
        const resolvedRelayUrl = value || DEFAULT_SIGNALING_SERVER_URL;
        setRelayUrl(resolvedRelayUrl);
        if (cancelled) return;

        const session = new ParentSession(
          { signalingUrl: resolvedRelayUrl, pairingCode: monitor.lastPairingCode, deviceId },
          {
            onConnectionStateChange: (state) => {
              setConnectionState(state);
              if (state === 'connected') {
                clearTimeout(timeoutId);
                setConnectTimedOut(false);
                wasConnectedRef.current = true;
              } else if ((state === 'disconnected' || state === 'failed') && wasConnectedRef.current) {
                wasConnectedRef.current = false;
                fireConnectionLostAlert(monitor.label).catch(() => {});
                logEvent('disconnected').catch(() => {});
              }
            },
            onSignalingReconnecting: (attempt) => setReconnecting(attempt),
            onSignalingReconnected: () => setReconnecting(null),
            onError: () => setConnectionState('failed'),
            onRejected: (reason) => setRejected(reason),
          },
        );
        sessionRef.current = session;
        session.start().catch(() => setConnectionState('failed'));
        // MICROPHONE is deliberately not requested here: Android 14+ rejects a
        // foreground-service type unless the app is actually using it at that
        // exact moment (AppOpsManager's recording-state check), and Parent
        // isn't recording yet at connect time — only during push-to-talk (see
        // toggleTalk below). Requesting it upfront crashed with
        // "SecurityException: ... the app must be in the eligible
        // state/exemptions" on a real device.
        startForegroundSession('Wewe', `Watching ${monitor.label}`, [
          AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        ]).catch(() => {});
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
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
    if (talkingRef.current) {
      talkingRef.current = false;
      sessionRef.current?.stopTalking();
      setTalking(false);
      // Downgrade back to MEDIA_PLAYBACK-only now that the mic is no longer
      // in use, matching what's actually true (and what a future re-arm of
      // MICROPHONE would need to be eligible for again).
      startForegroundSession('Wewe', monitor ? `Watching ${monitor.label}` : 'Wewe', [
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      ]).catch(() => {});
    } else {
      talkingRef.current = true;
      // startTalking() awaits getUserMedia — the mic is genuinely active by
      // the time this resolves, satisfying Android's eligibility check for
      // adding MICROPHONE to the running foreground service.
      await sessionRef.current?.startTalking();
      setTalking(true);
      startForegroundSession('Wewe', monitor ? `Watching ${monitor.label}` : 'Wewe', [
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      ]).catch(() => {});
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
        {rejected !== null
          ? 'Not let in yet — ask someone already connected to invite this device.'
          : reconnecting !== null
            ? `Reconnecting to relay (attempt ${reconnecting})…`
            : connectTimedOut && connectionState !== 'connected'
              ? "Couldn't reach that monitor. Check it's still running and try again."
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

      <Button
        mode={invitingListener ? 'contained' : 'outlined'}
        icon="account-plus-outline"
        onPress={() => {
          const next = !invitingListener;
          setInvitingListener(next);
          sessionRef.current?.setInviteMode(next);
        }}
        style={styles.talkButton}
      >
        {invitingListener ? 'Stop inviting' : 'Invite a listener'}
      </Button>

      {invitingListener && (
        <View style={styles.qrWrap}>
          <QRCode value={pairingUri(monitor.lastPairingCode, relayUrl ?? '')} size={200} />
          <Text variant="headlineMedium" style={styles.code}>
            {monitor.lastPairingCode}
          </Text>
        </View>
      )}

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
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 16, alignItems: 'center' },
  code: { letterSpacing: 4, marginTop: 8 },
  logTitle: { marginBottom: 8 },
  back: { marginTop: 16 },
});
