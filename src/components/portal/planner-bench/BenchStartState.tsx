// A test case's starting state, editable. The values belong to the case: a
// change is saved into it and every planner's result for that case is run again.

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLanguage } from '@/contexts/LanguageContext';
import type { CaseStartState } from '@/lib/planner-bench/case';

interface Props {
  value: CaseStartState;
  /** Readings the source lacked, still holding a default. */
  unread: readonly string[];
  saving: boolean;
  onSave: (next: CaseStartState) => void;
}

const BenchStartState: React.FC<Props> = ({ value, unread, saving, onSave }) => {
  const { t } = useLanguage();
  const [draft, setDraft] = useState(value);
  const changed = JSON.stringify(draft) !== JSON.stringify(value);
  const valid = [draft.battery_soc, draft.ev.soc, draft.ev.target_soc].every(v => v >= 0 && v <= 1) && Number.isFinite(draft.pool_water_c);
  const percent = (id: string, label: string, v: number, set: (v: number) => void) => (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input id={id} type="number" min={0} max={100} step={1} className="h-8 w-20" value={Math.round(v * 1000) / 10}
        onChange={e => set(Number(e.target.value) / 100)} />
      <span className="text-muted-foreground">%</span>
    </label>
  );
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-medium">{t('Starttillstånd', 'Start state')}</span>
        <span className="text-xs text-muted-foreground">
          {unread.length
            ? t('Vissa värden saknades i källan och väntar på inspelad historik.', 'Some values were missing from the source and await recorded history.')
            : t('Hör till testfallet. En ändring sparas och fallet körs om.', 'Belongs to the test case. A change is saved and the case is run again.')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {percent('bench-start-battery', t('Hembatteri', 'Home battery'), draft.battery_soc, v => setDraft(d => ({ ...d, battery_soc: v })))}
        <label htmlFor="bench-start-pool" className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Pool</span>
          <Input id="bench-start-pool" type="number" step={0.1} className="h-8 w-20" value={draft.pool_water_c}
            onChange={e => setDraft(d => ({ ...d, pool_water_c: Number(e.target.value) }))} />
          <span className="text-muted-foreground">°C</span>
        </label>
        {percent('bench-start-ev', t('Elbil', 'Car'), draft.ev.soc, v => setDraft(d => ({ ...d, ev: { ...d.ev, soc: v } })))}
        {percent('bench-start-ev-target', t('Elbilens laddgräns', 'Car charge limit'), draft.ev.target_soc, v => setDraft(d => ({ ...d, ev: { ...d.ev, target_soc: v } })))}
        <Button size="sm" disabled={!changed || !valid || saving} onClick={() => onSave(draft)}>
          {t('Spara och kör om', 'Save and re-run')}
        </Button>
      </div>
    </div>
  );
};

export default BenchStartState;
