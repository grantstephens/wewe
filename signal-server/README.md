# wewe-signal-server

A stateless WebRTC signaling relay: two peers (a "monitor" and a "parent")
holding the same pairing code join a room and exchange SDP/ICE blobs through
it. Once ICE completes, media flows peer-to-peer (or through whatever
STUN-derived path ICE found) — this process never sees audio, only small
JSON signaling messages, and keeps no state beyond currently-open rooms in
memory.

Self-hostable: `npm install && npm run build && npm start`, `docker compose up -d`
(see `docker-compose.yml`), or point the app's Settings screen at any instance running
this. The app defaults to `wss://api.wewe.hub13.xyz` (this project's own convenience
instance, see `src/domain/store.ts`'s `DEFAULT_SIGNALING_SERVER_URL`) so it works out of
the box, but Settings always lets you override it — run your own or point at one
someone you trust runs instead.

## Wire protocol

One WebSocket connection per client. Every message is a JSON object with a
`type` field.

**Client → server**

- `{ type: "join", room: string, role: "monitor" | "parent" }` — must be the
  first message. `room` is the pairing code (or any shared secret both ends
  agree on out of band).
- `{ type: "signal", payload: unknown }` — forwarded verbatim to the other
  peer in the room, once both are joined. `payload` is whatever
  `RTCSessionDescriptionInit`/`RTCIceCandidateInit` (or a small wrapper
  around one) the WebRTC layer produces; this server never inspects it.

**Server → client**

- `{ type: "joined", role }` — acknowledges a successful `join`.
- `{ type: "peer-joined" }` — the other role in the room is now connected;
  safe to start sending `signal` messages.
- `{ type: "peer-left" }` — the other role disconnected.
- `{ type: "signal", payload }` — a `signal` message relayed from the other peer.
- `{ type: "error", message }` — the connection is about to close (see
  `message` for why: `"role-taken"`, `"must-join-first"`, `"invalid-message"`,
  `"room-expired"`, `"rate-limited"`).

A room holds at most one `monitor` and one `parent`. A second socket trying
to take an already-occupied role is rejected with `role-taken`.

## Hardening

Pairing codes are six digits (one million possibilities) reused directly as
the room name, so two things bound how much that's worth to an attacker:

- **Room TTL** (`roomTtlMs`, default 5 minutes): a room holding exactly one
  peer for longer than this is closed and forgotten — a guessed room can't
  be camped on indefinitely waiting for the real second peer never to show
  up to it instead.
- **Per-IP join rate limit** (`rateLimitMax`/`rateLimitWindowMs`, default 20
  attempts/minute): further `join` attempts from an address that exceeds its
  budget are rejected with `rate-limited`, which turns exhaustively
  searching the six-digit space from instant into impractical from a single
  source.

Both are constructor options to `attachSignalingServer`, not environment
variables yet — set them in a wrapper script if you need different values in
production than the defaults in `src/server.ts`.
