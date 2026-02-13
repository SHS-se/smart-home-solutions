import React, { useState } from 'react';
import { TrendingUp, DollarSign, Clock, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface ROITabProps {
  customerId: string;
}

const ROITab: React.FC<ROITabProps> = ({ customerId }) => {
  const { t } = useLanguage();
  const [hardwareCost, setHardwareCost] = useState(50000);
  const [installCost, setInstallCost] = useState(15000);
  const [monthlySubscription, setMonthlySubscription] = useState(299);

  // TODO: Pull from latest model_runs – using demo values for now
  const annualCostDumb = 45000;
  const annualCostSmart = 32000;
  const annualSavings = annualCostDumb - annualCostSmart;
  const totalInvestment = hardwareCost + installCost;
  const annualSubscription = monthlySubscription * 12;
  const netAnnualSavings = annualSavings - annualSubscription;
  const paybackYears = netAnnualSavings > 0 ? totalInvestment / netAnnualSavings : Infinity;

  const costBreakdown = [
    { name: t('Nätavgift', 'Network Fee'), dumb: 18000, smart: 11000 },
    { name: t('Energi', 'Energy'), dumb: 22000, smart: 18000 },
    { name: t('Fast avgift', 'Fixed Fee'), dumb: 5000, smart: 5000 },
  ];

  const scenarioComparison = [
    { label: t('Årlig kostnad (Dum)', 'Annual Cost (Dumb)'), value: `${annualCostDumb.toLocaleString()} SEK` },
    { label: t('Årlig kostnad (Smart)', 'Annual Cost (Smart)'), value: `${annualCostSmart.toLocaleString()} SEK` },
    { label: t('Årlig besparing', 'Annual Savings'), value: `${annualSavings.toLocaleString()} SEK` },
    { label: t('Abonnemang/år', 'Subscription/yr'), value: `${annualSubscription.toLocaleString()} SEK` },
    { label: t('Nettobesparing/år', 'Net Savings/yr'), value: `${netAnnualSavings.toLocaleString()} SEK` },
    { label: t('Återbetalningstid', 'Payback Period'), value: paybackYears === Infinity ? '—' : `${paybackYears.toFixed(1)} ${t('år', 'years')}` },
  ];

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-destructive/10"><DollarSign className="w-5 h-5 text-destructive" /></div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Utan smart styrning', 'Without Smart Control')}</p>
                <p className="text-xl font-semibold">{annualCostDumb.toLocaleString()} SEK</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10"><DollarSign className="w-5 h-5 text-primary" /></div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Med smart styrning', 'With Smart Control')}</p>
                <p className="text-xl font-semibold">{annualCostSmart.toLocaleString()} SEK</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent"><TrendingUp className="w-5 h-5 text-accent-foreground" /></div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Årlig besparing', 'Annual Savings')}</p>
                <p className="text-xl font-semibold">{annualSavings.toLocaleString()} SEK</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-secondary"><Clock className="w-5 h-5 text-secondary-foreground" /></div>
              <div>
                <p className="text-xs text-muted-foreground">{t('Återbetalningstid', 'Payback Period')}</p>
                <p className="text-xl font-semibold">{paybackYears === Infinity ? '—' : `${paybackYears.toFixed(1)} ${t('år', 'yr')}`}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost breakdown chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              {t('Kostnadsfördelning', 'Cost Breakdown')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={costBreakdown}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="name" className="text-xs" />
                <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}k`} className="text-xs" />
                <Tooltip formatter={(v: number) => [`${v.toLocaleString()} SEK`]} />
                <Legend />
                <Bar dataKey="dumb" name={t('Dum', 'Dumb')} fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} fillOpacity={0.7} />
                <Bar dataKey="smart" name={t('Smart', 'Smart')} fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Inputs + scenario table */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('Investeringskostnad', 'Investment Cost')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-sm">{t('Hårdvarukostnad (SEK)', 'Hardware Cost (SEK)')}</Label>
                <Input type="number" value={hardwareCost} onChange={e => setHardwareCost(Number(e.target.value) || 0)} />
              </div>
              <div>
                <Label className="text-sm">{t('Installationskostnad (SEK)', 'Installation Cost (SEK)')}</Label>
                <Input type="number" value={installCost} onChange={e => setInstallCost(Number(e.target.value) || 0)} />
              </div>
              <div>
                <Label className="text-sm">{t('Månadsabonnemang (SEK)', 'Monthly Subscription (SEK)')}</Label>
                <Input type="number" value={monthlySubscription} onChange={e => setMonthlySubscription(Number(e.target.value) || 0)} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('Scenariojämförelse', 'Scenario Comparison')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {scenarioComparison.map((row, i) => (
                  <div key={i} className="flex justify-between py-1 border-b border-border last:border-0 text-sm">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="font-medium">{row.value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default ROITab;
