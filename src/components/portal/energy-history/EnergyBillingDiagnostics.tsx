import React, { useMemo } from 'react';
import { BadgeDollarSign, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';
import type { EnergyBillingChange } from '@/lib/energy-billing-changes';
import { divergentTariffComparisons, type EnergyTariffInvoiceComparison } from '@/lib/energy-tariff-series';

/**
 * Staff checks on the tariff the planner prices with: when terms changed, and
 * where Home Assistant's grid calculation disagrees with an imported invoice.
 * They explain a surprising bill; they are not for the customer.
 */
const EnergyBillingDiagnostics: React.FC<{ changes: EnergyBillingChange[]; tariffInvoiceComparisons: EnergyTariffInvoiceComparison[] }> = ({ changes, tariffInvoiceComparisons }) => {
  const { t, language } = useLanguage();
  const locale = language === 'sv' ? 'sv-SE' : 'en-GB';
  const formats = useMemo(() => ({
    number: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    money: new Intl.NumberFormat(locale, { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 }),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }),
    month: new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
  }), [locale]);
  const divergent = useMemo(() => divergentTariffComparisons(tariffInvoiceComparisons), [tariffInvoiceComparisons]);
  const formatMonthKey = (monthKey: string) => formats.month.format(new Date(`${monthKey}-01T00:00:00Z`));

  return (
    <details className="rounded-xl border bg-card px-5" data-testid="energy-billing-diagnostics">
      <summary className="cursor-pointer py-4 text-sm font-medium">
        {t('Kontroller för personal', 'Staff checks')}
        <span className="ml-2 font-normal text-muted-foreground">
          {t(`${changes.length} villkorsändringar`, `${changes.length} term changes`)}
          {divergent.length > 0 && ` · ${t(`${divergent.length} avvikande månader`, `${divergent.length} diverging months`)}`}
        </span>
      </summary>
      <div className="space-y-6 pb-5">
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-medium"><RefreshCw className="h-4 w-4 text-violet-600" />{t('Förändrade villkor', 'Changed terms')}</h3>
          {changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('Inga byten eller bestående pris- och modelländringar upptäcktes.', 'No provider switches or lasting price and model changes were detected.')}</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {changes.map((change) => {
                const Icon = change.type === 'provider' ? RefreshCw : change.type === 'price' ? BadgeDollarSign : Sparkles;
                return (
                  <div key={change.id} className="flex gap-3 rounded-xl border border-border/70 p-4">
                    <div className="mt-0.5 rounded-lg bg-violet-100 p-2 text-violet-700 dark:bg-violet-950 dark:text-violet-300"><Icon className="h-4 w-4" /></div>
                    <div className="min-w-0">
                      <p className="text-xs capitalize text-muted-foreground">{formats.date.format(new Date(`${change.date}T00:00:00Z`))}</p>
                      <p className="mt-0.5 text-sm font-medium">{language === 'sv' ? change.titleSv : change.titleEn}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{language === 'sv' ? change.detailSv : change.detailEn}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        {tariffInvoiceComparisons.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">{t('Ellevio-faktura jämfört med Home Assistant', 'Ellevio invoice compared with Home Assistant')}</h3>
            <p className="text-sm text-muted-foreground">
              {t(
                'Fakturan är det auktoritativa beloppet. Home Assistant-beräkningen sparas separat som en indikativ jämförelse och skrivs inte över.',
                'The invoice is the authoritative amount. The Home Assistant calculation is retained separately as an indicative comparison and is not overwritten.',
              )}
            </p>
            {divergent.length > 0 && (
              <Alert variant="destructive">
                <TriangleAlert className="h-4 w-4" />
                <AlertTitle>{t('Home Assistant-beräkningen avviker från fakturan', 'The Home Assistant calculation diverges from the invoice')}</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    {t(
                      'Avvikelsen överstiger 5 % och 100 kr under följande månader. Kontrollera historisk säkringsstorlek, mätdata och fakturans avgifter.',
                      'The difference exceeds both 5% and 100 kr in the months below. Check historical fuse sizes, meter coverage, and invoice charges.',
                    )}
                  </p>
                  <ul className="list-inside list-disc">
                    {divergent.slice(-6).map((comparison) => (
                      <li key={comparison.monthKey}>
                        {formatMonthKey(comparison.monthKey)}: {formats.money.format(comparison.differenceSek)} ({formats.percent.format(comparison.differenceRatio)})
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={tariffInvoiceComparisons} margin={{ top: 12, right: 8, bottom: 20, left: 8 }}>
                <CartesianGrid strokeDasharray="4 4" className="stroke-border/70" vertical={false} />
                <XAxis dataKey="monthKey" tickFormatter={formatMonthKey} minTickGap={20} className="text-xs" />
                <YAxis tickFormatter={(value) => formats.number.format(value)} className="text-xs" />
                <Tooltip formatter={(value: number) => formats.money.format(value)} labelFormatter={formatMonthKey} />
                <Legend />
                <Bar dataKey="invoiceAmountSek" name={t('Ellevio-faktura (auktoritativ)', 'Ellevio invoice (authoritative)')} fill="#059669" />
                <Bar dataKey="haEstimateAmountSek" name={t('Home Assistant (indikativ)', 'Home Assistant (indicative)')} fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </section>
        )}
        <Badge variant="outline">{t('Visas bara för personal', 'Shown to staff only')}</Badge>
      </div>
    </details>
  );
};

export default EnergyBillingDiagnostics;
