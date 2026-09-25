import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { MediaStream } from 'react-native-webrtc';

import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteCodeSignal,
  isMonitorNameSignal,
  isRejectedSignal,
  isSdpSignal,
} from './peerConnectionHelpers';
import { DEFAULT_ICE_SERVERS } from './rtcConfig';
import { SignalingClient } from './signalingClient';

export interface ParentSessionOptions {
  signalingUrl: string;
  /** The relay room to join — either a still-live rotating pairing code (first-time pairing) or a Monitor's stable, persistent roomId (every reconnect after that). ParentSession treats both identically; only the caller knows which kind of value this is. */
  room: string;
  /** This install's persistent device identifier — see src/domain/deviceId.ts. Lets the Monitor recognize a reconnect versus a new device. */
  deviceId: string;
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
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure — see SignalingClient.onError. */
  onError?: (message: string) => void;
  /** Fires when the Monitor rejects this device — not yet authorized, and invite mode wasn't open at the time. Retrying later (e.g. once someone opens invite mode) can still succeed. */
  onRejected?: (reason: string) => void;
  /** Fires on every successful join (initial and each reconnect) with the room the relay actually resolved `options.room` to — this is how a Parent learns the Monitor's stable roomId, whether `options.room` was a live alias or already the real thing. */
  onRoomResolved?: (room: string) => void;
  /** Fires when the Monitor sends the currently-live pairing code after this Parent asked to invite a listener (see `setInviteMode`) — null means the invite window closed. */
  onInviteCode?: (code: string | null) => void;
  /** Fires once, as soon as the Monitor first tells this Parent its display name (right after being accepted), and again every time the Monitor's name changes — from its own screen or any connected Parent's rename request, this Parent's own included. */
  onMonitorNameChanged?: (name: string) => void;
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
    await this.signaling.connect(
      this.options.room,
      'parent',
      {
        onPeerLeft: () => this.teardownPeerConnection(),
        onSignal: (payload) => {
          this.handleSignal(payload).catch(() => {});
        },
        onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
        onReconnected: () => this.events.onSignalingReconnected?.(),
        onError: (message) => this.events.onError?.(message),
        onJoined: (room) => {
          if (room !== undefined) this.events.onRoomResolved?.(room);
        },
      },
      this.options.deviceId,
    );
  }

  /** Asks the Monitor to open or close invite mode on this Parent's behalf — only honored if the Monitor still considers this deviceId connected (see MonitorSession.handleSignal). */
  setInviteMode(open: boolean): void {
    this.signaling.sendSignal({ inviteMode: open ? 'open' : 'closed' });
  }

  /** Asks the Monitor to rename itself — only honored if the Monitor still considers this deviceId connected. The confirmed new name arrives back via onMonitorNameChanged, same as any other rename (see MonitorSession.renameSelf). */
  renameMonitor(name: string): void {
    this.signaling.sendSignal({ setMonitorName: name });
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
    if (isRejectedSignal(payload)) {
      this.events.onRejected?.(payload.reason);
      return;
    }
    if (isInviteCodeSignal(payload)) {
      this.events.onInviteCode?.(payload.inviteCode);
      return;
    }
    if (isMonitorNameSignal(payload)) {
      this.events.onMonitorNameChanged?.(payload.monitorName);
      return;
    }
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
