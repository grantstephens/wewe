import { decideListener, InviteMode } from './inviteMode';

describe('InviteMode', () => {
  test('closed with no holders', () => {
    expect(new InviteMode().isOpen).toBe(false);
  });

  test('opening one holder opens it', () => {
    const mode = new InviteMode();
    mode.open('local');
    expect(mode.isOpen).toBe(true);
  });

  test('closing the only holder closes it', () => {
    const mode = new InviteMode();
    mode.open('local');
    mode.close('local');
    expect(mode.isOpen).toBe(false);
  });

  test('one holder closing does not close another still-open holder', () => {
    const mode = new InviteMode();
    mode.open('local');
    mode.open('dev-1');
    mode.close('local');
    expect(mode.isOpen).toBe(true);
    mode.close('dev-1');
    expect(mode.isOpen).toBe(false);
  });

  test('closing a holder that was never open is a no-op, not an error', () => {
    const mode = new InviteMode();
    expect(() => mode.close('dev-1')).not.toThrow();
    expect(mode.isOpen).toBe(false);
  });

  test('opening the same holder twice does not require closing it twice', () => {
    const mode = new InviteMode();
    mode.open('dev-1');
    mode.open('dev-1');
    mode.close('dev-1');
    expect(mode.isOpen).toBe(false);
  });
});

describe('decideListener', () => {
  test('an already-authorized device is accepted regardless of invite mode', () => {
    expect(decideListener(true, false)).toBe('accept-known');
    expect(decideListener(true, true)).toBe('accept-known');
  });

  test('an unauthorized device is accepted-as-new only while invite mode is open', () => {
    expect(decideListener(false, true)).toBe('accept-new');
  });

  test('an unauthorized device is rejected while invite mode is closed', () => {
    expect(decideListener(false, false)).toBe('reject');
  });
});
