import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, List, Text, useTheme } from 'react-native-paper';

import QRCode from 'react-native-qrcode-svg';

import { useParentSessions } from '../ParentSessionsContext';
import { pairingUri } from '../domain/pairing';
import type { ActivityEvent } from '../domain/activityLog';
import type { RootStackParamList } from '../navigation';
import { useWewe } from '../WeweContext';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'Parent'>;

/**
 * Parent is a detail view over a monitor's already-running session (owned by
 * ParentSessionsProvider, started as soon as the app opened — see
 * docs/superpowers/specs/2026-09-25-monitor-naming-and-multi-monitor-parent-design.md).
 * Opening or leaving this screen neither starts nor stops anything; it only
 * changes which monitor's state and controls (push-to-talk,
 * invite-a-listener, rename, activity log) are currently on screen.
 */
export function ParentScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { store } = useWewe();
  const { monitorId } = route.params;
  const { states, getSession, startTalking, stopTalking, setInviteMode, renameMonitor } = useParentSessions();
  const state = states.get(monitorId);

  const [events, setEvents] = React.useState<ActivityEvent[]>([]);
  const [talking, setTalking] = React.useState(false);
  // Mirrors `talking`, but updated synchronously — see the identical guard
  // this screen used before this task, now against the shared session
  // instead of a locally-owned one. Same double-invocation race this
  // originally fixed: onPressIn/onPressOut both call toggleTalk, and a quick
  // tap can fire both before React state from the first has flushed.
  const talkingRef = React.useRef(false);

  const refreshEvents = React.useCallback(() => {
    store.events(monitorId).then(setEvents);
  }, [store, monitorId]);

  React.useEffect(() => {
    refreshEvents();
  }, [refreshEvents]);

  const toggleTalk = async () => {
    if (talkingRef.current) {
      talkingRef.current = false;
      stopTalking(monitorId);
      setTalking(false);
    } else {
      talkingRef.current = true;
      await startTalking(monitorId);
      setTalking(true);
    }
  };

  if (!state) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <Text>Loading…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="titleLarge" style={styles.title}>
        {state.monitor.label}
      </Text>
      <Text variant="bodyMedium" style={styles.status}>
        {state.rejected !== null
          ? 'Not let in yet — ask someone already connected to invite this device.'
          : state.reconnecting !== null
            ? `Reconnecting to relay (attempt ${state.reconnecting})…`
            : state.connectTimedOut && state.connectionState !== 'connected'
              ? "Couldn't reach that monitor. Check it's still running and try again."
              : `Connection: ${state.connectionState}`}
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
        mode={state.invitingListener ? 'contained' : 'outlined'}
        icon="account-plus-outline"
        onPress={() => setInviteMode(monitorId, !state.invitingListener)}
        style={styles.talkButton}
      >
        {state.invitingListener ? 'Stop inviting' : 'Invite a listener'}
      </Button>

      {state.invitingListener && state.inviteCode !== null && (
        <View style={styles.qrWrap}>
          <QRCode value={pairingUri(state.inviteCode, state.relayUrl)} size={200} />
          <Text variant="headlineMedium" style={styles.code}>
            {state.inviteCode}
          </Text>
        </View>
      )}
      {state.invitingListener && state.inviteCode === null && (
        <Text variant="bodyMedium" style={styles.centeredText}>
          Asking the monitor for a code…
        </Text>
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
  centeredText: { textAlign: 'center', marginBottom: 16 },
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12, marginBottom: 16, alignItems: 'center' },
  code: { letterSpacing: 4, marginTop: 8 },
  logTitle: { marginBottom: 8 },
  back: { marginTop: 16 },
});
