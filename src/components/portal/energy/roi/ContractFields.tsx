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
  monthlyMarkup: string;
  markupUnit: 'percent' | 'monthly';
}

export default function ContractFields({ draft, onChange, source }: {
  draft: ContractDraft; onChange: (draft: ContractDraft) => void; source: 'ha' | 'invoices';
}) {
  const { t } = useLanguage();
  const set = <K extends keyof ContractDraft>(key: K, value: ContractDraft[K]) => onChange({ ...draft, [key]: value });
  const kinds: { value: ContractKind; label: string }[] = [
    { value: 'fixed', label: t('Fast pris', 'Fixed price') },
    { value: 'monthly', label: t('Månadspris', 'Monthly variable') },
    { value: 'quarterly', label: t('Kvartspris', 'Quarter-hour variable') },
    { value: 'mixed', label: t('Mixpris', 'Mixed contract') },
  ];
  return <div className="space-y-4">
    <RoiSelect id="roi-contract-kind" label={t('Avtalstyp', 'Contract type')} value={draft.kind} onChange={value => {
      onChange({ ...draft, kind: value as ContractKind, example: 'custom', method: value === 'monthly' ? 'components' : 'quote' });
    }}>
      {kinds.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
    </RoiSelect>
    {draft.kind !== 'monthly' && <RoiSelect id="roi-example" label={t('Avtalsexempel', 'Contract example')} value={draft.example} onChange={value => {
      const example = CONTRACT_EXAMPLES.find(e => e.id === value);
      onChange({ ...draft, example: value, ...(example && draft.kind !== 'monthly' ? { rate: String(example.rate), method: 'quote' as const } : {}) });
    }}>
      <option value="custom">{t('Eget avtal', 'Custom contract')}</option>
      {CONTRACT_EXAMPLES.filter(e => e.kind === draft.kind).map(e => <option key={e.id} value={e.id}>
        {e.provider}{draft.kind !== 'monthly' ? ` · ${e.rate.toFixed(2)} öre/kWh` : ''}{e.years ? ` · ${e.years} ${t('år', 'yr')}` : ''}
      </option>)}
    </RoiSelect>}
    {draft.kind !== 'monthly' && <RoiSelect id="roi-pricing-method" label={t('Prismodell', 'Price model')} value={draft.method} onChange={value => set('method', value as PricingMethod)}>
      <option value="quote">{t('Inklusive avgifter', 'Fees included')}</option>
      {draft.kind !== 'quarterly' && <option value="components">{t('Pris + månadsavgift', 'Rate + monthly fee')}</option>}
      {draft.kind === 'quarterly' && source === 'ha' && <option value="profile">{t('Spotpris + påslagsskillnad', 'Spot + markup difference')}</option>}
    </RoiSelect>}
    {draft.kind === 'monthly' ? <div className="grid gap-4 sm:grid-cols-2">
      <RoiSelect id="roi-markup-unit" label={t('Leverantörspåslag', 'Supplier markup')} value={draft.markupUnit} onChange={v => set('markupUnit', v as ContractDraft['markupUnit'])}>
        <option value="percent">%</option><option value="monthly">{t('kr/månad', 'SEK/month')}</option>
      </RoiSelect>
      <RoiNumberField id="roi-monthly-markup" label={draft.markupUnit === 'percent' ? t('Påslag (%)', 'Markup (%)') : t('Påslag (kr/månad)', 'Markup (SEK/month)')} min={0} value={draft.monthlyMarkup} onChange={v => set('monthlyMarkup', v)} />
    </div> : draft.method === 'profile' ? <>
      <RoiNumberField id="roi-markup" label={t('Påslagsskillnad (öre/kWh)', 'Markup difference (öre/kWh)')} value={draft.markup} onChange={v => set('markup', v)} />

    </> : <RoiNumberField id="roi-rate" label={draft.kind === 'mixed' && draft.method === 'components'
      ? t('Fast del (öre/kWh inkl. moms)', 'Fixed portion rate (öre/kWh incl. VAT)')
      : t('Pris (öre/kWh)', 'Rate (öre/kWh)')}
      value={draft.rate} onChange={v => onChange({ ...draft, rate: v, example: 'custom' })} />}
    {draft.kind === 'mixed' && draft.method === 'components' && <div className="grid gap-4 sm:grid-cols-2">
      <RoiNumberField id="roi-variable-rate" label={t('Rörlig del (öre/kWh)', 'Variable portion (öre/kWh)')} value={draft.variableRate} onChange={v => set('variableRate', v)} />
      <RoiNumberField id="roi-fixed-share" label={t('Fast andel (%)', 'Fixed share (%)')} min={0} max={100} value={draft.fixedShare} onChange={v => set('fixedShare', v)} />
    </div>}
    {draft.kind !== 'monthly' && draft.method !== 'quote' && <RoiNumberField id="roi-contract-fee" label={t('Månadsavgift (kr)', 'Monthly fee (SEK)')} min={0} value={draft.fee} onChange={v => set('fee', v)} />}
  </div>;
}
