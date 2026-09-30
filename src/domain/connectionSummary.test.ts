import { describeConnectionStates } from './connectionSummary';

describe('describeConnectionStates', () => {
  it('describes zero monitors', () => {
    expect(describeConnectionStates([])).toBe('No monitors paired');
  });

  it('describes one connected monitor', () => {
    expect(describeConnectionStates(['connected'])).toBe('Monitor connected');
  });

  it('describes all of several connected', () => {
    expect(describeConnectionStates(['connected', 'connected', 'connected'])).toBe('All 3 monitors connected');
  });

  it('describes a partial mix', () => {
    expect(describeConnectionStates(['connected', 'connecting', 'connected'])).toBe('2 of 3 connected');
  });

  it('describes none connected yet', () => {
    expect(describeConnectionStates(['connecting'])).toBe('Reconnecting…');
  });

  it('describes none of several connected', () => {
    expect(describeConnectionStates(['connecting', 'failed'])).toBe('Reconnecting to 2 monitors…');
  });
});
