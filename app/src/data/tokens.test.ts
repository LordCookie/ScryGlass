import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { getTokenCount, addTokens, setTokenCount } from './tokens';

describe('Token-Zähler', () => {
  it('zählt hoch und runter, nie unter 0', async () => {
    await setTokenCount(0);
    expect(await getTokenCount()).toBe(0);
    expect(await addTokens(1)).toBe(1);
    expect(await addTokens(2)).toBe(3);
    expect(await addTokens(-5)).toBe(0);
    await setTokenCount(12.7);
    expect(await getTokenCount()).toBe(12);
  });
});
