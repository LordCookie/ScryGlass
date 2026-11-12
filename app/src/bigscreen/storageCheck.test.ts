import { describe, it, expect } from 'vitest';
import { storageErrorKind, isStorageBlockedError } from './storageCheck';

describe('Speicher im Browser', () => {
  it('erkennt einen gesperrten Speicher an der Browser-Meldung', () => {
    expect(storageErrorKind({ name: 'UnknownError', message: 'The user denied permission to access the database.' })).toBe('blockiert');
    expect(storageErrorKind({ name: 'SecurityError', message: 'The operation is insecure.' })).toBe('blockiert');
    expect(storageErrorKind({ name: 'UnknownError', message: 'Internal error opening backing store for indexedDB.open.' })).toBe('kaputt');
  });

  it('auch wenn Dexie den Fehler einpackt', () => {
    const dexie = { name: 'OpenFailedError', message: 'UnknownError The user denied permission to access the database.', inner: { name: 'UnknownError', message: 'The user denied permission to access the database.' } };
    expect(isStorageBlockedError(dexie)).toBe(true);
    expect(isStorageBlockedError(new Error('Deine Karten kamen nicht vom Handy.'))).toBe(false);
  });
});
