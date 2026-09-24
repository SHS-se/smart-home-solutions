import { useLanguage } from '@/contexts/LanguageContext';
import { CONTRACT_EXAMPLES, type ContractKind, type PricingMethod } from '@/lib/contract-roi';
import { RoiNumberField, RoiSelect } from './RoiFields';

export interface ContractDraft {
  kind: ContractKind;
  method: PricingMethod;
  example: string;
  rate: string;
  fee: string;
  variableRate: string;
  fixedShare: string;
  markup: string;
  monthlyRates: Record<string, string>;
}

export default function ContractFields({ draft, onChange, months, source }: {
  draft: ContractDraft; onChange: (draft: ContractDraft) => void; months: string[]; source: 'ha' | 'invoices';
}) {
  const { t } = useLanguage();
  const set = <K extends keyof ContractDraft>(key: K, value: ContractDraft[K]) => onChange({ ...draft, [key]: value });
  const kinds: { value: ContractKind; label: string }[] = [
    { value: 'fixed', label: t('Fast pris', 'Fixed price') },
    { value: 'monthly', label: t('Månadspris', 'Monthly variable') },
    { value: 'quarterly', label: t('Kvartspris', 'Quarter-hour variable') },
    { value: 'mixed', label: t('Mixpris', 'Mixed contract') },
  ];
  return <div className="space-y-5">
    <RoiSelect id="roi-contract-kind" label={t('Avtalstyp', 'Contract type')} value={draft.kind} onChange={value => {
      onChange({ ...draft, kind: value as ContractKind, example: 'custom', method: 'quote', monthlyRates: {} });
    }}>
      {kinds.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
    </RoiSelect>
    <RoiSelect id="roi-example" label={t('Offert att utgå från', 'Quote starting point')} value={draft.example} onChange={value => {
      const example = CONTRACT_EXAMPLES.find(e => e.id === value);
      onChange({ ...draft, example: value, ...(example ? { rate: String(example.rate), method: 'quote' as const, monthlyRates: {} } : {}) });
    }}>
      <option value="custom">{t('Eget avtal', 'Custom contract')}</option>
      {CONTRACT_EXAMPLES.filter(e => e.kind === draft.kind).map(e => <option key={e.id} value={e.id}>
        {e.provider} · {e.rate.toFixed(2)} {t('öre/kWh', 'öre/kWh')}{e.years ? ` · ${e.years} ${t('år', 'yr')}` : ''}
      </option>)}
    </RoiSelect>
    <p className="text-sm leading-relaxed text-muted-foreground">{t(
      'Exemplen kommer från dina skärmbilder, inte aktuella erbjudanden. Jämförpriset inkluderar avgifter vid 12 000 kWh/år. För en exakt jämförelse vid din förbrukning, ange elpris och månadsavgift separat.',
      'Examples come from your screenshots, not live offers. Their headline rate includes fees at 12,000 kWh/year. For an accurate comparison at your usage, enter the energy rate and monthly fee separately.',
    )}</p>
    <RoiSelect id="roi-pricing-method" label={t('Prisunderlag', 'Pricing basis')} value={draft.method} onChange={value => set('method', value as PricingMethod)}>
      <option value="quote">{t('Jämförpris inklusive avgifter', 'Headline rate including fees')}</option>
      {draft.kind !== 'quarterly' && <option value="components">{t('Elpris + separat månadsavgift', 'Energy rate + separate monthly fee')}</option>}
      {draft.kind === 'quarterly' && source === 'ha' && <option value="profile">{t('Mitt prismönster + skillnad i påslag', 'My price profile + markup difference')}</option>}
    </RoiSelect>
    {draft.method === 'profile' ? <>
      <RoiNumberField id="roi-markup" label={t('Skillnad mot mitt påslag (öre/kWh inkl. moms)', 'Difference from my markup (öre/kWh incl. VAT)')} value={draft.markup} onChange={v => set('markup', v)} />
      <p className="text-sm text-muted-foreground">{t('Samma spotpris och förbrukningstid som i HA-underlaget. Ändrar bara påslaget; ingen ny simulering av laststyrning.', 'Uses the same spot price and consumption timing as your HA history. Changes only the markup; it does not simulate a different schedule.')}</p>
    </> : <RoiNumberField id="roi-rate" label={draft.kind === 'mixed' && draft.method === 'components'
      ? t('Fast del (öre/kWh inkl. moms)', 'Fixed portion rate (öre/kWh incl. VAT)')
      : t('Elpris (öre/kWh inkl. moms)', 'Electricity rate (öre/kWh incl. VAT)')}
      value={draft.rate} onChange={v => onChange({ ...draft, rate: v, example: 'custom' })} />}
    {draft.kind === 'mixed' && draft.method === 'components' && <div className="grid gap-4 sm:grid-cols-2">
      <RoiNumberField id="roi-variable-rate" label={t('Rörlig del (öre/kWh)', 'Variable portion (öre/kWh)')} value={draft.variableRate} onChange={v => set('variableRate', v)} />
      <RoiNumberField id="roi-fixed-share" label={t('Fast andel (%)', 'Fixed share (%)')} min={0} max={100} value={draft.fixedShare} onChange={v => set('fixedShare', v)} />
    </div>}
    {draft.method !== 'quote' && <RoiNumberField id="roi-contract-fee" label={t('Avtalets månadsavgift (SEK inkl. moms)', 'Contract monthly fee (SEK incl. VAT)')} min={0} value={draft.fee} onChange={v => set('fee', v)} />}
    {draft.kind === 'monthly' && months.length > 0 && <details className="rounded-lg border p-3">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">{t('Ange olika priser per månad', 'Set different prices by month')}</summary>
      <p className="mb-4 text-sm text-muted-foreground">{t('Grundpriset används om du inte anger ett månadspris. Månadspriserna använder samma prisunderlag som ovan.', 'The main rate applies unless you set a month-specific rate. Monthly rates use the pricing basis selected above.')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {months.map(month => <RoiNumberField key={month} id={`roi-rate-${month}`} label={`${month} (öre/kWh)`}
          value={draft.monthlyRates[month] ?? draft.rate} onChange={v => set('monthlyRates', { ...draft.monthlyRates, [month]: v })} />)}
      </div>
    </details>}
    {draft.method === 'quote' && <p className="rounded-lg bg-muted p-3 text-sm leading-relaxed">{t(
      'Detta är en prisbenchmark: samma jämförpris används på dina uppmätta kWh. Rörliga och mixade jämförpriser är inte historiska priser eller garantier för framtiden. Ingen extra månadsavgift läggs till.',
      'This is a price benchmark: the quoted rate is applied to your measured kWh. Variable and mixed headline rates are not historical prices or future guarantees. No extra monthly fee is added.',
    )}</p>}
  </div>;
}
