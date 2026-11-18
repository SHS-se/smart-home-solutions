import { useId } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';

export function HeatingBandSelect({ options, selected, onSelect }: {
  options: { key: string; label: string }[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  const id = useId();
  const { t } = useLanguage();
  return <div className="flex flex-wrap items-center gap-2">
    <label htmlFor={id} className="font-medium">{t('Utomhustemperaturintervall', 'Outdoor temperature band')}</label>
    <select id={id} value={selected} onChange={event => onSelect(event.target.value)}
      className="min-h-11 max-w-full rounded-md border border-input bg-background px-3">
      {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select>
  </div>;
}
