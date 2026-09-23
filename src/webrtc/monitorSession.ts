import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { MediaStream } from 'react-native-webrtc';

import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
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
  /** Fires whenever the underlying RTCPeerConnection's connection state changes (`connecting`, `connected`, `failed`, …). */
  onConnectionStateChange?: (state: string) => void;
  /** Fires each time the signaling connection retries after an unexpected drop. */
  onSignalingReconnecting?: (attempt: number) => void;
  /** Fires once a signaling retry successfully rejoins the room. */
  onSignalingReconnected?: () => void;
}

/**
 * MonitorSession is the "I have the microphone" side of a call: it owns the
 * local mic track and is always the offerer, since it's the side with media
 * to send. `setGateOpen` is the one method the local `NoiseGate` drives —
 * toggling `track.enabled` costs no renegotiation and no bandwidth while
 * closed, which is the entire point of gating at the source (see PLAN.md).
 */
export class MonitorSession {
  private readonly signaling: SignalingClient;
  private readonly iceQueue = new IceCandidateQueue();
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;

  constructor(
    private readonly options: MonitorSessionOptions,
    private readonly events: MonitorSessionEvents = {},
  ) {
    this.signaling = new SignalingClient(options.signalingUrl);
  }

  /** Requests the mic and joins the signaling room. Call once; call `stop()` before starting again. */
  async start(): Promise<void> {
    this.localStream = (await mediaDevices.getUserMedia({ audio: true })) as MediaStream;

    await this.signaling.connect(this.options.pairingCode, 'monitor', {
      onPeerJoined: () => {
        this.createOffer().catch(() => {
          // A failed offer leaves this session with no peer connection; the
          // next 'peer-joined' (the parent retrying) tries again from clean.
          this.teardownPeerConnection();
        });
      },
      onPeerLeft: () => this.teardownPeerConnection(),
      onSignal: (payload) => {
        this.handleSignal(payload).catch(() => {});
      },
      onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
      onReconnected: () => this.events.onSignalingReconnected?.(),
    });
  }

  /** Enables or disables the outgoing mic track without renegotiating — the local NoiseGate's hook into this session. */
  setGateOpen(open: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = open;
    }
  }

  stop(): void {
    this.teardownPeerConnection();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.signaling.close();
  }

  private async createOffer(): Promise<void> {
    const pc = this.setupPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendSignal({ sdp: { sdp: offer.sdp, type: offer.type } });
  }

  private setupPeerConnection(): RTCPeerConnection {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers ?? DEFAULT_ICE_SERVERS });
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }

    pc.onicecandidate = (event: { candidate: { candidate: string; sdpMLineIndex?: number | null; sdpMid?: string | null } | null }) => {
      if (event.candidate) {
        this.signaling.sendSignal({ candidate: event.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      this.events.onConnectionStateChange?.(pc.connectionState);
    };

    this.pc = pc;
    return pc;
  }

  private async handleSignal(payload: unknown): Promise<void> {
    if (!this.pc) return;
    if (isSdpSignal(payload)) {
      await handleIncomingSdp(this.pc, payload.sdp, this.iceQueue, (p) => this.signaling.sendSignal(p));
    } else if (isCandidateSignal(payload)) {
      await this.iceQueue.add(this.pc, payload.candidate);
    }
  }

  private teardownPeerConnection(): void {
    this.pc?.close();
    this.pc = null;
  }
}
