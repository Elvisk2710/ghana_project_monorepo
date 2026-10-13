import { ReactNode } from 'react';

const input = 'w-full rounded-lg border border-parliament-line bg-paper px-3 py-2 aria-[invalid=true]:border-[#8a1c13]';

/** Labelled form control with an optional hint and an error that is announced and linked to the input. */
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; className: string }) => ReactNode }) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold">{label}</label>
      {hint && <p id={`${id}-hint`} className="mb-1 text-sm text-ink-soft">{hint}</p>}
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, className: input })}
      {error && <p id={`${id}-err`} role="alert" className="mt-1 text-sm font-medium text-[#8a1c13]">{error}</p>}
    </div>
  );
}

export const primaryButton = 'rounded-xl bg-parliament-green px-6 py-2.5 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parliament-green disabled:opacity-60';
export const secondaryButton = 'rounded-xl border border-parliament-line bg-paper px-5 py-2.5 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-parliament-green disabled:opacity-60';

export const fmtDateTime = (d: string) =>
  new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
