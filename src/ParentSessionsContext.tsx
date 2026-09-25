import React from 'react';

import { CryAlertClassifier } from './domain/cryAlert';
import { getOrCreateDeviceId } from './domain/deviceId';
import type { ActivityEvent } from './domain/activityLog';
import { DEFAULT_SIGNALING_SERVER_URL, SETTINGS_KEYS, type PairedMonitor } from './domain/store';
import { formatTimestamp } from './domain/timestamp';
import { fireConnectionLostAlert, fireCryAlert } from './platform/alerts';
import { AndroidForegroundServiceType, startForegroundSession, stopForegroundSession } from './platform/foregroundService';
import { useWewe } from './WeweContext';
import { ParentSession } from './webrtc/parentSession';

/** How often to poll every active session's inbound audio level for CryAlertClassifier — same cadence Parent.tsx used to run this at per-screen. */
const LEVEL_POLL_MS = 500;

/** How long a session may go without ever reaching 'connected' before its connectTimedOut flag is set — see ParentSessionState's doc comment. Same value Parent.tsx used to watch for per-screen. */
const CONNECT_TIMEOUT_MS = 20_000;

function newEventId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Live, per-monitor state the dashboard (Home) and detail view (Parent) both read. */
export interface ParentSessionState {
  monitor: PairedMonitor;
  /** The relay URL this session actually connected through — needed to build a working invite QR/code (see Parent.tsx's "Invite a listener" flow); resolved once per app run, shared by every session. */
  relayUrl: string;
  connectionState: string;
  reconnecting: number | null;
  /** True once CONNECT_TIMEOUT_MS has elapsed since the most recent connection attempt started, and it still hasn't reached 'connected'. Resets whenever a fresh attempt starts (the initial connect, or the first reconnect attempt after having been connected before). */
  connectTimedOut: boolean;
  rejected: string | null;
  talking: boolean;
  invitingListener: boolean;
  inviteCode: string | null;
  /** The Monitor's current display name, or null until its first `monitorName` signal arrives. */
  monitorName: string | null;
}

export interface ParentSessionsValue {
  /** Every paired monitor's live state, keyed by PairedMonitor.id. A monitor with no entry yet has had its session requested but not constructed — render it as "not yet connected". */
  states: Map<string, ParentSessionState>;
  /** The underlying session, for the one action this provider doesn't wrap directly (setInviteMode). */
  getSession: (monitorId: string) => ParentSession | undefined;
  startTalking: (monitorId: string) => Promise<void>;
  stopTalking: (monitorId: string) => void;
  setInviteMode: (monitorId: string, open: boolean) => void;
  renameMonitor: (monitorId: string, label: string) => void;
}

const ParentSessionsReactContext = React.createContext<ParentSessionsValue | null>(null);

export function useParentSessions(): ParentSessionsValue {
  const value = React.useContext(ParentSessionsReactContext);
  if (value === null) {
    throw new Error('useParentSessions must be used inside a ParentSessionsProvider');
  }
  return value;
}

interface Managed {
  session: ParentSession;
  state: ParentSessionState;
  classifier: CryAlertClassifier;
  wasConnected: boolean;
  connectStartedAt: number;
}

/**
 * ParentSessionsProvider owns one ParentSession per paired monitor for the
 * app's whole lifetime — not tied to any screen being open. See
 * docs/superpowers/specs/2026-09-25-monitor-naming-and-multi-monitor-parent-design.md.
 * Mounted once in App.tsx, inside WeweProvider (it needs `store`).
 *
 * The single shared foreground-service notification
 * (`startForegroundSession`/`stopForegroundSession` display/update one
 * notification, never one per call — see `platform/foregroundService.ts`) is
 * entirely owned here: every state change that could affect its `types`
 * array recomputes the *complete* set from scratch (at least one session
 * active -> MEDIA_PLAYBACK, at least one session currently talking -> also
 * MICROPHONE) rather than adding to it incrementally, since notifee doesn't
 * merge types across calls — getting this piecemeal is the exact bug class
 * that crashed real devices twice already (see AGENTS.md). This is why
 * push-to-talk goes through this provider's startTalking/stopTalking instead
 * of a screen calling ParentSession or the foreground service directly.
 */
