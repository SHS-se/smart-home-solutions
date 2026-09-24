import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';

import { numericInput } from '@/lib/contract-roi';

export function RoiNumberField({ id, label, value, onChange, min, max, hint }: {
  id: string; label: string; value: string; onChange: (value: string) => void;
  min?: number; max?: number; hint?: string;
}) {
  const { t } = useLanguage();
  const number = numericInput(value);
  const invalid = number === null || (min !== undefined && number < min) || (max !== undefined && number > max);
  return <div className="space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type="number" inputMode="decimal" step="any" min={min} max={max} value={value}
      onChange={e => onChange(e.target.value)} className="h-11 tabular-nums" aria-invalid={invalid}
      aria-describedby={invalid || hint ? `${id}-help` : undefined} />
    {(invalid || hint) && <p id={`${id}-help`} className={`text-sm ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}>
      {invalid ? t(`Ange ett tal${min !== undefined ? ` från ${min}` : ''}${max !== undefined ? ` till ${max}` : ''}.`, `Enter a number${min !== undefined ? ` from ${min}` : ''}${max !== undefined ? ` to ${max}` : ''}.`) : hint}
    </p>}
  </div>;
}

export function RoiSelect({ id, label, value, onChange, children }: {
  id: string; label: string; value: string; onChange: (value: string) => void; children: ReactNode;
}) {
  return <div className="min-w-0 space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <select id={id} value={value} onChange={e => onChange(e.target.value)}
      className="flex h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {children}
    </select>
  </div>;
}
