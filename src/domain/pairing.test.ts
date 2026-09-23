import { generatePairingCode, isValidPairingCode, pairingUri, parsePairingUri } from './pairing';

describe('generatePairingCode', () => {
  it('produces six digits using the injected RNG', () => {
    const sequence = [1, 2, 3, 4, 5, 6, 7];
    let i = 0;
    const code = generatePairingCode(() => sequence[i++] % 10);
    expect(code).toBe('123456');
  });

  it('is always a valid pairing code', () => {
    expect(isValidPairingCode(generatePairingCode())).toBe(true);
  });
});

describe('isValidPairingCode', () => {
  it.each(['000000', '999999', '123456'])('accepts %s', (code) => {
    expect(isValidPairingCode(code)).toBe(true);
  });

  it.each(['12345', '1234567', 'abcdef', '12 345', ''])('rejects %s', (code) => {
    expect(isValidPairingCode(code)).toBe(false);
  });
});

describe('pairingUri / parsePairingUri', () => {
  it('round-trips a code and relay URL', () => {
    const uri = pairingUri('482913', 'wss://relay.example.com');
    expect(parsePairingUri(uri)).toEqual({ code: '482913', signalingServerUrl: 'wss://relay.example.com' });
  });

  it('round-trips a relay URL containing query parameters', () => {
    const uri = pairingUri('482913', 'wss://relay.example.com:8443/room?v=1');
    expect(parsePairingUri(uri)).toEqual({
      code: '482913',
      signalingServerUrl: 'wss://relay.example.com:8443/room?v=1',
    });
  });

  it('rejects a non-pairing URI', () => {
    expect(parsePairingUri('https://example.com')).toBeNull();
  });

  it('rejects an unparseable string', () => {
    expect(parsePairingUri('not a uri at all')).toBeNull();
  });

  it('rejects a pairing URI with an invalid code', () => {
    expect(parsePairingUri('wewe://pair?code=abc&relay=wss://relay.example.com')).toBeNull();
  });

  it('rejects a pairing URI missing the relay', () => {
    expect(parsePairingUri('wewe://pair?code=482913')).toBeNull();
  });
});
