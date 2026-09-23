import { Backoff } from './backoff';

describe('Backoff', () => {
  it('starts at the initial delay', () => {
    const backoff = new Backoff({ initialDelayMs: 500, multiplier: 2, maxDelayMs: 30_000 });
    expect(backoff.nextDelayMs()).toBe(500);
  });

  it('grows by the multiplier each attempt', () => {
    const backoff = new Backoff({ initialDelayMs: 500, multiplier: 2, maxDelayMs: 30_000 });
    expect(backoff.nextDelayMs()).toBe(500);
    expect(backoff.nextDelayMs()).toBe(1000);
    expect(backoff.nextDelayMs()).toBe(2000);
    expect(backoff.nextDelayMs()).toBe(4000);
  });

  it('caps at maxDelayMs and stays there', () => {
    const backoff = new Backoff({ initialDelayMs: 1000, multiplier: 10, maxDelayMs: 5000 });
    expect(backoff.nextDelayMs()).toBe(1000);
    expect(backoff.nextDelayMs()).toBe(5000); // 10,000 capped
    expect(backoff.nextDelayMs()).toBe(5000);
  });

  it('reset returns the next delay to the initial value', () => {
    const backoff = new Backoff({ initialDelayMs: 500, multiplier: 2, maxDelayMs: 30_000 });
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(500);
  });
});
