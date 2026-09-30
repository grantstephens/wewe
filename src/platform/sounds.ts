import { createAudioPlayer } from 'expo-audio';

/**
 * One short beep, reused for both the cry alert and the sustained-disconnect
 * alert (see the alerts/listen design spec — deliberately one shared asset,
 * not two). A fresh player per call rather than one long-lived instance:
 * expo-audio's player is a thin native handle: creating and releasing one
 * per beep is cheap, and avoids any "still playing the previous beep" state
 * to manage across rapid repeats (the disconnect beep fires every 15s).
 */
export async function playBeep(): Promise<void> {
  const player = createAudioPlayer(require('../../assets/sounds/beep.wav'));
  player.play();
  setTimeout(() => player.release(), 1000);
}
