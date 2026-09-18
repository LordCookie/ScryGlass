import { describe, it, expect } from 'vitest';
import { NdjsonBuffer } from './ndjson';

describe('NdjsonBuffer', () => {
  it('parst ganze Zeilen', () => {
    const b = new NdjsonBuffer<{ a: number }>();
    expect(b.push('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(b.flush()).toEqual([]);
  });

  it('haelt Zeilen ueber Chunk-Grenzen zusammen', () => {
    const b = new NdjsonBuffer<{ a: number }>();
    expect(b.push('{"a":')).toEqual([]);
    expect(b.push('42}\n{"a"')).toEqual([{ a: 42 }]);
    expect(b.push(':7}')).toEqual([]);
    expect(b.flush()).toEqual([{ a: 7 }]);
  });

  it('ignoriert leere Zeilen', () => {
    const b = new NdjsonBuffer();
    expect(b.push('\n\n{"x":1}\n\n')).toEqual([{ x: 1 }]);
  });

  it('flush ohne abschliessendes newline', () => {
    const b = new NdjsonBuffer<{ n: string }>();
    expect(b.push('{"n":"a"}\n{"n":"b"}')).toEqual([{ n: 'a' }]);
    expect(b.flush()).toEqual([{ n: 'b' }]);
  });
});
