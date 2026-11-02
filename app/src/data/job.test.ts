import { describe, it, expect } from 'vitest';
import { Job } from './job';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Job (Hintergrund-Aufgabe, M15)', () => {
  it('meldet Schritte und das Ergebnis; Zuhörer werden benachrichtigt', async () => {
    const job = new Job<number, string>();
    let calls = 0;
    const off = job.subscribe(() => calls++);
    const d = deferred<string>();
    const run = job.run(async (onStep) => {
      onStep(1);
      onStep(2);
      return d.promise;
    });
    expect(job.get()).toMatchObject({ running: true, step: 2 });
    d.resolve('fertig');
    await run;
    expect(job.get()).toEqual({ running: false, step: null, result: 'fertig', error: null });
    expect(calls).toBe(4); // Start, 2 Schritte, Ende
    off();
  });

  it('ein zweiter Start schließt sich der laufenden Runde an, statt sie zu verdoppeln', async () => {
    const job = new Job<never, number>();
    const d = deferred<number>();
    let started = 0;
    const work = async () => { started++; return d.promise; };
    const a = job.run(work);
    const b = job.run(work);
    expect(b).toBe(a);
    d.resolve(1);
    await a;
    expect(started).toBe(1);
    // danach geht es wieder von vorn
    await job.run(async () => 2);
    expect(started).toBe(1);
    expect(job.get().result).toBe(2);
  });

  it('Fehler landen in `error`, run() wirft nicht; reset() vergisst sie', async () => {
    const job = new Job<never, string>();
    await job.run(async () => { throw new Error('kein Netz'); });
    expect(job.get().running).toBe(false);
    expect((job.get().error as Error).message).toBe('kein Netz');
    job.reset();
    expect(job.get()).toMatchObject({ result: null, error: null });
  });

  it('ein neuer Start löscht das alte Ergebnis', async () => {
    const job = new Job<never, string>();
    await job.run(async () => { throw new Error('alt'); });
    const d = deferred<string>();
    const run = job.run(() => d.promise);
    expect(job.get()).toMatchObject({ running: true, error: null, result: null });
    d.resolve('neu');
    await run;
  });
});
