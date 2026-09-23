/**
 * Pairing codes identify a monitor session to the signaling relay (the room
 * name two WebRTC peers rendezvous in) and are what a parent reads off the
 * monitor's screen or scans as a QR code. Deliberately short and numeric —
 * typed by hand as a fallback whenever the camera/QR/mDNS path isn't
 * available.
 *
 * This module is pure: no crypto import, no Math.random call baked in
 * (injectable for deterministic tests). Signing/expiring a code into a
 * short-lived signaling token is a separate concern (Phase 3, remote-access
 * hardening) layered on top of this, not part of code generation itself.
 */
const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_PATTERN = /^\d{6}$/;

/** Uniform integer in [0, maxExclusive), using the platform's default RNG. */
function defaultRandomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/** Generates a fresh pairing code. Not cryptographically bound to anything by itself — see module doc. */
export function generatePairingCode(randomInt: (maxExclusive: number) => number = defaultRandomInt): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += String(randomInt(10));
  }
  return code;
}

/** True iff `code` has the exact shape a pairing code must have (six digits, no separators). */
export function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_PATTERN.test(code);
}

/** The URI embedded in a monitor's pairing QR code; AddMonitor parses this back with `parsePairingUri`. */
export function pairingUri(code: string, signalingServerUrl: string): string {
  return `wewe://pair?code=${encodeURIComponent(code)}&relay=${encodeURIComponent(signalingServerUrl)}`;
}

export interface ParsedPairingUri {
  code: string;
  signalingServerUrl: string;
}

/** Inverse of `pairingUri`. Returns null for anything that isn't a well-formed pairing URI. */
export function parsePairingUri(uri: string): ParsedPairingUri | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'wewe:' || url.hostname !== 'pair') return null;
  const code = url.searchParams.get('code');
  const relay = url.searchParams.get('relay');
  if (!code || !relay || !isValidPairingCode(code)) return null;
  return { code, signalingServerUrl: relay };
}
