/**
 * CSV-Export der Sammlung (PLAN.md § 5, M5). Moxfield-/ManaBox-kompatibel:
 * Spalten `Count,Name,Edition,Condition,Language,Foil,Collector Number`.
 * Moxfield importiert dieses Format direkt; ManaBox akzeptiert Count/Name/Foil.
 *
 * v1 zählt auf Oracle-Ebene — Edition/Collector Number bleiben leer, wenn (noch)
 * keine Druckausgabe sicher erkannt wurde. Der Aufrufer reicht bereits verbundene
 * Zeilen herein (Name + optional Set/Nummer), damit das Modul framework-frei bleibt.
 */
import type { Finish, Lang } from './types';

export interface CsvRow {
  name: string;
  qty: number;
  finish: Finish;
  lang: Lang;
  setCode?: string;
  collectorNumber?: string;
}

const HEADER = ['Count', 'Name', 'Edition', 'Condition', 'Language', 'Foil', 'Collector Number'];

function esc(field: string): string {
  if (/[",\n]/.test(field)) return '"' + field.replace(/"/g, '""') + '"';
  return field;
}

function foilField(finish: Finish): string {
  if (finish === 'foil') return 'foil';
  if (finish === 'etched') return 'etched';
  return ''; // nonfoil → leer (Moxfield-Konvention)
}

export function toMoxfieldCsv(rows: readonly CsvRow[]): string {
  const lines = [HEADER.join(',')];
  // Deterministisch sortieren (Name, dann Finish) → stabiler Export.
  const sorted = [...rows].sort(
    (a, b) => a.name.localeCompare(b.name) || a.finish.localeCompare(b.finish),
  );
  for (const r of sorted) {
    lines.push(
      [
        String(r.qty),
        esc(r.name),
        esc(r.setCode ?? ''),
        'NM',
        esc(r.lang),
        foilField(r.finish),
        esc(r.collectorNumber ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}
