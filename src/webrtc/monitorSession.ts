import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { MediaStream } from 'react-native-webrtc';

import { getOrCreateMonitorRoomId } from '../domain/deviceId';
import { decideListener, InviteMode } from '../domain/inviteMode';
import { getOrCreateMonitorName, setMonitorName } from '../domain/monitorName';
import { generatePairingCode } from '../domain/pairing';
import type { Store } from '../domain/store';
import {
  handleIncomingSdp,
  IceCandidateQueue,
  isCandidateSignal,
  isInviteModeSignal,
  isMonitorNameSignal,
  isSdpSignal,
  isSetMonitorNameSignal,
} from './peerConnectionHelpers';
import { DEFAULT_ICE_SERVERS } from './rtcConfig';
import { SignalingClient } from './signalingClient';

export interface MonitorSessionOptions {
  signalingUrl: string;
  iceServers?: RTCIceServer[];
}

export interface MonitorSessionEvents {
  /** Fires whenever the number of currently-connected (RTCPeerConnection state 'connected') listeners changes. */
  onListenerCountChange?: (count: number) => void;
  /** Fires whenever the currently-displayable pairing code changes — a fresh code (armed or re-armed), or null (the invite window closed). `expiresAt` is a `Date.now()`-comparable epoch ms timestamp, null iff `code` is null. */
  onInviteCodeChange?: (code: string | null, expiresAt: number | null) => void;
  /** Fires each time the signaling connection retries after an unexpected drop. */
  onSignalingReconnecting?: (attempt: number) => void;
  /** Fires once a signaling retry successfully rejoins the room. */
  onSignalingReconnected?: () => void;
  /** Fires on a relay-reported error (e.g. "room-expired") or a socket-level failure. */
  onError?: (message: string) => void;
  /** Fires once this Monitor's display name is first loaded, and again every time it changes (from this device's own screen or a connected Parent's rename request). */
  onMonitorNameChange?: (name: string) => void;
}

/** How long a newly-armed (or re-armed) invite code stays valid before it must be explicitly re-armed. Kept in sync with signal-server's own `DEFAULT_ALIAS_TTL_MS` by convention, not shared code — see that constant's doc comment. */
const INVITE_WINDOW_MS = 60 * 1000;

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
 *
 * Joins its own persistent, never-displayed room (`getOrCreateMonitorRoomId`)
 * directly — the displayed six-digit code is a short-lived relay *alias* for
 * that room (`SignalingClient.setAlias`), not the room itself, per
 * docs/superpowers/specs/2026-09-25-ephemeral-rotating-pairing-codes-design.md.
 * `rearmInvite` generates a fresh code and a fresh `INVITE_WINDOW_MS` window
 * every time it's called; letting that window elapse closes invite mode for
 * everyone currently holding it open, not just whoever started the clock —
 * the code and its lifetime are entirely Monitor-owned.
 */
export class MonitorSession {
  private readonly signaling: SignalingClient;
  private readonly peers = new Map<string, Peer>();
  private readonly inviteMode = new InviteMode();
  /** Remote (Parent) invite-mode holders — a subset of what's in `inviteMode`, tracked separately since `InviteMode` itself doesn't expose holder iteration (deliberately kept minimal/pure — see its own module doc). Used only to know who to notify when the current code changes. */
  private readonly remoteHolders = new Set<string>();
  private localStream: MediaStream | null = null;
  private currentCode: string | null = null;
  private codeExpiresAt: number | null = null;
  private inviteTimer: ReturnType<typeof setTimeout> | null = null;
  private currentName = '';
  /** Whether the *Monitor's own screen* should display `currentCode` — false when the currently-live code was armed on behalf of a remote Parent's invite request, so only that Parent's screen shows it. Independent of `inviteMode`/`remoteHolders`, which track authorization, not display. */
  private localShouldShowCode = false;

  constructor(
    private readonly options: MonitorSessionOptions,
    private readonly store: Store,
    private readonly events: MonitorSessionEvents = {},
  ) {
    this.signaling = new SignalingClient(options.signalingUrl);
  }

