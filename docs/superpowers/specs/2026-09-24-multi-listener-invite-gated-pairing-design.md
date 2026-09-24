# Multi-listener support with invite-gated pairing

**Date:** 2026-09-24
**Status:** Approved, pending implementation plan

## Problem

Today, pairing a Parent to a Monitor uses one six-digit code that:

1. Is now persisted indefinitely (`SETTINGS_KEYS.monitorPairingCode`, fixed earlier
   today so an already-paired Parent doesn't get silently orphaned every time the
   Monitor screen is closed and reopened).
2. Is the *only* thing standing between a stranger who once saw it (shoulder-surfed,
   screenshotted, found in a photo) and listening in on the nursery indefinitely — the
   relay has no concept of device identity, so a second device presenting the same code
   is indistinguishable from the legitimate Parent reconnecting.
3. Only supports exactly one Parent connected to a Monitor at a time — `signal-server`
   hard-rejects a second socket taking an already-occupied role in a room.

This spec covers two changes together, since they share the same underlying
mechanism (device identity + relay multi-party support): letting more than one Parent
listen to a Monitor simultaneously, and making new-device pairing time-boxed rather
than a standing, indefinitely-valid secret.

## Goals

- A stranger who has seen the pairing code cannot use it to start listening unless
  someone already inside (the Monitor, or an already-authorized Parent) is actively
  holding an "inviting" screen open at that moment.
- An already-authorized Parent can always reconnect — screen-off, app restart, network
  blip, days later — without needing the code shown again. (This is the invariant fixed
  earlier today; this design must not regress it.)
- Multiple Parents can listen to one Monitor at the same time.
- An already-connected, authorized Parent can invite a new listener itself, not just
  the Monitor.
- The relay (`signal-server`) stays fully stateless — no database, no persisted
  authorization data, nothing surviving past an open room's in-memory lifetime. This is
  a deliberate, already-documented property (see `signal-server/README.md`) and this
  feature must not compromise it.

## Non-goals (out of scope for this spec)

- Revoking a previously-authorized device. No "remove this listener" UI exists on the
  Monitor side yet (Home's monitor list got rename/remove today, but that's the
  *Parent's* list of monitors it watches, a different list from what this spec adds —
  the Monitor's list of who's allowed to listen to *it*). Worth doing later as a
  natural follow-up; not built now.
- An invite-mode timeout independent of screen lifecycle (e.g., auto-closing after N
  minutes even if left open). Tying it to the screen being mounted is sufficient for
  the stated requirement ("valid while shown"); a belt-and-suspenders timer is YAGNI
  unless it proves necessary in practice.
