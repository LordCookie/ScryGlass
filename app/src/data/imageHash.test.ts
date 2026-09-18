import { describe, it, expect } from 'vitest';
import { packBitsMsb, bytesToHex, hexToBytes, hammingHex } from './imageHash';

// Diese Werte MÜSSEN zur Python-Pipeline passen (pipeline/hash_images.py:bits_to_hex).
describe('packBitsMsb (bit-identisch zur Pipeline)', () => {
  it('packt MSB zuerst', () => {
    expect(packBitsMsb([1, 0, 0, 0, 0, 0, 0, 0])).toBe('80');
    expect(packBitsMsb([1, 1, 1, 1, 1, 1, 1, 1])).toBe('ff');
    expect(packBitsMsb([0, 0, 0, 0, 0, 0, 0, 0])).toBe('00');
    expect(packBitsMsb([1, 0, 1, 0, 1, 0, 1, 0])).toBe('aa');
  });
  it('mehrere Bytes', () => {
    expect(packBitsMsb([1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1])).toBe('80ff');
  });
});

describe('hex round-trip', () => {
  it('bytesToHex / hexToBytes', () => {
    const b = new Uint8Array([0x00, 0x80, 0xff, 0xaa]);
    expect(bytesToHex(b)).toBe('0080ffaa');
    expect([...hexToBytes('0080ffaa')]).toEqual([0, 128, 255, 170]);
  });
});

describe('hammingHex', () => {
  it('zählt unterschiedliche Bits', () => {
    expect(hammingHex('00', '00')).toBe(0);
    expect(hammingHex('00', '80')).toBe(1);
    expect(hammingHex('00', 'ff')).toBe(8);
    expect(hammingHex('aa', '55')).toBe(8); // komplett invers
    expect(hammingHex('aa', '00')).toBe(4);
  });
});