  /** Requests the mic and joins this install's own persistent room. Call once; call `stop()` before starting again. */
  async start(): Promise<void> {
    this.localStream = (await mediaDevices.getUserMedia({ audio: true })) as MediaStream;
    const roomId = await getOrCreateMonitorRoomId(this.store);
    this.currentName = await getOrCreateMonitorName(this.store);
    this.events.onMonitorNameChange?.(this.currentName);

    await this.signaling.connect(roomId, 'monitor', {
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
        this.remoteHolders.delete(deviceId);
        this.events.onListenerCountChange?.(this.countConnected());
      },
      onSignal: (payload, from) => {
        this.handleSignal(payload, from).catch(() => {});
      },
      onReconnecting: (attempt) => this.events.onSignalingReconnecting?.(attempt),
      onReconnected: () => {
        this.events.onSignalingReconnected?.();
        // The relay's alias map is keyed by alias string, independent of any
        // one socket, but a reconnect is a brand-new socket that never sent
        // set-alias — a real, reproduced bug: after any drop (a rejected
        // message closing the old socket, a relay restart, a network blip),
        // the code kept counting down client-side looking completely
        // normal, while silently never resolving to this room for anyone
        // who joined with it after the reconnect. Re-registering the same
        // (already-displayed, still-counting-down) code, not a new one,
        // keeps the UI's own countdown meaningful.
        if (this.currentCode !== null) {
          this.signaling.setAlias(this.currentCode);
        }
      },
      onError: (message) => this.events.onError?.(message),
    });
  }

  /** Generates a fresh pairing code, registers it as a relay alias for this room, opens this device's own invite-mode hold, and starts a fresh `INVITE_WINDOW_MS` countdown. Call after `start()` resolves, and again whenever the user explicitly asks to re-open pairing. Always shows the new code on this device's own screen — an explicit local action, unlike a remote Parent's invite request. */
  rearmInvite(): void {
    this.inviteMode.open('local');
    this.localShouldShowCode = true;
    this.armInvite();
  }

  /** Call in the pairing screen's unmount cleanup. Does not affect the code's own countdown or any other holder — see the class doc comment. */
  closeLocalInvite(): void {
    this.inviteMode.close('local');
  }

  /** Renames this Monitor — from its own screen, or internally when handleSignal accepts an authorized peer's setMonitorName request. Persists and re-broadcasts to every currently-connected peer, so both origins produce identical, indistinguishable behavior. */
  renameSelf(name: string): void {
    this.currentName = name;
    setMonitorName(this.store, name).catch(() => {});
    this.events.onMonitorNameChange?.(name);
    for (const deviceId of this.peers.keys()) {
      this.signaling.sendSignal({ monitorName: name }, deviceId);
    }
  }

  /** Enables or disables the outgoing mic track on every connected peer without renegotiating — the local NoiseGate's hook into this session. */
  setGateOpen(open: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = open;
    }
  }

  stop(): void {
    if (this.inviteTimer !== null) {
      clearTimeout(this.inviteTimer);
      this.inviteTimer = null;
    }
    for (const deviceId of [...this.peers.keys()]) this.teardownPeer(deviceId);
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;
    this.signaling.close();
  }

  private armInvite(): void {
    if (this.inviteTimer !== null) {
      clearTimeout(this.inviteTimer);
    }
    const code = generatePairingCode();
    this.currentCode = code;
    this.codeExpiresAt = Date.now() + INVITE_WINDOW_MS;
    this.signaling.setAlias(code);
    this.broadcastInviteCode();
    this.inviteTimer = setTimeout(() => this.expireInvite(), INVITE_WINDOW_MS);
  }

  private expireInvite(): void {
    this.inviteTimer = null;
    this.currentCode = null;
    this.codeExpiresAt = null;
    this.localShouldShowCode = false;
    this.inviteMode.close('local');
    for (const holder of this.remoteHolders) this.inviteMode.close(holder);
    this.remoteHolders.clear();
    this.broadcastInviteCode();
  }

  /** Notifies the Monitor's own screen (only when localShouldShowCode is true, or the code is being cleared — hiding is always shown regardless of who was showing it) and every remote holder (always) of the current code. */
  private broadcastInviteCode(): void {
    if (this.currentCode === null || this.localShouldShowCode) {
      this.events.onInviteCodeChange?.(this.currentCode, this.codeExpiresAt);
    }
    for (const holder of this.remoteHolders) {
      this.signaling.sendSignal({ inviteCode: this.currentCode }, holder);
    }
  }

  /** A remote (already-authorized, already-connected) Parent asked to open invite mode. Reuses the currently-live code if there is one, rather than clobbering whatever the Monitor's own screen (or another Parent) might already be showing — only arms fresh if nothing is currently live. A fresh arm triggered this way never shows the code on the Monitor's own screen — only the requesting Parent's. */
  private ensureInviteArmed(holder: string): void {
    this.remoteHolders.add(holder);
    this.inviteMode.open(holder);
    if (this.currentCode === null) {
      this.localShouldShowCode = false;
      this.armInvite();
    } else {
      this.signaling.sendSignal({ inviteCode: this.currentCode }, holder);
    }
  }

  private closeRemoteInvite(holder: string): void {
    this.remoteHolders.delete(holder);
    this.inviteMode.close(holder);
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
    this.signaling.sendSignal({ monitorName: this.currentName }, deviceId);
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
      const count = this.countConnected();
      this.events.onListenerCountChange?.(count);
      // Once anyone is actually connected, stop showing the code — leaving
      // it visible after that point is pure exposure with no upside (an
      // already-connected listener doesn't need it, and this device's own
      // screen or a connected Parent can always re-arm a fresh one to
      // invite someone else). Idempotent: expireInvite() no-ops once
      // currentCode is already null, so later connection-state churn (a
      // second listener connecting, a flaky ICE restart) doesn't re-fire
      // anything.
      if (count > 0 && this.currentCode !== null) {
        this.expireInvite();
      }
    };

    this.peers.set(deviceId, { pc, iceQueue: new IceCandidateQueue() });
    return pc;
  }

  private async handleSignal(payload: unknown, from: string | undefined): Promise<void> {
    if (from === undefined) return;

    if (isSetMonitorNameSignal(payload)) {
      // Same "already-connected, thus already-authorized" guard as the
      // inviteMode signal below — a not-yet-accepted deviceId has no entry
      // in `peers` yet and can't rename a Monitor it was never let into.
      if (!this.peers.has(from)) return;
      this.renameSelf(payload.setMonitorName);
      return;
    }

    if (isInviteModeSignal(payload)) {
      // Only an already-connected (and therefore already-authorized) peer
      // may toggle invite mode on the Monitor's behalf — a not-yet-accepted
      // deviceId trying this has no entry in `peers` yet.
      if (!this.peers.has(from)) return;
      if (payload.inviteMode === 'open') this.ensureInviteArmed(from);
      else this.closeRemoteInvite(from);
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
