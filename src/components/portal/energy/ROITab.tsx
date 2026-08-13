import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, BarChart3, Clock, DollarSign, Loader2, TrendingUp } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  computeRoi,
  MIN_DAYS_FOR_OBSERVED_RATE,
  seasonalPlannerCheck,
  summariseObservedSavings,
  type PlanRunRow,
  type Season,
} from '@/lib/energy-roi';

const REQUIRED_FIELDS = ['heated_boarea_m2', 'heated_biarea_m2', 'year_built', 'dwelling_type'];
const SEMANTIC_LABELS: Record<string, { sv: string; en: string }> = {
  heated_boarea_m2: { sv: 'Uppvärmd boarea (m²)', en: 'Heated boarea (m²)' },
  heated_biarea_m2: { sv: 'Uppvärmd biarea (m²)', en: 'Heated biarea (m²)' },
  year_built: { sv: 'Byggnadsår', en: 'Year Built' },
  dwelling_type: { sv: 'Bostadstyp', en: 'Dwelling Type' },
};

interface ROITabProps {
  customerId: string;
  homeId: string | null;
  homeCount?: number;
}

const ROITab: React.FC<ROITabProps> = ({ customerId, homeId, homeCount = 1 }) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [hardwareCost, setHardwareCost] = useState(50000);
  const [installCost, setInstallCost] = useState(15000);
  const [monthlySubscription, setMonthlySubscription] = useState(299);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [homeName, setHomeName] = useState<string>('');
  const [runs, setRuns] = useState<PlanRunRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!homeId) { setLoading(false); return; }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const [home, questions, answers, planRuns] = await Promise.all([
        supabase.from('homes').select('name').eq('id', homeId).single(),
        supabase.from('home_questions').select('id, semantic_key').in('semantic_key', REQUIRED_FIELDS),
        supabase.from('home_answers').select('question_id, answer_value').eq('home_id', homeId),
        supabase
          .from('energy_optimisation_plan_runs')
          .select('issued_at, status, summary')
          .eq('home_id', homeId)
          .order('issued_at', { ascending: false })
          .limit(1000),
      ]);
      if (cancelled) return;

      if (home.data) setHomeName(home.data.name);
      if (questions.data) {
        const answered = new Set(
          (answers.data ?? []).filter(a => a.answer_value != null).map(a => a.question_id),
        );
        setMissingFields(
          questions.data.filter(q => !answered.has(q.id)).map(q => q.semantic_key!).filter(Boolean),
        );
      }
      setRuns((planRuns.data ?? []) as PlanRunRow[]);
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [homeId]);

  const observed = useMemo(() => summariseObservedSavings(runs), [runs]);
  // A planner diagnostic, not the customer's money: the fixtures describe one
  // synthetic reference home. Pinned reference time so it stays stable on screen.
  const plannerCheck = useMemo(() => seasonalPlannerCheck(), []);
  const roi = useMemo(() => computeRoi({
    observed,
    investmentSek: hardwareCost + installCost,
    monthlySubscriptionSek: monthlySubscription,
  }), [observed, hardwareCost, installCost, monthlySubscription]);

  const seasonLabel = (season: Season) => ({
    winter: t('Vinter', 'Winter'),
    spring: t('Vår', 'Spring'),
    summer: t('Sommar', 'Summer'),
    autumn: t('Höst', 'Autumn'),
  }[season]);

  const sek = (value: number | null, digits = 0) => (
    value === null ? '—' : `${value.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })} SEK`
  );

  if (!homeId) {
    return (
      <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
        <p>{t('Välj ett hem för att se lönsamhet.', 'Select a home to view ROI.')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('Laddar lönsamhet…', 'Loading ROI…')}
      </div>
    );
  }

  const seasonalData = plannerCheck.perSeason.map(point => ({
    name: seasonLabel(point.season),
    saving: Math.round(point.savingSekPerDay * point.days),
  }));

  return (
    <div className="space-y-6">
      {homeCount <= 1 && homeName && (
        <p className="text-sm text-muted-foreground">{t('Lönsamhet för', 'ROI for')}: {homeName}</p>
      )}

      {missingFields.length > 0 && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-primary mt-0.5 shrink-0" />
              <div className="space-y-3 flex-1">
                <p className="font-medium text-sm">
                  {t('Några detaljer gör beräkningen bättre', 'A few details would improve this calculation')}
                </p>
                <ul className="space-y-1">
                  {missingFields.map(key => (
                    <li key={key} className="text-sm text-muted-foreground flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                      {t(SEMANTIC_LABELS[key]?.sv || key, SEMANTIC_LABELS[key]?.en || key)}
                    </li>
                  ))}
                </ul>
                <Button size="sm" onClick={() => navigate(`/portal/home-profile?home=${homeId}`)}>
                  {t('Fortsätt inställning', 'Continue setup')}
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/*
        The honesty that this page previously lacked. The old version compared
        two `model_runs` scenarios that ran the identical simulation, so its
        "annual savings" was noise between two runs' inputs.
      */}
      <Alert>
        <AlertTitle>{t('Så räknas besparingen', 'How this saving is calculated')}</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed">
          {t(
            'Siffran jämför planerarens egen prioriterade plan med dess referensplan för samma timme och samma priser. Det är en skillnad mot vad huset annars hade gjort — inte en uppmätt före-och-efter-jämförelse. Planhistoriken sparas i 30 dagar, så ett helt år kan aldrig mätas: årssiffran nedan är din uppmätta dygnstakt framskriven över ett år, och besparingen varierar starkt med säsong. Behandla den som en indikation, inte ett löfte.',
            'The figure compares the planner’s own priority plan with its baseline plan for the same hour and the same prices. It is a difference against what the house would otherwise have done — not a measured before-and-after. Plan history is retained for 30 days, so a full year can never be measured: the annual figure below is your observed daily rate carried across a year, and savings vary strongly by season. Treat it as an indication, not a promise.',
          )}
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10"><TrendingUp className="w-5 h-5 text-primary" /></div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t('Besparing per dygn', 'Saving per day')}</p>
                <p className="text-xl font-semibold">{sek(roi.savingSekPerDay, 2)}</p>
                <Badge variant="outline" className="mt-1 text-[10px]">
                  {roi.blocker === null
                    ? t(`uppmätt över ${observed.days} dygn`, `observed over ${observed.days} days`)
                    : roi.blocker === 'too_few_days'
                      ? t(`${observed.days} av ${MIN_DAYS_FOR_OBSERVED_RATE} dygn`, `${observed.days} of ${MIN_DAYS_FOR_OBSERVED_RATE} days`)
                      : t('ingen planhistorik', 'no plan history')}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-accent"><DollarSign className="w-5 h-5 text-accent-foreground" /></div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t('Per år om takten håller', 'Per year if the rate holds')}</p>
                <p className="text-xl font-semibold">{sek(roi.annualIfSustainedSek)}</p>
                <Badge variant="outline" className="mt-1 text-[10px]">
                  {t('framskrivning', 'extrapolation')}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-secondary"><DollarSign className="w-5 h-5 text-secondary-foreground" /></div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t('Netto efter abonnemang', 'Net after subscription')}</p>
                <p className="text-xl font-semibold">{sek(roi.netAnnualIfSustainedSek)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('abonnemang', 'subscription')} {sek(roi.annualSubscriptionSek)}/{t('år', 'yr')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-secondary"><Clock className="w-5 h-5 text-secondary-foreground" /></div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t('Återbetalningstid', 'Payback period')}</p>
                <p className="text-xl font-semibold">
                  {roi.paybackYearsIfSustained === null
                    ? '—'
                    : `${roi.paybackYearsIfSustained.toFixed(1)} ${t('år', 'yr')}`}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {roi.blocker !== null
                    ? t('behöver mer planhistorik', 'needs more plan history')
                    : roi.paybackYearsIfSustained === null
                      ? t('besparingen täcker inte abonnemanget', 'the saving does not cover the subscription')
                      : t('om takten håller', 'if the rate holds')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              {t('Planerarkontroll per säsong', 'Planner check by season')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={seasonalData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="name" className="text-xs" />
                <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}k`} className="text-xs" />
                <Tooltip formatter={(v: number) => [`${v.toLocaleString()} SEK`]} />
                <Legend />
                <Bar dataKey="saving" name={t('Besparing', 'Saving')} fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                'Det här är en kontroll av planeraren, inte dina pengar. De fyra säsongsfallen beskriver ett syntetiskt referenshus och körs genom samma planerare som en riktig plan, så en säsong som går back är ett fel i planeraren — inte en prognos för ditt hem.',
                'This is a check on the planner, not your money. The four seasonal cases describe a synthetic reference home and run through the same planner as a live plan, so a season that loses money is a planner defect — not a forecast for your home.',
              )}
            </p>
            {plannerCheck.regressions.length > 0 && (
              <Alert variant="destructive" className="mt-3">
                <AlertTitle className="text-sm">
                  {t('Planeraren går back i en säsong', 'The planner loses money in one season')}
                </AlertTitle>
                <AlertDescription className="text-xs">
                  {t(
                    `I ${plannerCheck.regressions.map(seasonLabel).join(', ').toLowerCase()} kostar den prioriterade planen mer än sin egen referensplan. Det är ett känt fel som utreds, och det är skälet till att årssiffran ovan bygger på din uppmätta takt i stället för på de här fallen.`,
                    `In ${plannerCheck.regressions.map(seasonLabel).join(', ').toLowerCase()} the priority plan costs more than its own baseline. This is a known defect under investigation, and it is why the annual figure above is based on your observed rate rather than on these cases.`,
                  )}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('Din planhistorik', 'Your plan history')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {observed.days === 0 ? (
                <p className="text-muted-foreground">
                  {t(
                    'Ingen planhistorik ännu. När Home Assistant har begärt planer i några dygn visas din egen uppmätta besparingstakt här.',
                    'No plan history yet. Once Home Assistant has requested plans for a few days, your own observed saving rate appears here.',
                  )}
                </p>
              ) : (
                <>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-muted-foreground">{t('Dagar med planer', 'Days with plans')}</span>
                    <span className="font-medium tabular-nums">
                      {observed.days}
                      {observed.days < MIN_DAYS_FOR_OBSERVED_RATE
                        && ` ${t(`(minst ${MIN_DAYS_FOR_OBSERVED_RATE} behövs)`, `(at least ${MIN_DAYS_FOR_OBSERVED_RATE} needed)`)}`}
                    </span>
                  </div>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-muted-foreground">{t('Median per dygn', 'Median per day')}</span>
                    <span className="font-medium tabular-nums">{sek(observed.medianSavingSekPerDay, 2)}</span>
                  </div>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-muted-foreground">{t('Spridning (p10–p90)', 'Spread (p10–p90)')}</span>
                    <span className="font-medium tabular-nums">
                      {sek(observed.p10SavingSekPerDay, 2)} – {sek(observed.p90SavingSekPerDay, 2)}
                    </span>
                  </div>
                  <div className="flex justify-between border-b py-1">
                    <span className="text-muted-foreground">{t('Summa över perioden', 'Total over the period')}</span>
                    <span className="font-medium tabular-nums">{sek(roi.observedPeriodSavingSek, 0)}</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-muted-foreground">{t('Säsonger som täcks', 'Seasons covered')}</span>
                    <span className="font-medium">{observed.seasons.map(seasonLabel).join(', ')}</span>
                  </div>
                  <p className="pt-2 text-xs text-muted-foreground">
                    {t(
                      `${observed.runs} planer över ${observed.days} dygn. Planer begärs varje timme och sträcker sig 72 timmar, så de överlappar kraftigt — antalet dygn är det som räknas som underlag, inte antalet planer.`,
                      `${observed.runs} plans across ${observed.days} days. Plans are requested hourly and cover 72 hours, so they overlap heavily — the number of days is the evidence, not the number of plans.`,
                    )}
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('Investeringskostnad', 'Investment cost')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-sm">{t('Hårdvarukostnad (SEK)', 'Hardware cost (SEK)')}</Label>
                <Input type="number" value={hardwareCost} onChange={e => setHardwareCost(Number(e.target.value) || 0)} />
              </div>
              <div>
                <Label className="text-sm">{t('Installationskostnad (SEK)', 'Installation cost (SEK)')}</Label>
                <Input type="number" value={installCost} onChange={e => setInstallCost(Number(e.target.value) || 0)} />
              </div>
              <div>
                <Label className="text-sm">{t('Månadsabonnemang (SEK)', 'Monthly subscription (SEK)')}</Label>
                <Input type="number" value={monthlySubscription} onChange={e => setMonthlySubscription(Number(e.target.value) || 0)} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  'Ange siffror från en verklig offert. Fälten är exempelvärden och hämtas ännu inte automatiskt.',
                  'Enter figures from a real quote. These fields are example values and are not yet pulled from one automatically.',
                )}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default ROITab;
