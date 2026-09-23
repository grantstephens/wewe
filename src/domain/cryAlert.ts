/**
 * CryAlertClassifier decides, on the Parent side and only while `NoiseGate`
 * has audio actually streaming, whether the current sound is worth
 * interrupting the parent for (vibration/notification/sound) versus just
 * appearing in the activity log. Deliberately kept separate from
 * `NoiseGate` and running on the Parent, not the monitor: alert sensitivity
 * is then a setting a parent can tune (or a future ML classifier can
 * replace) without re-flashing ESP32 firmware.
 *
 * Two independent triggers, either one fires the alert exactly once per
 * continuous "gate open" period:
 *  - `instantAlertDb`: a single sample this loud alerts immediately — a
 *    startle cry's onset is loud from the first instant.
 *  - `sustainedAlertMs`: audio that stays open this long without ever
 *    getting that loud still alerts — many cries build gradually, and most
 *    non-baby noises (a door, a passing car) are brief.
 */
export interface CryAlertOptions {
  sustainedAlertMs: number;
  instantAlertDb: number;
}

export const DEFAULT_CRY_ALERT_OPTIONS: CryAlertOptions = {
  sustainedAlertMs: 4000,
  instantAlertDb: -18,
};

export class CryAlertClassifier {
  private readonly options: CryAlertOptions;
  private openSinceMs: number | null = null;
  private alerted = false;

  constructor(options: Partial<CryAlertOptions> = {}) {
    this.options = { ...DEFAULT_CRY_ALERT_OPTIONS, ...options };
  }

  /** Call once per level sample while the noise gate is open. Returns true the one time this open period should alert. */
  push(levelDb: number, timestampMs: number): boolean {
    if (this.openSinceMs == null) this.openSinceMs = timestampMs;
    if (this.alerted) return false;

    const sustained = timestampMs - this.openSinceMs >= this.options.sustainedAlertMs;
    const instant = levelDb >= this.options.instantAlertDb;
    if (sustained || instant) {
      this.alerted = true;
      return true;
    }
    return false;
  }

  /** Call when the noise gate closes, so the next open period is judged fresh. */
  reset(): void {
    this.openSinceMs = null;
    this.alerted = false;
  }
}
