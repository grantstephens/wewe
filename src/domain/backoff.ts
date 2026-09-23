/**
 * Backoff computes retry delays for the signaling client's reconnect loop:
 * exponential growth capped at a maximum, so a dropped connection retries
 * quickly at first (a brief WiFi blip recovers almost immediately) without
 * hammering the relay if it's actually down for a while.
 */
export interface BackoffOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  multiplier: 2,
};

export class Backoff {
  private readonly options: BackoffOptions;
  private attempt = 0;

  constructor(options: Partial<BackoffOptions> = {}) {
    this.options = { ...DEFAULT_BACKOFF_OPTIONS, ...options };
  }

  /** Returns the delay for the next retry and advances the attempt counter. */
  nextDelayMs(): number {
    const delay = Math.min(
      this.options.initialDelayMs * this.options.multiplier ** this.attempt,
      this.options.maxDelayMs,
    );
    this.attempt += 1;
    return delay;
  }

  /** Call once a connection succeeds, so the next failure starts from the initial delay again. */
  reset(): void {
    this.attempt = 0;
  }
}
