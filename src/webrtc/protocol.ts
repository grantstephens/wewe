/**
 * The client-side half of `signal-server`'s wire protocol — see
 * `signal-server/README.md` for the authoritative contract. Duplicated
 * rather than shared via a package because this crosses a network boundary
 * between two independently deployed processes (the app and any relay
 * instance a user points it at); keeping both typed independently is the
 * same reasoning as versioning any wire format, not accidental drift.
 */
export type Role = 'monitor' | 'parent';

export type ClientMessage = { type: 'join'; room: string; role: Role } | { type: 'signal'; payload: unknown };

export type ServerMessage =
  | { type: 'joined'; role: Role }
  | { type: 'peer-joined' }
  | { type: 'peer-left' }
  | { type: 'signal'; payload: unknown }
  | { type: 'error'; message: string };
