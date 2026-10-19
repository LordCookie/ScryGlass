import { describe, it, expect } from 'vitest';
import { pushBack, handleBack, backDepth } from './backStack';

describe('backStack', () => {
  it('schließt die zuletzt geöffnete Ebene zuerst', () => {
    const closed: string[] = [];
    const offTab = pushBack(() => closed.push('tab'));
    const offDetail = pushBack(() => closed.push('detail'));
    expect(handleBack()).toBe(true);
    expect(closed).toEqual(['detail']);
    offDetail(); // Ebene meldet sich beim Schließen ab
    expect(handleBack()).toBe(true);
    expect(closed).toEqual(['detail', 'tab']);
    offTab();
    expect(backDepth()).toBe(0);
  });

  it('ohne offene Ebene: false (Aufrufer minimiert die App)', () => {
    expect(handleBack()).toBe(false);
  });

  it('Abmelden aus der Mitte lässt die Reihenfolge der anderen stehen', () => {
    const closed: string[] = [];
    const a = pushBack(() => closed.push('a'));
    const b = pushBack(() => closed.push('b'));
    const c = pushBack(() => closed.push('c'));
    b();
    handleBack();
    c();
    handleBack();
    a();
    expect(closed).toEqual(['c', 'a']);
    expect(backDepth()).toBe(0);
  });
});
