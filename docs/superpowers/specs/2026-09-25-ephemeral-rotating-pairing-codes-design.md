# Ephemeral, rotating pairing codes

**Date:** 2026-09-25
**Status:** Approved, pending implementation plan
**Supersedes:** the "An invite-mode timeout independent of screen lifecycle" non-goal in
[`2026-09-24-multi-listener-invite-gated-pairing-design.md`](2026-09-24-multi-listener-invite-gated-pairing-design.md),
which reasoned that tying invite mode purely to screen-mount lifecycle would be
sufficient. In practice, leaving the Monitor screen open (a normal thing to do — it's
the "is my baby okay" screen) left a static, indefinitely-valid code exposed for as long
as the screen stayed up, which is exactly the standing-invitation problem that spec's
own Goals section set out to avoid. This spec closes that gap.

## Problem

Today, after the 2026-09-24 multi-listener/invite-gated-pairing work landed, the
six-digit pairing code:

1. Is stable for the lifetime of the app install (`SETTINGS_KEYS.monitorPairingCode`),
   and doubles as the relay room name itself.
2. Grants a **new** device a window to get authorized for as long as the Monitor's own
   pairing screen (or an inviting Parent's screen) happens to be open — which, in
   practice, can be hours, since there's no reason for a parent not to leave the Monitor
   screen up.
3. Being both the room name *and* the thing that gates new pairing means it can never
   safely rotate on its own: changing it would silently orphan every already-authorized
   Parent, whose stored `lastPairingCode` is also its connection target.

Point 3 is the reason point 2 hasn't already been fixed by "just expire it faster" — the
code has been doing two jobs (a stable rendezvous address, and a one-time invite secret)
that need different lifetimes, and conflating them is what makes either one hard to fix
without breaking the other.

## Goals

- A brand-new device's window to get authorized is short (a fixed, small number of
  seconds), not "as long as a screen happens to be open."
- After that window lapses, getting a new device authorized requires a deliberate,
  active step (tapping something) — not something that silently continues just because
  a screen is still on-screen.
- The *displayed* code changes every time that window is (re)armed — a code an attacker
  captured once (shoulder-surf, screenshot, a photo) stops being useful shortly
  afterward, not indefinitely.
- None of the above may regress the 2026-09-24 spec's own core invariant: an
  already-authorized Parent reconnects — screen-off, app restart, network blip, days
  later — without ever needing to see a code again.
- The relay stays fully stateless in the same sense as before: nothing it holds survives
  past an open room's (or, new in this spec, an alias's) in-memory TTL.

## Non-goals

- Revoking a previously-authorized device (still deferred, per the prior spec).
- HMAC-signing the code (considered; see "Relay protocol changes" — the relay is
  already the authoritative source of truth for whether a code is currently live, so a
  signature would only prove provenance, not liveness, and liveness is the thing that
  actually matters here).
- Any migration path for pairings made before this ships. `PairedMonitor.id` changes
  from "is the pairing code" to a separately-generated value, and `lastPairingCode` is
  repurposed into a different field with different semantics (see "Storage changes") —
  existing beta-stage pairings need to be re-added once this ships. Consistent with this
  project's existing stated posture (uninstalling the app already loses all pairings;
  this isn't a new category of data loss, just an earlier trigger for the same one).
- Hardening the relay's alias map against two different Monitors independently landing
  on the same rotating code at the same moment. This possibility already exists
  unaddressed in today's shipped room-name model (two Monitors could already collide on
  the same six-digit room); this spec neither introduces nor fixes that.

## Design

### Two identities where there was one

The pairing code currently conflates two different things. This design splits them:

- **`monitorRoomId`** — new. A persistent, unguessable identifier (128-bit random hex,
  generated the same way as the Parent-side `deviceId` in `src/domain/deviceId.ts`),
  stored once per Monitor install (`SETTINGS_KEYS.monitorRoomId`, new key), never shown
  to a user. This is the actual relay room the Monitor's `MonitorSession` stays
  connected to for as long as it's running — every real WebRTC peer connection, for
  every listener, happens here. Because it's never displayed, it isn't something a
  shoulder-surfer or a brute-forcer can ever see or guess at any practical rate.
