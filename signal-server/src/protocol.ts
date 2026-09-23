/** See README.md for the full wire-protocol contract this file types. */

export type Role = 'monitor' | 'parent';

export interface JoinMessage {
  type: 'join';
  room: string;
  role: Role;
}

export interface SignalMessage {
  type: 'signal';
  payload: unknown;
}

export type ClientMessage = JoinMessage | SignalMessage;

export interface JoinedMessage {
  type: 'joined';
  role: Role;
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
}

export interface PeerLeftMessage {
  type: 'peer-left';
}

export type ErrorReason = 'role-taken' | 'must-join-first' | 'invalid-message' | 'room-expired' | 'rate-limited';

export interface ErrorMessage {
  type: 'error';
  message: ErrorReason;
}

export type ServerMessage = JoinedMessage | PeerJoinedMessage | PeerLeftMessage | ErrorMessage | SignalMessage;

/** True iff `value` is a well-formed ClientMessage; narrows the parsed JSON before it's trusted. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const v = value as { type: unknown };
  if (v.type === 'join') {
    const j = value as Partial<JoinMessage>;
    return typeof j.room === 'string' && j.room.length > 0 && (j.role === 'monitor' || j.role === 'parent');
  }
  if (v.type === 'signal') {
    return 'payload' in value;
  }
  return false;
}
