import React, { useMemo } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import type { EnergyBillingMonth } from '@/lib/energy-billing-series';
import { getEnergyCoverageIssues } from '@/lib/energy-history-coverage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
    <Card className="overflow-hidden border-border/70 shadow-sm">
      <CardHeader className="border-b border-border/60">
        <CardTitle className="text-base">
          {t('Månadstäckning', 'Monthly coverage')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-5">
        <p className="mb-4 text-sm text-muted-foreground">
          {t(
            'Månader där ingen uppladdad fil täcker hela perioden. Beloppen beräknas då från Home Assistant, och en uppladdad faktura ersätter beräkningen för hela den månad den rör.',
            'Months no uploaded file covers in full. Those amounts are calculated from Home Assistant instead, and an uploaded invoice replaces the calculation for every month it touches.',
          )}
        </p>
        {issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('Varje månad täcks av uppladdade filer.', 'Every month is covered by uploaded files.')}
          </p>
        ) : (
          <div className="overflow-x-auto">
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
        )}
      </CardContent>
    </Card>
  );
};

export default EnergyCoverageTable;
