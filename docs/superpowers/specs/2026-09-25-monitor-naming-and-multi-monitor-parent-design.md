# Monitor naming + simultaneous multi-monitor Parent sessions

**Date:** 2026-09-25
**Status:** Approved, pending implementation plan

## Problem

Two related gaps in how a Parent relates to the monitor(s) it watches:

1. **Monitors have no identity of their own.** A `PairedMonitor.label` exists (a
   Parent can already rename one, per today's Home screen), but a freshly-paired
   monitor has no name at all until a Parent bothers to set one, and the Monitor
   device itself has no notion of "what I'm called" — nothing to show if, say, a
   second Parent phone pairs to the same Monitor and never gets told what the first
   Parent named it.
2. **A Parent can only ever watch one Monitor at a time.** `ParentSession` is
   created and torn down by `Parent.tsx`'s own mount/unmount effect, scoped to
   whichever `monitorId` route param that screen instance was given. Pairing a
   second monitor and opening its screen disconnects the first — there is no way to
   listen to two nurseries at once, which is a real, ordinary use case (twins,
   siblings in separate rooms) this app doesn't yet support.

## Goals

- Every Monitor has a name from the moment it starts running — auto-generated,
  never blank.
- That name is editable from either side (the Monitor's own screen, or any
  Parent that's currently connected to it), and an edit from either side
  propagates to the other and to every other currently-connected Parent.
- A Parent can be connected to every monitor it has ever paired with,
  simultaneously, with live audio from all of them at once (mixed, each still
  gated independently by its own Monitor's `NoiseGate`) — not one-at-a-time.
- Connections persist across navigation: opening a second monitor's screen must
  not disconnect the first, and leaving a monitor's screen must not disconnect it
  either.
- Cry/noise alerts and the activity log stay scoped per-monitor, exactly as
  today — a cry heard on Monitor B must never be attributed to Monitor A.
- The existing, hard-won foreground-service correctness (only ever requesting a
  `MICROPHONE`-type service while genuinely, currently recording — see
  `AGENTS.md`'s two logged real-device crashes) must not regress now that
  multiple sessions can be simultaneously active and only one of them might be
  mid-push-to-talk at any moment.

## Non-goals

- Any server-side (relay) change. Naming is carried entirely over the existing
  opaque `signal` channel, exactly like `rejected`/`inviteMode`/`inviteCode` —
  the relay does not need to understand it.
- A cap on how many monitors one Parent can watch simultaneously. Whatever the
  device can sustain, it sustains; no artificial limit is introduced.
- Any change to how a *Monitor* device relates to its own multiple simultaneous
  *listeners* — that's the already-shipped multi-listener/invite-gated-pairing
  design. This spec is about a Parent watching multiple Monitors, the opposite
  direction.
- Renaming while genuinely offline. If the targeted session isn't currently
  connected, the rename control is disabled rather than queued — see "Monitor
  naming" below for why.

## Design

### Monitor naming

A Monitor generates a name once per install (`generateMonitorName()`, a new pure
`src/domain` module — adjective+animal, e.g. "raring-rabbit," same
injectable-RNG pattern as `generatePairingCode`/`generateDeviceId`), persisted
under a new `SETTINGS_KEYS.monitorName`, loaded via `getOrCreateMonitorName(store)`
mirroring `getOrCreateMonitorRoomId`'s exact shape.

Two new application-level signal payloads, carried over the existing opaque
channel (no relay changes):

- `{ monitorName: string }` — Monitor → a Parent. Sent to a newly-accepted peer
  right after the authorization decision (before the SDP offer, so the name
  arrives promptly), and re-broadcast to **every currently-connected peer**
  (not just invite-mode holders — every Parent who's listening should know the
  name) whenever it changes.
- `{ setMonitorName: string }` — Parent → Monitor, a rename request. Honored
  only from a peer the Monitor already has an active `RTCPeerConnection` for
  (same "already-connected, thus already-authorized" guard the existing
  `inviteMode` signal uses) — an unauthorized deviceId can't rename a Monitor
  it was never let into.

`MonitorSession` gains `renameSelf(name: string): void` (updates its own
persisted name, then broadcasts) used both by the Monitor's own screen and,
internally, by the handler for an incoming `setMonitorName` request — a rename
from either origin ends up going through the exact same code path, which is
what makes it "the same rename," not two parallel mechanisms that could
disagree.

`ParentSession` gains `onMonitorNameChanged?: (name: string) => void` and
`renameMonitor(name: string): void` (sends `setMonitorName`). Renaming is only
offered in the UI while that Parent's session is actually connected — there's
no reliable way to queue a rename against a Monitor that might itself be
renamed by someone else in the meantime, and every Monitor is expected to be
reachable most of the time under the new always-on connection model below, so
this isn't a meaningful UX loss.

### Simultaneous multi-monitor sessions

**Session ownership moves out of the `Parent` screen.** A new
`ParentSessionsProvider` (sibling to `WeweContext`, mounted alongside it in
`App.tsx`) owns one `ParentSession` per paired monitor for the lifetime of the
app:

- On the store becoming ready (and whenever `WeweContext`'s `revision` changes,
  the same signal Home's monitor list already reacts to), diffs the current
  `store.monitors()` list against its own live session map: a newly-paired
  monitor gets a session created and started; a removed one gets its session
  stopped and dropped.
- Every session shares the same `deviceId` (`getOrCreateDeviceId(store)`,
  called once) — this device presents the same identity to every Monitor it
  talks to, which is already how `ParentSession` works today, just now
  exercised against several Monitors instead of one.
- Runs each session's `CryAlertClassifier` polling centrally (moved out of
  `Parent.tsx`'s effect) so alerts and activity-log entries keep firing for a
  monitor whose screen isn't currently open — each classifier instance stays
  scoped to its own `monitorId`, per the Goals section.
- Owns the **single, shared** foreground-service notification
  (`startForegroundSession`/`stopForegroundSession` already display/update one
  notification, not one per call — see `foregroundService.ts`). Recomputes the
  full `types` array from the union of "at least one session is active"
  (`MEDIA_PLAYBACK`) and "at least one session currently has push-to-talk
  active" (`MICROPHONE`) on every relevant state change, and always passes the
  complete recomputed set — never an incremental add, since `notifee` doesn't
  merge types across calls and doing this piecemeal is exactly the bug class
  that produced two real-device crashes already (`AGENTS.md`). This means
  **`Parent.tsx` no longer calls `startForegroundSession` directly** —
  push-to-talk goes through `manager.startTalking(monitorId)`/
  `stopTalking(monitorId)`, which wrap the underlying `ParentSession` calls and
  recompute the notification as one operation, so the two can never race
  against each other. The service starts once the paired-monitor list is
  non-empty and stops once it's empty.
- Exposes reactive per-monitor state (`connectionState`, `rejected`,
  `talking`, the Monitor's current name) plus `getSession(monitorId)` for the
  one call that stays directly on `ParentSession` (`setInviteMode`) — not
  `startTalking`/`stopTalking`, which go through the manager as above.
- Also exposes its own `renameMonitor(monitorId, label): void`, distinct from
  `ParentSession.renameMonitor(name)`: it does the optimistic local
  `store.addMonitor` label write *and* calls the session's own
  `renameMonitor` if connected, reusing the same "sync a name into the store"
  logic the manager already needs for the reverse direction — a Monitor-
  initiated rename arriving via `onMonitorNameChanged` with no Parent-side
  action involved at all. `Home.tsx` calls this manager-level method, not the
  session directly.

**`Home.tsx` becomes a live dashboard.** Each row shows that monitor's current
status (from the manager) instead of the static "Tap to view" — connected /
connecting / not authorized — alongside the existing rename/remove actions.
Rename now calls through the manager (optimistic local `store.addMonitor`
label update, plus `session.renameMonitor(...)` if currently connected)
instead of writing to the store directly.

**`Parent.tsx` becomes a detail view.** On mount it reads the *already-running*
session's state for its `monitorId` from the manager instead of creating one;
its former connect effect, connect-timeout watchdog, and cry-alert polling are
removed entirely (all now live in the manager) — this screen becomes close to
a pure view over shared state plus the three actions that stay
screen/session-specific: push-to-talk (via the manager, see above),
invite-a-listener, and rename (both via `getSession(monitorId)` directly).
Leaving the screen no longer stops anything.

The connect-timeout watchdog's meaning changes slightly as a consequence:
today it measures time-since-this-screen-mounted; once sessions are
app-lifetime-owned, it has to measure time-since-this-session-started-trying
instead (tracked once, by the manager, not restarted every time a Parent
happens to navigate into an already-long-unreachable monitor's screen) — the
manager tracks each session's connect-attempt start time as part of its
reactive state.

## Testing strategy

- `src/domain/monitorName.ts`: pure, fully testable — deterministic output
  under an injected RNG, same test shape as `pairing.test.ts`/`deviceId.test.ts`.
- `getOrCreateMonitorName`: same contract-style tests as
  `getOrCreateMonitorRoomId`.
- `peerConnectionHelpers.ts`'s two new guards: no dedicated suite, same
  established posture as the existing guards in this file.
- `MonitorSession`/`ParentSession`/`ParentSessionsProvider`: no automated test
  for the WebRTC-dependent classes, same established posture as
  `MonitorSession`/`ParentSession` today (native `RTCPeerConnection`,
  no mock in this project's Jest config) — verified by typecheck plus a
  manual, real-device, two-simultaneous-monitor test: confirm both connect and
  play mixed audio at once, confirm a cry on one logs only against that one,
  confirm push-to-talk on one doesn't touch the other's foreground-service
  type or audio, confirm renaming from a Monitor's own screen updates a
  connected Parent's Home row live, confirm renaming from a Parent updates the
  Monitor's own screen and any *other* connected Parent, confirm the rename
  control is disabled/absent while a given session isn't connected.
- `Home.tsx`/`Parent.tsx`: existing screen-test conventions (`await
  render`/`await fireEvent`) apply to whatever of the new dashboard/detail-view
  logic is reasonably mockable against a fake manager context — exact coverage
  is a plan-time decision, not pinned down further here.

## Migration

None needed for the naming feature — `monitorName` is a new setting with a
sensible generated default, and existing `PairedMonitor.label` values are
untouched (a Parent's existing custom label stays exactly as it is until the
next rename from either side). The multi-monitor session change has no data
migration at all; it changes how already-existing `PairedMonitor` records are
*used* at runtime, not their shape.
