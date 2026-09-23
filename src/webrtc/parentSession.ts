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

export interface ParentSessionOptions {
  signalingUrl: string;
  pairingCode: string;
  iceServers?: RTCIceServer[];
}

export interface ParentSessionEvents {
  onConnectionStateChange?: (state: string) => void;
  /** Fires once the monitor's audio track arrives; react-native-webrtc routes it to the device speaker automatically, this is for UI state only. */
  onRemoteStream?: (stream: MediaStream) => void;
  /** Fires each time the signaling connection retries after an unexpected drop. */
  onSignalingReconnecting?: (attempt: number) => void;
  /** Fires once a signaling retry successfully rejoins the room. */
  onSignalingReconnected?: () => void;
}

/**
 * ParentSession is the "I'm listening" side: it never has its own media to
 * offer at connect time, so it always answers the monitor's initial offer
 * rather than initiating. It can still become an offerer later — see
 * `startTalking` — because `handleIncomingSdp` decides what to do with an
 * incoming description from its `type`, not from which side historically
 * went first.
 */
export class ParentSession {
  private readonly signaling: SignalingClient;
  private readonly iceQueue = new IceCandidateQueue();
  private pc: RTCPeerConnection | null = null;
  private talkStream: MediaStream | null = null;

  constructor(
    private readonly options: ParentSessionOptions,
    private readonly events: ParentSessionEvents = {},
  ) {
    this.signaling = new SignalingClient(options.signalingUrl);
  }

  async start(): Promise<void> {
    this.setupPeerConnection();
    await this.signaling.connect(this.options.pairingCode, 'parent', {
      onPeerLeft: () => this.teardownPeerConnection(),
      onSignal: (payload) => {
        this.handleSignal(payload).catch(() => {});
      },
      onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
      onReconnected: () => this.events.onSignalingReconnected?.(),
    });
  }

  /**
   * Push-to-talk. The mic is requested once, lazily, on the first call —
   * that first call also triggers the one renegotiation ever needed to add
   * the talk-back track. Every call after that just toggles `enabled`,
   * exactly like `MonitorSession.setGateOpen`, and costs no renegotiation.
   */
  async startTalking(): Promise<void> {
    const pc = this.pc ?? this.setupPeerConnection();
    if (!this.talkStream) {
      this.talkStream = (await mediaDevices.getUserMedia({ audio: true })) as MediaStream;
      for (const track of this.talkStream.getAudioTracks()) {
        pc.addTrack(track, this.talkStream);
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.sendSignal({ sdp: { sdp: offer.sdp, type: offer.type } });
      return;
    }
    for (const track of this.talkStream.getAudioTracks()) track.enabled = true;
  }

  stopTalking(): void {
    for (const track of this.talkStream?.getAudioTracks() ?? []) track.enabled = false;
  }

  /**
   * Reads the inbound audio level from the standard WebRTC stats API
   * (`RTCInboundRtpStreamStats.audioLevel`, 0–1 linear) and converts it to
   * dBFS so it composes with `NoiseGate`/`CryAlertClassifier`, both of
   * which work in dB. Returns null before any inbound-rtp stats exist yet
   * (nothing has arrived) or once the connection is gone.
   */
  async getRemoteAudioLevel(): Promise<number | null> {
    if (!this.pc) return null;
    const report: Map<string, Record<string, unknown>> = await this.pc.getStats();
    for (const stats of report.values()) {
      if (stats['type'] === 'inbound-rtp' && stats['kind'] === 'audio' && typeof stats['audioLevel'] === 'number') {
        const linear = Math.max(stats['audioLevel'] as number, 1e-6);
        return 20 * Math.log10(linear);
      }
    }
    return null;
  }

  stop(): void {
    this.teardownPeerConnection();
    for (const track of this.talkStream?.getTracks() ?? []) track.stop();
    this.talkStream = null;
    this.signaling.close();
  }

  private setupPeerConnection(): RTCPeerConnection {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers ?? DEFAULT_ICE_SERVERS });

    pc.onicecandidate = (event: { candidate: { candidate: string; sdpMLineIndex?: number | null; sdpMid?: string | null } | null }) => {
      if (event.candidate) {
        this.signaling.sendSignal({ candidate: event.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      this.events.onConnectionStateChange?.(pc.connectionState);
    };
    pc.ontrack = (event: { streams: MediaStream[] }) => {
      const stream = event.streams[0];
      if (stream) this.events.onRemoteStream?.(stream);
    };

    this.pc = pc;
    return pc;
  }

  private async handleSignal(payload: unknown): Promise<void> {
    const pc = this.pc ?? this.setupPeerConnection();
    if (isSdpSignal(payload)) {
      await handleIncomingSdp(pc, payload.sdp, this.iceQueue, (p) => this.signaling.sendSignal(p));
    } else if (isCandidateSignal(payload)) {
      await this.iceQueue.add(pc, payload.candidate);
    }
  }

  private teardownPeerConnection(): void {
    this.pc?.close();
    this.pc = null;
  }
}
