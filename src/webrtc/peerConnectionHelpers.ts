import { RTCIceCandidate, type RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';

/**
 * The wire shapes carried inside a signaling `signal` message's `payload`.
 * Defined locally rather than imported from react-native-webrtc: its own
 * `RTCSessionDescriptionInit`/ICE-candidate-init types are either internal
 * (not exported from the package root) or absent entirely, and
 * `RTCSessionDescription`/`RTCIceCandidate`'s constructors accept these
 * shapes structurally regardless of what the parameter type is named.
 */
export interface WireSdp {
  sdp: string;
  type: string;
}

export interface WireIceCandidate {
  candidate: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
}

export type SignalPayload =
  | { sdp: WireSdp }
  | { candidate: WireIceCandidate }
  | { rejected: true; reason: string }
  | { inviteMode: 'open' | 'closed' };

/** True iff `payload` is the SDP half of a SignalPayload. */
export function isSdpSignal(payload: unknown): payload is { sdp: WireSdp } {
  return typeof payload === 'object' && payload !== null && 'sdp' in payload;
}

/** True iff `payload` is the ICE-candidate half of a SignalPayload. */
export function isCandidateSignal(payload: unknown): payload is { candidate: WireIceCandidate } {
  return typeof payload === 'object' && payload !== null && 'candidate' in payload;
}

/** True iff `payload` is a Monitor's "you're not authorized" rejection, sent to a Parent whose deviceId isn't authorized and invite mode isn't open. */
export function isRejectedSignal(payload: unknown): payload is { rejected: true; reason: string } {
  return typeof payload === 'object' && payload !== null && 'rejected' in payload;
}

/** True iff `payload` is a Parent's request to open/close the Monitor's invite mode on its behalf — only honored by MonitorSession from an already-connected (thus already-authorized) sender. */
export function isInviteModeSignal(payload: unknown): payload is { inviteMode: 'open' | 'closed' } {
  return typeof payload === 'object' && payload !== null && 'inviteMode' in payload;
}

/**
 * IceCandidateQueue holds ICE candidates that arrive over signaling before
 * `setRemoteDescription` has completed — a real race in WebRTC's normal
 * offer/answer flow, not an edge case: the other side can start trickling
 * candidates the instant it creates its description, which routinely beats
 * this side's signaling round-trip for the description itself.
 * `addIceCandidate` before a remote description exists rejects, so anything
 * that arrives early is held here and flushed once it's safe.
 */
export class IceCandidateQueue {
  private pending: WireIceCandidate[] = [];
  private remoteDescriptionSet = false;

  /** Queues the candidate if the remote description isn't set yet, otherwise adds it immediately. */
  async add(pc: RTCPeerConnection, candidate: WireIceCandidate): Promise<void> {
    if (this.remoteDescriptionSet) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      return;
    }
    this.pending.push(candidate);
  }

  /** Call once `setRemoteDescription` has resolved; adds every candidate that arrived early. */
  async flush(pc: RTCPeerConnection): Promise<void> {
    this.remoteDescriptionSet = true;
    const queued = this.pending;
    this.pending = [];
    for (const candidate of queued) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
}

/**
 * handleIncomingSdp is the one place that decides what an incoming SDP
 * description means, shared by both `MonitorSession` and `ParentSession` so
 * either side can renegotiate at any time (needed for push-to-talk: the
 * Parent, normally only ever an answerer for the initial call, becomes an
 * offerer the moment it adds its own talk-back track). An `offer` always
 * gets answered; an `answer` never does — the type on the wire, not which
 * role historically initiated the connection, decides.
 */
export async function handleIncomingSdp(
  pc: RTCPeerConnection,
  sdp: WireSdp,
  iceQueue: IceCandidateQueue,
  sendSignal: (payload: SignalPayload) => void,
): Promise<void> {
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await iceQueue.flush(pc);
  if (sdp.type === 'offer') {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ sdp: { sdp: answer.sdp, type: answer.type } });
  }
}

export { RTCSessionDescription };
