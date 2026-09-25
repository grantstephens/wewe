/**
 * NoiseGate decides, from a live stream of mic level readings, whether the
 * monitor should currently be streaming audio at all. This is the mechanism
 * behind "only send audio when noise is detected": the monitor (phone or
 * ESP32) runs this locally and only keeps its WebRTC audio track live while
 * `isOpen` is true, so quiet nursery time costs no bandwidth or battery.
 *
 * The noise floor is adaptive — the same "no need to configure sensitivity"
 * property Dormi advertises — via an exponential moving average of *quiet*
 * samples only. Critically, the floor's EMA never adapts while the gate is
 * open: if it tracked the level during a loud, sustained cry, the floor
 * would rise to meet the cry and the gate would decide the room had simply
 * gotten louder, masking the exact event it exists to catch. This mirrors
 * DriveWell's SmoothnessEngine keeping its liveness EMA off the filtered
 * signal it's trying to protect from self-masking.
 *
 * `closeHoldMs` hysteresis stops a gate from chattering open/closed on brief
 * dips inside one continuous cry (breaths between wails, for example).
 *
 * Separately, a *stationary noise* classifier runs only while the gate is
 * open: a white-noise machine or fan starts abruptly loud enough to open
 * the gate (an actual cry looks identical for the first instant), but
 * unlike a cry, its level never varies. If the level's range stays within
 * `stationaryRangeDb` for a continuous `stationaryHoldMs`, the sound is
 * judged to be constant background noise rather than an event: the floor is
 * snapped up to that level in one jump (not the slow EMA) and the gate
 * closes, so the room plays through briefly and then goes quiet on the
 * stream. This doesn't reintroduce the masking bug the EMA-freeze exists to
 * prevent — it fires only after a long, unbroken window of near-zero
 * variation, and any dip (a breath between wails) or swing wider than
 * `stationaryRangeDb` resets the window, so a modulating cry never
 * qualifies no matter how long it lasts.
 */
export interface NoiseGateOptions {
  /** dB above the adaptive floor a sample must reach to open the gate. */
  openMarginDb: number;
  /** Time constant (ms) of the noise-floor EMA — how fast it tracks ambient quiet. */
  floorTimeConstantMs: number;
  /** Continuous quiet duration (ms) required before an open gate closes again. */
  closeHoldMs: number;
  /** Noise floor (dBFS) assumed before any quiet sample has been observed. */
  initialFloorDb: number;
  /** Continuous duration (ms), while open, that the level must hold within `stationaryRangeDb` before it's classified as constant background noise. */
  stationaryHoldMs: number;
  /** Max level swing (dB) allowed within the current streak for it to still count as stationary. */
  stationaryRangeDb: number;
}

export const DEFAULT_NOISE_GATE_OPTIONS: NoiseGateOptions = {
  openMarginDb: 12,
  floorTimeConstantMs: 5000,
  closeHoldMs: 3000,
  initialFloorDb: -50,
  stationaryHoldMs: 15000,
  stationaryRangeDb: 3,
};

export class NoiseGate {
  private readonly options: NoiseGateOptions;
  private floorDb: number;
  private openState = false;
  private lastActiveAtMs: number | null = null;
  private lastSampleAtMs: number | null = null;
  private stationaryMinDb: number | null = null;
  private stationaryMaxDb: number | null = null;
  private stationaryStartMs: number | null = null;

  constructor(options: Partial<NoiseGateOptions> = {}) {
    this.options = { ...DEFAULT_NOISE_GATE_OPTIONS, ...options };
    this.floorDb = this.options.initialFloorDb;
  }

  /** Feeds one level reading (dBFS) at `timestampMs` (epoch ms); returns the gate's state after it. */
  push(levelDb: number, timestampMs: number): boolean {
    const dtMs = this.lastSampleAtMs == null ? 0 : Math.max(0, timestampMs - this.lastSampleAtMs);
    this.lastSampleAtMs = timestampMs;

    const isActive = levelDb >= this.floorDb + this.options.openMarginDb;

    if (isActive) {
      this.lastActiveAtMs = timestampMs;
      this.openState = true;

      if (this.stationaryStartMs === null) {
        this.stationaryMinDb = levelDb;
        this.stationaryMaxDb = levelDb;
        this.stationaryStartMs = timestampMs;
      } else {
        const proposedMin = Math.min(this.stationaryMinDb!, levelDb);
        const proposedMax = Math.max(this.stationaryMaxDb!, levelDb);
        if (proposedMax - proposedMin <= this.options.stationaryRangeDb) {
          this.stationaryMinDb = proposedMin;
          this.stationaryMaxDb = proposedMax;
        } else {
          this.stationaryMinDb = levelDb;
          this.stationaryMaxDb = levelDb;
          this.stationaryStartMs = timestampMs;
        }
      }

      if (timestampMs - this.stationaryStartMs >= this.options.stationaryHoldMs) {
        this.floorDb = (this.stationaryMinDb! + this.stationaryMaxDb!) / 2;
        this.openState = false;
        this.stationaryMinDb = null;
        this.stationaryMaxDb = null;
        this.stationaryStartMs = null;
      }

      return this.openState;
    }

    // Any dip below floor + margin is direct evidence the sound isn't
    // constant, so it always resets the stationary streak — even a brief
    // one that closeHoldMs hysteresis papers over for the gate itself.
    this.stationaryMinDb = null;
    this.stationaryMaxDb = null;
    this.stationaryStartMs = null;

    // Only a quiet sample, and only while the gate is closed, moves the floor.
    if (!this.openState && dtMs > 0) {
      const alpha = 1 - Math.exp(-dtMs / this.options.floorTimeConstantMs);
      this.floorDb += (levelDb - this.floorDb) * alpha;
    }

    if (this.openState && this.lastActiveAtMs != null && timestampMs - this.lastActiveAtMs >= this.options.closeHoldMs) {
      this.openState = false;
    }

    return this.openState;
  }

  get isOpen(): boolean {
    return this.openState;
  }

  get noiseFloorDb(): number {
    return this.floorDb;
  }
}
