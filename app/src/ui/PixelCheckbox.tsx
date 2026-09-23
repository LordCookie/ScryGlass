import type { ReactNode } from 'react';
import { PixelIcon } from './PixelIcon';

/**
 * Checkbox im Pixel-Look (DESIGN § 4): 9×9 Design-Pixel, 1 px Rahmen, Pixel-Haken.
 * Die echte Checkbox bleibt (unsichtbar) drin — Tastatur, Screenreader und Klick aufs
 * Label funktionieren wie gewohnt.
 */
export function PixelCheckbox({
  checked,
  onChange,
  children,
  className = '',
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <label className={`inline-flex cursor-pointer select-none items-center gap-2 ${className}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden
        className={`flex shrink-0 items-center justify-center peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-paper ${
          checked ? 'bg-fill text-paper' : 'bg-bg text-transparent'
        }`}
        style={{
          width: 'calc(var(--px) * 9)',
          height: 'calc(var(--px) * 9)',
          border: 'var(--px) solid rgb(var(--c-fill))',
        }}
      >
        <PixelIcon name="check" />
      </span>
      {children}
    </label>
  );
}
