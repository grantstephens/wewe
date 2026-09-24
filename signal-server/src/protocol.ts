/** See README.md for the full wire-protocol contract this file types. */

export type Role = 'monitor' | 'parent';

export interface JoinMessage {
  type: 'join';
  room: string;
  role: Role;
  /** Required when role is 'parent' — identifies this specific device across reconnects. Not used for 'monitor' (a room only ever has one). */
  deviceId?: string;
}

export interface SignalMessage {
  type: 'signal';
  payload: unknown;
  /** Which Parent to route to. Required from the Monitor (which may have several Parents connected); omitted from a Parent (there's only one Monitor to reach). */
  to?: string;
}

export type ClientMessage = JoinMessage | SignalMessage;

export interface JoinedMessage {
  type: 'joined';
  role: Role;
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
  /** Present only in the message sent to the Monitor, identifying which Parent joined. Absent in the message sent to a Parent (it only ever has the Monitor as a peer). */
  deviceId?: string;
}

export interface PeerLeftMessage {
  type: 'peer-left';
  /** Same deviceId convention as PeerJoinedMessage. */
  deviceId?: string;
}

export type ErrorReason = 'role-taken' | 'must-join-first' | 'invalid-message' | 'room-expired' | 'rate-limited';

export interface ErrorMessage {
  type: 'error';
  message: ErrorReason;
}

export interface ServerSignalMessage {
  type: 'signal';
  payload: unknown;
  /** The sending Parent's deviceId, present only in messages delivered to the Monitor. */
  from?: string;
}

export type ServerMessage = JoinedMessage | PeerJoinedMessage | PeerLeftMessage | ErrorMessage | ServerSignalMessage;

/** True iff `value` is a well-formed ClientMessage; narrows the parsed JSON before it's trusted. */
export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const v = value as { type: unknown };
  if (v.type === 'join') {
    const j = value as Partial<JoinMessage>;
    if (typeof j.room !== 'string' || j.room.length === 0) return false;
    if (j.role !== 'monitor' && j.role !== 'parent') return false;
    if (j.role === 'parent' && typeof j.deviceId !== 'string') return false;
    return true;
  }
  if (v.type === 'signal') {
    if (!('payload' in value)) return false;
    const s = value as Partial<SignalMessage>;
    return s.to === undefined || typeof s.to === 'string';
  }
  return false;
}
