import { describe, it, expect } from 'vitest';
import { buildPairingUrl, parsePairingUrl, generateToken, isProtocolCompatible } from './protocol';
import { PROTOCOL_VERSION } from '../version';

describe('Pairing-URL', () => {
  it('build -> parse round-trip', () => {
    const info = { host: '192.168.1.42', port: 8765, token: '123456', name: "Yaras Handy" };
    const url = buildPairingUrl(info);
    expect(url.startsWith('mtgscan://192.168.1.42:8765?')).toBe(true);
    expect(parsePairingUrl(url)).toEqual(info);
  });

  it('kodiert Sonderzeichen im Namen', () => {
    const url = buildPairingUrl({ host: '10.0.0.5', port: 8766, token: '000111', name: 'A & B' });
    expect(parsePairingUrl(url)?.name).toBe('A & B');
  });

  it('lehnt Nicht-Pairing-Codes ab', () => {
    expect(parsePairingUrl('https://example.com')).toBeNull();
    expect(parsePairingUrl('mtgscan://host-without-port?t=1')).toBeNull();
    expect(parsePairingUrl('mtgscan://1.2.3.4:8765?n=x')).toBeNull(); // ohne Token
  });
});

describe('generateToken', () => {
  it('liefert 6 Ziffern', () => {
    for (let i = 0; i < 50; i++) expect(generateToken()).toMatch(/^\d{6}$/);
  });
});

describe('isProtocolCompatible', () => {
  it('gleiche Version = kompatibel', () => {
    expect(
      isProtocolCompatible({ deviceName: 'x', catalogVersion: 'v', protocolVersion: PROTOCOL_VERSION, cardCount: 1 }),
    ).toBe(true);
    expect(
      isProtocolCompatible({ deviceName: 'x', catalogVersion: 'v', protocolVersion: PROTOCOL_VERSION + 1, cardCount: 1 }),
    ).toBe(false);
  });
});