export function ParentSessionsProvider({ children }: { children: React.ReactNode }) {
  const { store, revision } = useWewe();
  const managedRef = React.useRef(new Map<string, Managed>());
  const deviceIdRef = React.useRef<string | null>(null);
  const relayUrlRef = React.useRef<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const rerender = React.useCallback(() => setTick((n) => n + 1), []);

  const recomputeForegroundService = React.useCallback(() => {
    const managed = [...managedRef.current.values()];
    if (managed.length === 0) {
      stopForegroundSession().catch(() => {});
      return;
    }
    const anyTalking = managed.some((m) => m.state.talking);
    const types = anyTalking
      ? [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK, AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE]
      : [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK];
    const count = managed.length;
    startForegroundSession('Wewe', `Watching ${count} ${count === 1 ? 'monitor' : 'monitors'}`, types).catch(() => {});
  }, []);

  const logEvent = React.useCallback(
    (monitorId: string, kind: ActivityEvent['kind'], detail?: string) => {
      const event: ActivityEvent = {
        id: newEventId(),
        monitorId,
        kind,
        occurredAt: formatTimestamp(new Date()),
        ...(detail ? { detail } : {}),
      };
      store.appendEvent(event).catch(() => {});
    },
    [store],
  );

  const startSession = React.useCallback(
    (monitor: PairedMonitor, deviceId: string, relayUrl: string): void => {
      const managed: Managed = {
        session: null as unknown as ParentSession,
        state: {
          monitor,
          relayUrl,
          connectionState: 'idle',
          reconnecting: null,
          connectTimedOut: false,
          rejected: null,
          talking: false,
          invitingListener: false,
          inviteCode: null,
          monitorName: null,
        },
        classifier: new CryAlertClassifier(),
        wasConnected: false,
        connectStartedAt: Date.now(),
      };

      const session = new ParentSession(
        { signalingUrl: relayUrl, room: monitor.roomId, deviceId },
        {
          onConnectionStateChange: (connectionState) => {
            managed.state = { ...managed.state, connectionState };
            if (connectionState === 'connected') {
              managed.state = { ...managed.state, connectTimedOut: false };
              managed.wasConnected = true;
            } else if ((connectionState === 'disconnected' || connectionState === 'failed') && managed.wasConnected) {
              managed.wasConnected = false;
              managed.connectStartedAt = Date.now();
              fireConnectionLostAlert(managed.state.monitor.label).catch(() => {});
              logEvent(managed.state.monitor.id, 'disconnected');
            }
            rerender();
          },
          onSignalingReconnecting: (attempt) => {
            managed.state = { ...managed.state, reconnecting: attempt };
            rerender();
          },
          onSignalingReconnected: () => {
            managed.state = { ...managed.state, reconnecting: null };
            rerender();
          },
          onError: () => {
            managed.state = { ...managed.state, connectionState: 'failed' };
            rerender();
          },
          onRejected: (reason) => {
            managed.state = { ...managed.state, rejected: reason };
            rerender();
          },
          onRoomResolved: (room) => {
            if (room !== managed.state.monitor.roomId) {
              const updated = { ...managed.state.monitor, roomId: room };
              managed.state = { ...managed.state, monitor: updated };
              store.addMonitor(updated).catch(() => {});
            }
          },
          onInviteCode: (code) => {
            managed.state = { ...managed.state, inviteCode: code };
            rerender();
          },
          onMonitorNameChanged: (name) => {
            managed.state = { ...managed.state, monitorName: name };
            if (name !== managed.state.monitor.label) {
              const updated = { ...managed.state.monitor, label: name };
              managed.state = { ...managed.state, monitor: updated };
              store.addMonitor(updated).catch(() => {});
            }
            rerender();
          },
        },
      );
      managed.session = session;
      managedRef.current.set(monitor.id, managed);
      session.start().catch(() => {
        managed.state = { ...managed.state, connectionState: 'failed' };
        rerender();
      });
      recomputeForegroundService();
      rerender();
    },
    [logEvent, recomputeForegroundService, rerender, store],
  );

  const stopSession = React.useCallback(
    (monitorId: string): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      managed.session.stop();
      managedRef.current.delete(monitorId);
      recomputeForegroundService();
      rerender();
    },
    [recomputeForegroundService, rerender],
  );

  // Initial setup: resolve the shared deviceId/relayUrl once, then start a session per paired monitor.
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([getOrCreateDeviceId(store), store.getSetting(SETTINGS_KEYS.signalingServerUrl)]).then(
      ([deviceId, relayUrlSetting]) => {
        if (cancelled) return;
        deviceIdRef.current = deviceId;
        relayUrlRef.current = relayUrlSetting || DEFAULT_SIGNALING_SERVER_URL;
        store.monitors().then((monitors) => {
          if (cancelled) return;
          for (const monitor of monitors) {
            startSession(monitor, deviceIdRef.current!, relayUrlRef.current!);
          }
        });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync whenever the paired-monitor list changes (pair/remove) — revision is WeweContext's existing "stored data changed" signal.
  React.useEffect(() => {
    if (deviceIdRef.current === null || relayUrlRef.current === null) return;
    let cancelled = false;
    store.monitors().then((monitors) => {
      if (cancelled) return;
      const currentIds = new Set(monitors.map((m) => m.id));
      for (const id of [...managedRef.current.keys()]) {
        if (!currentIds.has(id)) stopSession(id);
      }
      for (const monitor of monitors) {
        if (!managedRef.current.has(monitor.id)) {
          startSession(monitor, deviceIdRef.current!, relayUrlRef.current!);
        }
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  // Central cry-alert polling + connect-timeout watchdog, one interval for every active session.
  React.useEffect(() => {
    const interval = setInterval(() => {
      let changed = false;
      for (const managed of managedRef.current.values()) {
        managed.session.getRemoteAudioLevel().then((levelDb) => {
          if (levelDb == null) {
            managed.classifier.reset();
            return;
          }
          const shouldAlert = managed.classifier.push(levelDb, Date.now());
          if (shouldAlert) {
            fireCryAlert(managed.state.monitor.label).catch(() => {});
            logEvent(managed.state.monitor.id, 'cry_alert');
          }
        });
        if (managed.state.connectionState !== 'connected' && !managed.state.connectTimedOut) {
          if (Date.now() - managed.connectStartedAt > CONNECT_TIMEOUT_MS) {
            managed.state = { ...managed.state, connectTimedOut: true };
            changed = true;
          }
        }
      }
      if (changed) rerender();
    }, LEVEL_POLL_MS);
    return () => clearInterval(interval);
  }, [logEvent, rerender]);

  // Tear every session down when the provider itself unmounts (app close) — not on any screen's lifecycle.
  React.useEffect(() => {
    return () => {
      for (const managed of managedRef.current.values()) managed.session.stop();
      stopForegroundSession().catch(() => {});
    };
  }, []);

  const startTalking = React.useCallback(
    async (monitorId: string): Promise<void> => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      await managed.session.startTalking();
      managed.state = { ...managed.state, talking: true };
      recomputeForegroundService();
      rerender();
    },
    [recomputeForegroundService, rerender],
  );

  const stopTalking = React.useCallback(
    (monitorId: string): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      managed.session.stopTalking();
      managed.state = { ...managed.state, talking: false };
      recomputeForegroundService();
      rerender();
    },
    [recomputeForegroundService, rerender],
  );

  const setInviteMode = React.useCallback(
    (monitorId: string, open: boolean): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      managed.session.setInviteMode(open);
      managed.state = { ...managed.state, invitingListener: open, inviteCode: open ? managed.state.inviteCode : null };
      rerender();
    },
    [rerender],
  );

  const renameMonitor = React.useCallback(
    (monitorId: string, label: string): void => {
      const managed = managedRef.current.get(monitorId);
      if (!managed) return;
      const updated = { ...managed.state.monitor, label };
      managed.state = { ...managed.state, monitor: updated, monitorName: label };
      store.addMonitor(updated).catch(() => {});
      managed.session.renameMonitor(label);
      rerender();
    },
    [store, rerender],
  );

  const value = React.useMemo<ParentSessionsValue>(() => {
    const states = new Map<string, ParentSessionState>();
    for (const [id, managed] of managedRef.current) states.set(id, managed.state);
    return {
      states,
      getSession: (monitorId) => managedRef.current.get(monitorId)?.session,
      startTalking,
      stopTalking,
      setInviteMode,
      renameMonitor,
    };
    // `tick` is read only to force this memo to recompute after an
    // in-place `managedRef.current` mutation elsewhere in this component —
    // it has no other use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, startTalking, stopTalking, setInviteMode, renameMonitor]);

  return <ParentSessionsReactContext.Provider value={value}>{children}</ParentSessionsReactContext.Provider>;
}
