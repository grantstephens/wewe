import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Chip, List, Surface, Text, useTheme } from 'react-native-paper';

import QRCode from 'react-native-qrcode-svg';

import { useParentSessions, type ParentSessionState } from '../ParentSessionsContext';
import { pairingUri } from '../domain/pairing';
import type { ActivityEvent } from '../domain/activityLog';
import type { RootStackParamList } from '../navigation';
import type { Theme } from '../theme';
import { useWewe } from '../WeweContext';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'Parent'>;

function statusText(state: ParentSessionState): string {
  if (state.rejected !== null) return 'Not let in yet — ask someone already connected to invite this device.';
  if (state.reconnecting !== null) return `Reconnecting to relay (attempt ${state.reconnecting})…`;
  if (state.connectTimedOut && state.connectionState !== 'connected') {
    return "Couldn't reach that monitor. Check it's still running and try again.";
  }
  if (state.connectionState === 'connected') return 'Connected';
  return `Connection: ${state.connectionState}`;
}

/** Real MD3 semantic roles: connected reads as "good", a rejection as "needs attention", everything else neutral. */
function statusColors(state: ParentSessionState, theme: Theme): { background: string; foreground: string } {
  if (state.rejected !== null) return { background: theme.colors.errorContainer, foreground: theme.colors.onErrorContainer };
  if (state.connectionState === 'connected') return { background: theme.colors.primaryContainer, foreground: theme.colors.onPrimaryContainer };
  return { background: theme.colors.surfaceVariant, foreground: theme.colors.onSurfaceVariant };
}

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

  const colors = statusColors(state, theme);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="headlineSmall" style={styles.title}>
        {state.monitor.label}
      </Text>
      <Chip
        icon={state.connectionState === 'connected' ? 'check-circle' : 'progress-clock'}
        style={[styles.statusChip, { backgroundColor: colors.background }]}
        textStyle={[styles.statusChipText, { color: colors.foreground }]}
      >
        {statusText(state)}
      </Chip>

      <Button
        mode={talking ? 'contained' : 'outlined'}
        icon="microphone"
        onPressIn={toggleTalk}
        onPressOut={toggleTalk}
        style={styles.primaryButton}
        contentStyle={styles.talkButtonContent}
        labelStyle={styles.primaryButtonLabel}
      >
        {talking ? 'Release to stop talking' : 'Hold to talk'}
      </Button>

      <Button
        mode={state.invitingListener ? 'contained' : 'outlined'}
        icon="account-plus-outline"
        onPress={() => setInviteMode(monitorId, !state.invitingListener)}
        style={styles.secondaryButton}
        contentStyle={styles.secondaryButtonContent}
      >
        {state.invitingListener ? 'Stop inviting' : 'Invite a listener'}
      </Button>

      {state.invitingListener && state.inviteCode !== null && (
        <Surface style={styles.qrSurface} elevation={1}>
          <View style={styles.qrWrap}>
            <QRCode value={pairingUri(state.inviteCode, state.relayUrl)} size={200} />
          </View>
          <Text variant="headlineMedium" style={styles.code}>
            {state.inviteCode}
          </Text>
        </Surface>
      )}
      {state.invitingListener && state.inviteCode === null && (
        <Text variant="bodyMedium" style={styles.centeredText}>
          Asking the monitor for a code…
        </Text>
      )}

      <Text variant="titleMedium" style={styles.logTitle}>
        Activity
      </Text>
      <Surface style={styles.logSurface} elevation={1}>
        {events.length === 0 ? (
          <Text variant="bodyMedium" style={styles.logEmpty}>
            Nothing logged yet.
          </Text>
        ) : (
          events.map((event) => (
            <List.Item
              key={event.id}
              title={event.kind.replace('_', ' ')}
              description={event.occurredAt}
              left={(props) => <List.Icon {...props} icon="bell-outline" />}
            />
          ))
        )}
      </Surface>

      <Button mode="outlined" onPress={() => navigation.goBack()} style={styles.secondaryButton} contentStyle={styles.secondaryButtonContent}>
        Back
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  title: { marginBottom: 12, fontWeight: '700' },
  statusChip: { alignSelf: 'flex-start', marginBottom: 24 },
  statusChipText: { fontWeight: '600' },
  centeredText: { textAlign: 'center', marginBottom: 16 },
  qrSurface: { alignItems: 'center', padding: 20, borderRadius: 20, marginBottom: 16 },
  qrWrap: { padding: 16, backgroundColor: '#fff', borderRadius: 12 },
  code: { letterSpacing: 6, marginTop: 12, fontWeight: '700' },
  logTitle: { marginBottom: 8, fontWeight: '600' },
  logSurface: { borderRadius: 16, marginBottom: 24, overflow: 'hidden' },
  logEmpty: { padding: 16, textAlign: 'center' },
  primaryButton: { borderRadius: 12, marginBottom: 16 },
  talkButtonContent: { paddingVertical: 10 },
  primaryButtonLabel: { fontSize: 16, fontWeight: '600' },
  secondaryButton: { borderRadius: 12, marginBottom: 16 },
  secondaryButtonContent: { paddingVertical: 4 },
});
