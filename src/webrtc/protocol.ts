/**
 * The client-side half of `signal-server`'s wire protocol — see
 * `signal-server/README.md` for the authoritative contract. Duplicated
 * rather than shared via a package because this crosses a network boundary
 * between two independently deployed processes (the app and any relay
 * instance a user points it at); keeping both typed independently is the
 * same reasoning as versioning any wire format, not accidental drift.
 */
export type Role = 'monitor' | 'parent';

export type ClientMessage =
  | { type: 'join'; room: string; role: Role; deviceId?: string }
  | { type: 'signal'; payload: unknown; to?: string }
  | { type: 'set-alias'; alias: string };

export type ServerMessage =
  | { type: 'joined'; role: Role; room?: string }
  | { type: 'peer-joined'; deviceId?: string }
  | { type: 'peer-left'; deviceId?: string }
  | { type: 'signal'; payload: unknown; from?: string }
  | { type: 'error'; message: string };
