import { useSyncExternalStore } from 'react';
import type { Job, JobState } from '../data/job';

/** An eine Hintergrund-Aufgabe (data/job) anhängen — überlebt das Verlassen des Tabs. */
export function useJob<S, R>(job: Job<S, R>): JobState<S, R> {
  return useSyncExternalStore(job.subscribe, job.get);
}
