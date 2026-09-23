/**
 * Public STUN only for v1 (see PLAN.md's "Confirmed scope decisions" #3):
 * no TURN relay is run or shipped. Accepted limitation — carrier-grade NAT
 * on either end (common on cellular) can make ICE fail with no TURN
 * fallback. A user can still override this from Settings if they run their
 * own TURN server.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
