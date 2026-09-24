/**
 * Tracks who currently holds a Monitor's "invite mode" open — see
 * docs/superpowers/specs/2026-09-24-multi-listener-invite-gated-pairing-design.md.
 * Multiple holders can be open at once: the Monitor's own pairing screen
 * (holder id `'local'`), and/or any number of already-connected, authorized
 * Parents each showing their own invite screen (holder id = that Parent's
 * deviceId). Open iff at least one holder exists.
 *
 * Tracked as a Set, not a boolean, specifically so one holder closing its
 * own invite screen can never incorrectly close another holder's still-open
 * one — that would let a stranger sneak in behind whichever holder happened
 * to be first to close theirs.
 */
export class InviteMode {
  private readonly holders = new Set<string>();

  get isOpen(): boolean {
    return this.holders.size > 0;
  }

  open(holder: string): void {
    this.holders.add(holder);
  }

  close(holder: string): void {
    this.holders.delete(holder);
  }
}

export type ListenerDecision = 'accept-known' | 'accept-new' | 'reject';

/**
 * Decides what MonitorSession should do with a newly-joined peer.
 * 'accept-new' means both "let it in" and "remember it as authorized from
 * now on" — MonitorSession is responsible for actually persisting that via
 * Store.authorizeListener, this function only decides.
 */
export function decideListener(isAuthorized: boolean, inviteModeOpen: boolean): ListenerDecision {
  if (isAuthorized) return 'accept-known';
  if (inviteModeOpen) return 'accept-new';
  return 'reject';
}
