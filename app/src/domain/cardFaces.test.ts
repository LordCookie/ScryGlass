import { describe, it, expect } from 'vitest';
import { isDoubleFaced } from './cardFaces';

describe('isDoubleFaced', () => {
  it('erkennt Karten mit echter Rückseite', () => {
    expect(isDoubleFaced('transform')).toBe(true);
    expect(isDoubleFaced('modal_dfc')).toBe(true);
    expect(isDoubleFaced('reversible_card')).toBe(true);
  });

  it('behandelt Ein-Bild-Layouts als einseitig', () => {
    for (const l of ['normal', 'split', 'adventure', 'flip', 'meld', 'saga']) {
      expect(isDoubleFaced(l)).toBe(false);
    }
    expect(isDoubleFaced(undefined)).toBe(false);
  });
});