- **The six-digit code** stops being a room name. It becomes a short-lived *alias* —
  purely a way for a brand-new device to discover `monitorRoomId` — with its own TTL,
  independent of the room's.

### Relay protocol changes (`signal-server`)

One new client→server message, sent only by a Monitor, after it has already joined its
own room:

```
{ type: "set-alias", alias: string }
```

The relay maintains a second map, `Map<alias, roomId>`, alongside its existing
`Map<roomName, Room>`. Registering an alias arms a TTL timer for it
(`aliasTtlMs`, a new `SignalingServerOptions` field — default 60,000ms, same shape and
`.unref()` treatment as the existing `roomTtlMs`); the alias is removed when the timer
fires. Calling `set-alias` again with a different value doesn't need to explicitly clear
the old one — it just ages out on its own timer, exactly like a room's TTL does today.

`join` resolution changes for a `role: "parent"` join only: if `room` doesn't match an
existing `Room` directly, but does match a live alias, resolve it to that alias's
`roomId` before doing anything else — from that point on, the join proceeds exactly as
it does today (identical to a direct join on that room name). If `room` matches neither
a real room nor a live alias, today's exact behavior applies: an empty room is created,
the lone Parent sits in it until the room's own TTL closes it — indistinguishable from
"wrong or expired code," which is the correct failure mode (no information leak about
whether a code ever existed).

The `joined` ack for a `parent` join gains a field reporting the *actual* room the
Parent ended up in:

```
{ type: "joined", role: "parent", room: string }
```

This is populated whether or not `room` on the way in was an alias — a Parent always
learns the real `monitorRoomId` from its very first successful join, regardless of
whether it arrived via a fresh scan or (after this design ships) a direct reconnect
using an already-known `monitorRoomId`. The Parent persists this value and never sends
the rotating code again after this point.

**On authorization, not discoverability:** knowing `monitorRoomId` does not, by itself,
grant access — the existing `decideListener`/`isListenerAuthorized`/`InviteMode` checks
inside `MonitorSession.handlePeerJoined` still gate every actual peer connection, and
they don't care which room-name path (alias or direct) a `peer-joined` arrived through.
The alias mechanism controls *how a device finds the room*; it was never the thing
standing between a stranger and a live audio stream — the authorization check has always
been that, and stays that, unchanged by this design.

### Monitor-side behavior

`MonitorSession`'s `openLocalInvite()` is replaced by `rearmInvite(): void` — generates a
fresh six-digit code (reusing `generatePairingCode()`), sends `set-alias`, adds
`'local'` to the existing `InviteMode` holder set (unchanged from the prior spec), and
starts a client-side 60-second timer. `closeLocalInvite()` is unchanged — the Monitor
screen still calls it on unmount, immediately removing `'local'` from the holder set
regardless of where the 60-second timer happened to be.

On the `rearmInvite()` timer elapsing (not on unmount — that's `closeLocalInvite()`,
above): removes `'local'` from the holder set (same effect as the screen unmounting) and
clears the current code. The *relay's* `aliasTtlMs` is the actual security boundary;
this client-side timer exists so the UI reflects reality at (approximately) the same
moment, not so it can be relied on by itself — a client that never hears its own timer
fire (backgrounded, killed) is still cut off by the relay's independent TTL.

`MonitorSessionEvents` gains `onInviteCodeChange?: (code: string | null, expiresAt:
number | null) => void`, alongside the existing (unchanged) `onListenerCountChange` —
these are two independent facts, per the UI section below, not a replacement of one by
the other. `code` is `null` whenever no local or remote invite is currently active.

`Monitor.tsx` UI, driven by two independent facts — is an invite window currently open,
and how many listeners are connected — rather than one combined state as today:

- **Window open, 0 listeners:** QR + code + a countdown ("expires in 45s"). Same layout
  as today otherwise.
