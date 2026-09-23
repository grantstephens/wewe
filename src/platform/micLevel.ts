import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { useEffect } from 'react';

/**
 * useMicLevel taps the mic purely for its level (dBFS), independent of the
 * WebRTC audio track `MonitorSession` sends. Two separate capture paths
 * exist because `react-native-webrtc`'s `getUserMedia` track has no metering
 * API of its own — `expo-audio`'s recorder does — so the monitor screen
 * runs both: this one only ever drives the local `NoiseGate` and the level
 * meter UI, and is never written to disk or transmitted.
 *
 * expo-audio's recorder metering has known upstream flakiness on some
 * devices (a `metering` value that stays `undefined` despite
 * `isMeteringEnabled: true` — see expo/expo#37241); `levelDb` surfaces as
 * `null` in that case, and callers (the NoiseGate wiring) fall back to
 * treating the gate as permanently open rather than silently never gating.
 */
export function useMicLevel(): { levelDb: number | null; isReady: boolean } {
  const recorder = useAudioRecorder({ ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, 200);

  useEffect(() => {
    let cancelled = false;
    requestRecordingPermissionsAsync().then((permission) => {
      if (cancelled || !permission.granted) return;
      recorder.record();
    });
    // No explicit recorder.stop() here: useAudioRecorder's own unmount effect
    // (registered before this one, since the hook call precedes this effect)
    // already releases the underlying native MediaRecorder via SharedObject's
    // release lifecycle, which runs first. Calling recorder.stop() afterwards
    // throws "Cannot use shared object that was already released".
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { levelDb: state.metering ?? null, isReady: state.canRecord };
}