- Any server-side (relay) authorization logic. The relay does not learn or decide who's
  authorized — seeing why is the point of this design (see "Why authorization stays
  client-side" below).

## Design

### Device identity

Each Parent generates a random, opaque `deviceId` (e.g. a UUID) the first time the app
runs, stored in `SETTINGS_KEYS.deviceId` (new key) and never regenerated. It is not tied
to any account or PII — just a token the Monitor can recognize on a later reconnect. The
Monitor does not need its own `deviceId`: a room only ever has one Monitor, so there's
nothing to disambiguate on that side.

### Why authorization stays client-side, on the Monitor

The relay already documents itself as never storing anything beyond an open room's
in-memory state, specifically so it never becomes a place that knows who's listening to
whom. Moving "is this deviceId allowed" into the relay would mean the relay starts
making privacy-relevant decisions and needs a real database to remember them across
reconnects — a much bigger, unwanted architectural shift. Instead, the relay becomes
"multi-party-aware but decision-blind": it lets any well-formed `join` succeed at the
room-membership level and *tells the Monitor who joined*, but the Monitor's own
application code is the only thing that ever decides whether to actually engage that
peer in a WebRTC handshake. A rejected peer gets an application-level "not authorized"
message carried over the *existing* opaque `signal` channel — the relay doesn't need a
new message type to express rejection, because it never has to understand what
rejection means.

### Relay protocol changes (`signal-server`)

**Room shape** changes from `{ monitor, parent }` to `{ monitor, parents: Map<deviceId,
socket> }`.

**`join` message** gains a `deviceId` field, required when `role: "parent"`:

```
{ type: "join", room: string, role: "monitor" | "parent", deviceId?: string }
```

- `role: "monitor"` behaves as today: a second monitor joining an occupied room still
  gets `role-taken`.
- `role: "parent"` with a `deviceId` that has no existing connection in this room:
  joins normally: an in-memory `Map<deviceId, socket>` entry, `joined` acked, and the
  Monitor gets `peer-joined` with that `deviceId`.
- `role: "parent"` with a `deviceId` that already has a live connection in this room
  (a reconnect after a network blip, not a new device): the old socket for that
  `deviceId` is replaced silently — closed without emitting `peer-left`, new one
  installed — so a normal reconnect doesn't look like a stranger joining and doesn't
  spuriously re-trigger the Monitor's authorization check for an already-approved
  device.
- `role: "parent"` with no `deviceId` at all: rejected with `invalid-message` (matches
  the existing validation error for a malformed join).

**`signal` message** gains routing, since a room can now hold more than two parties:

```
{ type: "signal", payload: unknown, to?: string }   // client → server
{ type: "signal", payload: unknown, from?: string } // server → client
```

- From a Parent: `to` is omitted (there's only one Monitor to reach).
- From the Monitor: `to` is the target Parent's `deviceId` — required, since the
  Monitor may have several Parents connected and the relay needs to know which one to
  forward to. Missing `to` from a Monitor is `invalid-message`.
- Delivered to the Monitor: `from` carries the sending Parent's `deviceId`, so the
  Monitor's app code knows which of its several `RTCPeerConnection`s (or "should I
  create one") this signal belongs to.
- Delivered to a Parent: no `from` needed (a Parent only ever talks to the one Monitor).

**`peer-joined` / `peer-left`** gain a `deviceId` field when sent to the Monitor (a
Parent doesn't need one — it only ever has the Monitor as its peer). Sent to a Parent,
these stay exactly as they are today (a Parent only cares "is the Monitor here").

None of this requires the relay to look inside `payload` or retain anything past the
room's existing in-memory lifetime (still cleaned up the same way — room TTL if only
one side ever showed up, closed when both sides disconnect).

### Monitor-side authorization

New `Store` capability (new SQLite table, `authorized_listeners`, columns `deviceId
TEXT PRIMARY KEY, addedAt TEXT NOT NULL` — mirrors the existing `monitors`/`events`
table conventions): `isListenerAuthorized(deviceId)`, `authorizeListener(deviceId)`.
Global to this installation (a device only ever monitors as itself, so there's no
"which monitor record" to scope it to, unlike the Parent side's per-paired-monitor
data).

**Invite mode** is a piece of in-memory state on the Monitor (not persisted — it's
meaningless across an app restart; the pairing screen isn't open across a restart by
definition), toggled on/off by whichever screen currently has "inviting" active,
described below.

**On `peer-joined` with a `deviceId`,** `MonitorSession` checks, in order:

1. Already authorized → proceed normally (create the peer connection, wait for/send
   the offer as usual).
2. Not authorized, but invite mode is currently open → authorize it (write to the new
   table) and proceed normally.
3. Not authorized, invite mode closed → send `{ type: "signal", to: deviceId, payload:
   { rejected: true, reason: "not-authorized" } }` and do not create a peer connection
   for this `deviceId`. `peer-left` (or a fresh `join` retry) from this `deviceId`
   afterward is handled the same way each time — no lockout, no rate limiting beyond
   what the relay already does for `join` attempts generally.

### Opening invite mode from a connected Parent

An already-authorized, already-connected Parent can ask the Monitor to open invite
mode by sending its own opaque signal payload: `{ type: "signal", payload: {
inviteMode: "open" } }` (and `"closed"` when its own invite screen closes/unmounts).
The Monitor's `MonitorSession` recognizes this shape from an *already-authorized*
sender only — an unauthorized `deviceId` cannot use this to open the door for itself;
it would already have been rejected at the `peer-joined` check before ever reaching a
point where the Monitor listens to its signals.

The Monitor's own pairing screen being open adds to the same set directly (no signal
round-trip needed, it's the same process).

Tracked as a `Set<string>` of "holders" (`'local'` for the Monitor's own screen, or a
Parent's `deviceId` for one opened remotely), not a single boolean — invite mode is
open iff the set is non-empty. This matters: if it were a plain boolean, one holder
closing its own invite screen could incorrectly turn invite mode off while another
holder still has theirs open. A holder is removed from the set when its screen
unmounts, or (for a remote Parent) when that Parent's connection drops entirely — an
authorized Parent that vanishes mid-invite shouldn't leave invite mode stuck open
forever.

### `MonitorSession` changes

Moves from a single `RTCPeerConnection` (`this.pc`) to `Map<deviceId,
RTCPeerConnection>`, each with its own `IceCandidateQueue` (ICE candidates are
connection-specific). All share the same `localStream`/mic track — WebRTC supports
adding one `MediaStreamTrack` to multiple `RTCPeerConnection`s, so `setGateOpen`
toggling `track.enabled` still propagates to every connected listener from one place,
unchanged.

`onConnectionStateChange`-style events become per-`deviceId` (a `Map` or an event
carrying which `deviceId` changed state) — Monitor.tsx's UI needs to show something
sane for "N listeners connected" rather than a single connection-state string; exact
UI treatment is an implementation-time decision, not pinned down further here.

### `ParentSession` changes

- Generates/loads its own persistent `deviceId` (new small domain helper, e.g.
  `src/domain/deviceId.ts`, following the same `Store`-backed pattern as other
  settings) and sends it on `join`.
- Handles the `{ rejected: true, reason: "not-authorized" }` signal payload: surfaces
  it to `Parent.tsx` as a distinct state ("Ask the monitor to let you in" rather than
  the generic connect-timeout message added earlier today) instead of leaving the
  Parent stuck in a plain unconnected state.
- Gains a way to send `{ inviteMode: "open" | "closed" }` for the "show a code from an
  already-connected Parent" requirement — exact UI entry point (a button on the Parent
  screen, presumably) is an implementation-time decision.

### What "showing a code" from a Parent actually shows

The Parent doesn't know the Monitor's underlying pairing code/room name from a fresh
install — but it does, once paired (it's `monitor.lastPairingCode`, already stored
locally today). So an already-connected Parent's "invite a listener" action reuses that
*same* stored code/QR — it's the identical one the Monitor itself would show, not a
separately generated value. What changes when a Parent shows it is only that this
Parent's own `{ inviteMode: "open" }` signal is what holds the door open, not the
Monitor's own screen.

## Testing strategy

- `signal-server`: extend the existing `TestClient`-based test suite (per its own
  gotcha about persistent per-socket queues, not one-off `.once('message', …)`) to
  cover: two parents joining one room, `signal` routing by `to`/`from`, a same-`deviceId`
  reconnect not triggering spurious `peer-left`, and the existing single-parent
  behavior staying correct as a regression check.
- `MonitorSession`/`ParentSession`: no existing test coverage for these classes today
  (confirmed absent) — this is a good forcing function to add some, at least for the
  new multi-peer bookkeeping and the authorization decision logic, which is pure and
  testable independent of real WebRTC.
- Manual, on real devices (as established this session): three phones — one Monitor,
  two Parents — confirming simultaneous listening, an unauthorized third device
  correctly getting rejected outside invite mode, and correctly getting in in invite
  mode via either the Monitor's own screen or a connected Parent's.

## Migration

`authorized_listeners` is a new table (`CREATE TABLE IF NOT EXISTS`, same pattern as
existing `SqliteStore` tables) — no migration of existing data needed, since no
authorization concept existed before this. Existing paired monitors on the Parent side
are unaffected (that table/flow doesn't change). The persisted
`SETTINGS_KEYS.monitorPairingCode` from earlier today is unaffected — it's still the
stable room name; this design only changes what a *new*, previously-unseen `deviceId`
is allowed to do with it.
