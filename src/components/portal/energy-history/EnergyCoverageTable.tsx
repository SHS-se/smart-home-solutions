import React, { useMemo } from 'react';
import { CheckCircle2, ChevronDown, TriangleAlert } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import type { EnergyBillingMonth } from '@/lib/energy-billing-series';
import { getEnergyCoverageIssues } from '@/lib/energy-history-coverage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface EnergyCoverageTableProps {
  series: EnergyBillingMonth[];
  moveInDate?: string | null;
}

/**
 * The month-by-month inventory of what is uploaded and what is calculated.
 *
 * It lives here rather than on the overview because it is reference material:
 * worth having when you go looking, not worth a warning banner over a chart
 * every time a meter missed an afternoon.
 */
const EnergyCoverageTable: React.FC<EnergyCoverageTableProps> = ({
  series,
  moveInDate = null,
}) => {
  const { language } = useLanguage();
  const t = (sv: string, en: string) => (language === 'sv' ? sv : en);

  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(
    language === 'sv' ? 'sv-SE' : 'en-GB',
    { month: 'long', year: 'numeric', timeZone: 'UTC' },
  ), [language]);

  const issues = useMemo(
    () => getEnergyCoverageIssues(series, moveInDate).slice().reverse(),
    [series, moveInDate],
  );

  const label = (status: 'complete' | 'partial' | 'missing') => {
    if (status === 'complete') return t('komplett', 'complete');
    if (status === 'partial') return t('delvis', 'partial');
    return t('saknas', 'missing');
  };

  return (
    <Card className="overflow-hidden border-border/70 shadow-sm" data-testid="energy-monthly-coverage">
      <CardHeader className="border-b border-border/60">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              {t('Månadstäckning', 'Monthly coverage')}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('Se direkt vilka underlag som saknas innan du laddar upp.', 'See which source data is missing before you upload.')}
            </p>
          </div>
          {series.length > 0 && (
            <Badge
              variant="outline"
              className={issues.length === 0
                ? 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300'
                : 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300'}
            >
              {issues.length === 0
                ? t('Alla månader kompletta', 'All months complete')
                : t(`${issues.length} månader behöver underlag`, `${issues.length} months need data`)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-5">
        <p className="mb-4 text-sm text-muted-foreground">
          {t(
            'Månader där ingen uppladdad fil täcker hela perioden. Beloppen beräknas då från Home Assistant, och en uppladdad faktura ersätter beräkningen för hela den månad den rör.',
            'Months no uploaded file covers in full. Those amounts are calculated from Home Assistant instead, and an uploaded invoice replaces the calculation for every month it touches.',
          )}
        </p>
        {series.length === 0 ? (
          <div className="flex items-start gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {t(
                'Ingen faktura- eller tariffhistorik finns ännu. Ladda upp första fakturan nedan så visas täckningen här.',
                'There is no invoice or tariff history yet. Upload the first invoice below and its coverage will appear here.',
              )}
            </p>
          </div>
        ) : issues.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            <p>{t('Varje månad täcks av uppladdade filer.', 'Every month is covered by uploaded files.')}</p>
          </div>
        ) : (
          <details className="group" open={issues.length <= 6}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2 text-sm font-medium">
              <span>
                {t(
                  `Visa ${issues.length} ofullständiga månader`,
                  `Show ${issues.length} incomplete months`,
                )}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">{t('Månad', 'Month')}</th>
                  <th className="py-2 pr-4 font-medium">{t('Elnät', 'Grid')}</th>
                  <th className="py-2 font-medium">{t('Elhandel', 'Electricity')}</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => (
                  <tr key={issue.monthKey} className="border-b border-border/40 last:border-0">
                    <td className="py-2 pr-4 capitalize">
                      {monthFormatter.format(new Date(`${issue.monthKey}-01T00:00:00Z`))}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {label(issue.gridCoverage)}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {label(issue.electricityCoverage)}
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
};

export default EnergyCoverageTable;
