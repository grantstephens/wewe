import { shouldFireDisconnectBeep } from './disconnectBeep';

describe('shouldFireDisconnectBeep', () => {
  it('stays silent before the threshold elapses', () => {
    expect(shouldFireDisconnectBeep(1_000, null, 1_000 + 14_999, 15_000, 15_000)).toBe(false);
  });

  it('fires the first time right at the threshold', () => {
    expect(shouldFireDisconnectBeep(1_000, null, 1_000 + 15_000, 15_000, 15_000)).toBe(true);
  });

  it('does not fire again before the repeat interval elapses', () => {
    const lastBeepAtMs = 1_000 + 15_000;
    expect(shouldFireDisconnectBeep(1_000, lastBeepAtMs, lastBeepAtMs + 14_999, 15_000, 15_000)).toBe(false);
  });

  it('fires again once the repeat interval elapses', () => {
    const lastBeepAtMs = 1_000 + 15_000;
    expect(shouldFireDisconnectBeep(1_000, lastBeepAtMs, lastBeepAtMs + 15_000, 15_000, 15_000)).toBe(true);
  });
});
