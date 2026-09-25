import { SETTINGS_KEYS, type Store } from './store';

/**
 * A deliberately small, hand-picked wordlist — every combination reads as a
 * harmless, cozy label (this is a baby monitor's default name, potentially
 * shown to a stranger who scans a QR code during an invite window), never
 * anything alarming or ambiguous. 40x40 = 1,600 combinations, plenty for
 * telling monitors on a dashboard apart without ever needing to be
 * unguessable — unlike `monitorRoomId`, this name is never a secret.
 */
const ADJECTIVES = [
  'quiet', 'gentle', 'cozy', 'sleepy', 'happy', 'curious', 'playful', 'bright',
  'calm', 'tiny', 'brave', 'cheerful', 'drowsy', 'fuzzy', 'giggly', 'humble',
  'jolly', 'kind', 'lively', 'merry', 'nimble', 'perky', 'quirky', 'radiant',
  'silly', 'snug', 'sunny', 'sweet', 'tidy', 'vivid', 'witty', 'zesty',
  'breezy', 'chirpy', 'dandy', 'eager', 'fluffy', 'glowing', 'hushed', 'mellow',
] as const;

const ANIMALS = [
  'rabbit', 'otter', 'panda', 'koala', 'fox', 'owl', 'deer', 'lamb', 'duck',
  'mouse', 'bear', 'hedgehog', 'squirrel', 'sparrow', 'kitten', 'puppy',
  'seal', 'dolphin', 'penguin', 'raccoon', 'badger', 'beaver', 'chipmunk',
  'robin', 'finch', 'wren', 'lynx', 'moose', 'elk', 'hare', 'gecko', 'turtle',
  'swan', 'heron', 'crane', 'dove', 'lark', 'wombat', 'quokka', 'alpaca',
] as const;

/** Uniform integer in [0, maxExclusive), using the platform's default RNG — same injection pattern as pairing.ts's generatePairingCode. */
function defaultRandomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/** Generates a fresh "adjective-animal" display name, e.g. "raring-rabbit". Not unique, not a secret — purely for telling monitors apart at a glance. */
export function generateMonitorName(randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const animal = ANIMALS[randomInt(ANIMALS.length)];
  return `${adjective}-${animal}`;
}

/** Returns this Monitor install's current display name, generating and persisting one on first use. */
export async function getOrCreateMonitorName(store: Store): Promise<string> {
  const existing = await store.getSetting(SETTINGS_KEYS.monitorName);
  if (existing) return existing;
  const name = generateMonitorName();
  await store.setSetting(SETTINGS_KEYS.monitorName, name);
  return name;
}

/** Persists a new display name, overwriting whatever was there before — called on an explicit rename, from either the Monitor's own screen or an authorized Parent's request (see MonitorSession.renameSelf). */
export async function setMonitorName(store: Store, name: string): Promise<void> {
  await store.setSetting(SETTINGS_KEYS.monitorName, name);
}