- **Window open, ≥1 listener:** a prominent "● Connected — N listening" banner at the
  top of the screen (replacing today's small `bodySmall` status line); QR/code demoted
  below it, still counting down.
- **Window closed:** QR/code replaced entirely by "Pairing closed" and a "Show pairing
  code" button that calls `rearmInvite()`. The listener-count banner, if any listeners
  are connected, is unaffected by this — already-connected listeners have nothing to do
  with whether the invite window is currently open.

`SETTINGS_KEYS.monitorPairingCode` is removed — nothing about the rotating code should
survive a restart; a fresh Monitor session always starts with the window closed and
requires an explicit tap, same as reopening the screen after the window lapsed.

`MonitorAdvertiser`'s mDNS publish/unpublish (local-network discovery, UX sugar per
`AGENTS.md`) re-publishes under the new code on each rotation — mechanically the same
unpublish-old/publish-new pattern the screen's mount/unmount effect already does today,
just triggered by `onInviteCodeChange` instead of mount/unmount alone.

### Parent-side behavior

**First-time pairing** (`AddMonitor.tsx`): unchanged at the point of scanning/typing —
the user still reads/scans the current six-digit code. `pairWith()` still persists a
`PairedMonitor` immediately (so it shows up on Home right away, matching today's UX),
but `id` is now generated independently (not `= code`) since the code is no longer
durable. `ParentSession.start()` joins using the scanned code as `room`; once the
`joined` ack reports the real `room`, `Parent.tsx` updates the stored record's `roomId`
field. A device that's scanned but ultimately rejected (invite window closed by the time
it actually authorizes, race with another device, etc.) still has a `PairedMonitor`
record with the real `roomId` already filled in — meaning a later invite (from the
Monitor's own screen or an already-connected Parent) needs no rescanning, it just
reconnects and gets authorized then.

**Every subsequent connection** — reconnects, and the always-been-working "keep
listening across screen-off/restart" case — uses the stored `roomId` directly as
`ParentSession`'s room. The rotating code is never read or sent again after the first
successful `joined` ack.

**"Invite a listener"** changes shape: a Parent no longer has a code of its own to show.
Tapping the button still sends `{ inviteMode: "open" }` as today, but the Monitor
responds with a new signal payload, `{ inviteCode: string }` (routed `to:` the
requesting Parent's `deviceId`), carrying whatever code is currently live — generating
one via the same `rearmInvite()` path if none was already active. `Parent.tsx` displays
whatever it's told; it never generates a code itself. Turning "Stop inviting" off closes
that Parent's own holder in the `InviteMode` set, same as today — the code's lifetime is
entirely Monitor-owned and independent of which holder(s) are currently open.

### Storage changes

- `PairedMonitor.lastPairingCode: string` → `PairedMonitor.roomId: string` — same
  column-per-field `SqliteStore`/`storeContract` pattern, renamed and repurposed (a
  stable connection target instead of a stable-in-practice-but-not-in-design six-digit
  value).
- `PairedMonitor.id` in `AddMonitor.tsx` changes from `id: code` to a freshly generated
  value (implementation detail for the plan: could reuse `deviceId.ts`'s generator under
  a neutral name, or a small dedicated one — not pinned down further here).
- New `SETTINGS_KEYS.monitorRoomId` + a helper mirroring `getOrCreateDeviceId`'s exact
  shape (generate once, persist, reuse forever).
- `SETTINGS_KEYS.monitorPairingCode` removed (see "Monitor-side behavior").

## Testing strategy

- `signal-server`: extend the existing `TestClient`-based suite with alias registration,
  resolution (a parent joining via a live alias lands in the aliased room, gets the real
  `room` back in its `joined` ack), alias TTL expiry (mirroring the existing room-TTL
  test pattern), and a join with a stale/unknown alias behaving identically to today's
  "wrong code" case.
- `src/domain`: nothing new here beyond what 2026-09-24's plan already added — this
  design's alias/rotation logic lives in `MonitorSession`/`Monitor.tsx`
  (native-WebRTC-dependent, this project's existing untested-by-design layer) and
  `signal-server` (which does have coverage). No new pure/testable domain logic is
  introduced by this spec specifically.
- Manual, on real devices: the existing 2026-09-24 manual checklist, plus explicitly
  verifying: the window auto-closes at ~60s with no listener connected; a device that
  authorizes right at the edge of the window isn't disconnected by the window closing a
  moment later (the window only gates *new* joins, never an already-established peer
  connection); re-arming produces a visibly different code each time; an
  already-authorized Parent reconnects with the window closed and no code visible
  anywhere.

## Migration

None — see "Non-goals."
