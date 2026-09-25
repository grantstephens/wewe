import { SETTINGS_KEYS, type Store } from './store';

const DEVICE_ID_BYTES = 16; // 128 bits — see the module doc for why Math.random-grade randomness is fine here.

/** Uniform integer in [0, maxExclusive), using the platform's default RNG — same injection pattern as pairing.ts's generatePairingCode. */
function defaultRandomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/**
 * Generates a fresh, opaque device identifier. Not a bearer secret: a
 * Monitor only ever recognizes a deviceId it already authorized (see
 * Store.isListenerAuthorized), which itself requires having connected
 * while invite mode was open at least once — this token's only job is
 * letting the Monitor tell "the same device as before" apart from "a
 * stranger presenting the pairing code for the first time". That's why
 * Math.random (injectable, same pattern as generatePairingCode) is
 * sufficient — unlike the pairing code itself, this isn't the thing
 * standing between a stranger and access.
 */
export function generateDeviceId(randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  let id = '';
  for (let i = 0; i < DEVICE_ID_BYTES; i++) {
    id += randomInt(256).toString(16).padStart(2, '0');
  }
  return id;
}

/**
 * Returns this install's persistent device identifier, generating and
 * persisting one on first use. Not tied to any account or PII.
 */
export async function getOrCreateDeviceId(store: Store): Promise<string> {
  const existing = await store.getSetting(SETTINGS_KEYS.deviceId);
  if (existing) return existing;
  const id = generateDeviceId();
  await store.setSetting(SETTINGS_KEYS.deviceId, id);
  return id;
}

/**
 * Returns this Monitor install's persistent, unguessable relay room id,
 * generating and persisting one on first use — the same shape as
 * `getOrCreateDeviceId`, just a different settings key and a different
 * purpose (a room a Monitor always joins directly, never a token proving
 * "the same device as before"). Deliberately independent of `deviceId`:
 * a device could in principle run both a Monitor session and, at some
 * later point, pair as a Parent to a different Monitor — the two
 * identities must never collide.
 */
export async function getOrCreateMonitorRoomId(store: Store): Promise<string> {
  const existing = await store.getSetting(SETTINGS_KEYS.monitorRoomId);
  if (existing) return existing;
  const id = generateDeviceId();
  await store.setSetting(SETTINGS_KEYS.monitorRoomId, id);
  return id;
}
