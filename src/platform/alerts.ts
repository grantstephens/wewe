import * as Notifications from 'expo-notifications';
import { Vibration } from 'react-native';

/** A sustained on/off pattern distinct from a generic single buzz, so a cry alert is recognizable by feel alone. */
const CRY_VIBRATION_PATTERN_MS = [0, 400, 200, 400, 200, 400];

/**
 * Notifications must be able to interrupt the parent even with the app
 * backgrounded — that's the entire point of an alert. `setNotificationHandler`
 * runs once at module load (not inside a component) so it's registered
 * before any notification could possibly fire.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function requestAlertPermissions(): Promise<boolean> {
  const settings = await Notifications.requestPermissionsAsync();
  return settings.granted;
}

/** Fires a cry alert: a distinct vibration pattern plus an immediate local notification naming the monitor. */
export async function fireCryAlert(monitorLabel: string): Promise<void> {
  Vibration.vibrate(CRY_VIBRATION_PATTERN_MS);
  await Notifications.scheduleNotificationAsync({
    content: { title: 'Crying detected', body: monitorLabel, sound: true },
    trigger: null,
  });
}

/** Fires a connection-loss alarm: a single long vibration plus a local notification. */
export async function fireConnectionLostAlert(monitorLabel: string): Promise<void> {
  Vibration.vibrate(1000);
  await Notifications.scheduleNotificationAsync({
    content: { title: 'Lost connection', body: monitorLabel, sound: true },
    trigger: null,
  });
}
