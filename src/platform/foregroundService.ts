import notifee, { AndroidForegroundServiceType, AndroidImportance } from 'react-native-notify-kit';

/**
 * Android kills ordinary background work within seconds to minutes of the
 * app losing focus or the screen turning off — a foreground service with a
 * visible, persistent notification is the only supported way to keep mic
 * capture (Monitor) or the WebRTC/signaling connection (Parent) alive past
 * that. `react-native-notify-kit` is a maintained, New-Architecture-
 * compatible fork of the archived `@notifee/react-native` (see AGENTS.md).
 *
 * `registerForegroundService`'s runner must be registered once, outside any
 * React component, before this module is ever asked to start a session —
 * done in `index.ts`, per the library's own documented requirement.
 */
const CHANNEL_ID = 'wewe-active-session';

let channelReady: Promise<string> | null = null;

function ensureChannel(): Promise<string> {
  channelReady ??= notifee.createChannel({
    id: CHANNEL_ID,
    name: 'Active monitoring',
    // LOW: a persistent status notification, not something that should ever
    // alert with sound — cry/noise alerts are a separate, louder path
    // (see src/platform/alerts.ts).
    importance: AndroidImportance.LOW,
  });
  return channelReady;
}

/** Registers the long-running task the foreground service notification represents. Call once, outside any component — see module doc. */
export function registerForegroundServiceRunner(): void {
  notifee.registerForegroundService(
    () =>
      new Promise(() => {
        // Intentionally never resolves. The service's lifetime is the
        // notification's lifetime; ending it goes through
        // stopForegroundSession()'s stopForegroundService() call below, the
        // library's documented way to end one, not by resolving this.
      }),
  );
}

/** Starts (or re-titles, if already running) the persistent foreground-service notification. */
export async function startForegroundSession(
  title: string,
  body: string,
  types: AndroidForegroundServiceType[],
): Promise<void> {
  const channelId = await ensureChannel();
  await notifee.displayNotification({
    title,
    body,
    android: {
      channelId,
      asForegroundService: true,
      ongoing: true,
      foregroundServiceTypes: types,
    },
  });
}

export async function stopForegroundSession(): Promise<void> {
  await notifee.stopForegroundService();
}

export { AndroidForegroundServiceType };
