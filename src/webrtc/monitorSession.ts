import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { MediaStream } from 'react-native-webrtc';

import { decideListener, InviteMode } from '../domain/inviteMode';
import type { Store } from '../domain/store';
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteModeSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
import { DEFAULT_ICE_SERVERS } from './rtcConfig';
import { SignalingClient } from './signalingClient';

export interface MonitorSessionOptions {
  signalingUrl: string;
  pairingCode: string;
  iceServers?: RTCIceServer[];
}

export interface MonitorSessionEvents {
  /** Fires whenever the number of currently-connected (RTCPeerConnection state 'connected') listeners changes. */
  onListenerCountChange?: (count: number) => void;
  /** Fires each time the signaling connection retries after an unexpected drop. */
  onSignalingReconnecting?: (attempt: number) => void;
  /** Fires once a signaling retry successfully rejoins the room. */
  onSignalingReconnected?: () => void;
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure. */
  onError?: (message: string) => void;
}

interface Peer {
  pc: RTCPeerConnection;
  iceQueue: IceCandidateQueue;
}

/**
 * MonitorSession is the "I have the microphone" side of a call: it owns the
 * local mic track and is always the offerer for each Parent that joins,
 * since it's the side with media to send. `setGateOpen` is the one method
 * the local `NoiseGate` drives — toggling `track.enabled` costs no
 * renegotiation and no bandwidth while closed, and propagates to every
 * connected listener at once since they all share the same track.
 *
 * Holds one RTCPeerConnection per authorized, connected Parent (deviceId),
 * not just one — see
 * docs/superpowers/specs/2026-09-24-multi-listener-invite-gated-pairing-design.md.
 * Authorization itself is decided entirely here (via `store` +
 * `InviteMode`/`decideListener`), never by the relay — a rejected Parent
 * gets an application-level signal, not a relay-level one, because the
 * relay never learns who's authorized in the first place.
 */
export class MonitorSession {
  private readonly signaling: SignalingClient;
  private readonly peers = new Map<string, Peer>();
  private readonly inviteMode = new InviteMode();
  private localStream: MediaStream | null = null;

  constructor(
    private readonly options: MonitorSessionOptions,
    private readonly store: Store,
    private readonly events: MonitorSessionEvents = {},
  ) {
    this.signaling = new SignalingClient(options.signalingUrl);
  }

  /** Requests the mic and joins the signaling room. Call once; call `stop()` before starting again. */
  async start(): Promise<void> {
    this.localStream = (await mediaDevices.getUserMedia({ audio: true })) as MediaStream;

    await this.signaling.connect(this.options.pairingCode, 'monitor', {
      onPeerJoined: (deviceId) => {
        if (deviceId === undefined) return;
        this.handlePeerJoined(deviceId).catch(() => {
          this.teardownPeer(deviceId);
        });
      },
      onPeerLeft: (deviceId) => {
        if (deviceId === undefined) return;
        this.teardownPeer(deviceId);
        this.inviteMode.close(deviceId);
        this.events.onListenerCountChange?.(this.countConnected());
      },
      onSignal: (payload, from) => {
        this.handleSignal(payload, from).catch(() => {});
      },
      onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
      onReconnected: () => this.events.onSignalingReconnected?.(),
      onError: (message) => this.events.onError?.(message),
    });
  }

  /** Opens invite mode as this device's own screen — a not-yet-authorized Parent is let in and remembered while this (or any other holder) is open. Call in the pairing screen's mount effect. */
  openLocalInvite(): void {
    this.inviteMode.open('local');
  }

  /** Call in the pairing screen's unmount cleanup. */
  closeLocalInvite(): void {
    this.inviteMode.close('local');
  }

  /** Enables or disables the outgoing mic track on every connected peer without renegotiating — the local NoiseGate's hook into this session. */
  setGateOpen(open: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = open;
    }
  }

  stop(): void {
    for (const deviceId of [...this.peers.keys()]) this.teardownPeer(deviceId);
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.signaling.close();
  }

  private async handlePeerJoined(deviceId: string): Promise<void> {
    const authorized = await this.store.isListenerAuthorized(deviceId);
    const decision = decideListener(authorized, this.inviteMode.isOpen);
    if (decision === 'reject') {
      this.signaling.sendSignal({ rejected: true, reason: 'not-authorized' }, deviceId);
      return;
    }
    if (decision === 'accept-new') {
      await this.store.authorizeListener(deviceId);
    }
    await this.createOfferFor(deviceId);
    this.events.onListenerCountChange?.(this.countConnected());
  }

  private countConnected(): number {
    let count = 0;
    for (const { pc } of this.peers.values()) {
      if (pc.connectionState === 'connected') count += 1;
    }
    return count;
  }

  private async createOfferFor(deviceId: string): Promise<void> {
    const pc = this.setupPeerConnection(deviceId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendSignal({ sdp: { sdp: offer.sdp, type: offer.type } }, deviceId);
  }

  private setupPeerConnection(deviceId: string): RTCPeerConnection {
    const existing = this.peers.get(deviceId);
    if (existing) return existing.pc;

    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers ?? DEFAULT_ICE_SERVERS });
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }

    pc.onicecandidate = (event: { candidate: { candidate: string; sdpMLineIndex?: number | null; sdpMid?: string | null } | null }) => {
      if (event.candidate) {
        this.signaling.sendSignal({ candidate: event.candidate }, deviceId);
      }
    };
    pc.onconnectionstatechange = () => {
      this.events.onListenerCountChange?.(this.countConnected());
    };

    this.peers.set(deviceId, { pc, iceQueue: new IceCandidateQueue() });
    return pc;
  }

  private async handleSignal(payload: unknown, from: string | undefined): Promise<void> {
    if (from === undefined) return;

    if (isInviteModeSignal(payload)) {
      // Only an already-connected (and therefore already-authorized) peer
      // may toggle invite mode on the Monitor's behalf — a not-yet-accepted
      // deviceId trying this has no entry in `peers` yet.
      if (!this.peers.has(from)) return;
      if (payload.inviteMode === 'open') this.inviteMode.open(from);
      else this.inviteMode.close(from);
      return;
    }

    const peer = this.peers.get(from);
    if (!peer) return;
    if (isSdpSignal(payload)) {
      await handleIncomingSdp(peer.pc, payload.sdp, peer.iceQueue, (p) => this.signaling.sendSignal(p, from));
    } else if (isCandidateSignal(payload)) {
      await peer.iceQueue.add(peer.pc, payload.candidate);
    }
  }

  private teardownPeer(deviceId: string): void {
    this.peers.get(deviceId)?.pc.close();
    this.peers.delete(deviceId);
  }
}
