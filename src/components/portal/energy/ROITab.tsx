import React, { useState, useEffect } from 'react';
import { TrendingUp, DollarSign, Clock, BarChart3, Plus, AlertCircle, ArrowRight, Loader2, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const REQUIRED_FIELDS = ['heated_area_m2', 'year_built', 'dwelling_type'];
const SEMANTIC_LABELS: Record<string, { sv: string; en: string }> = {
  heated_area_m2: { sv: 'Uppvärmd yta (m²)', en: 'Heated Area (m²)' },
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
  const { toast } = useToast();
  const navigate = useNavigate();
  const [hardwareCost, setHardwareCost] = useState(50000);
  const [installCost, setInstallCost] = useState(15000);
  const [monthlySubscription, setMonthlySubscription] = useState(299);
  const [addPropertyOpen, setAddPropertyOpen] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [homeName, setHomeName] = useState<string>('');
  const [checkingFields, setCheckingFields] = useState(true);

  // Model run data
  const [dumbRun, setDumbRun] = useState<Record<string, any> | null>(null);
  const [smartRun, setSmartRun] = useState<Record<string, any> | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);

  // Check missing fields for ROI
  useEffect(() => {
    if (!homeId) { setCheckingFields(false); return; }
    const checkFields = async () => {
      setCheckingFields(true);
      const { data: home } = await supabase.from('homes').select('name').eq('id', homeId).single();
      if (home) setHomeName(home.name);

      const { data: questions } = await supabase
        .from('home_questions')
        .select('id, semantic_key')
        .in('semantic_key', REQUIRED_FIELDS);

      if (!questions) { setCheckingFields(false); return; }

      const { data: answers } = await supabase
        .from('home_answers')
        .select('question_id, answer_value')
        .eq('home_id', homeId);

      const answeredIds = new Set((answers || []).filter(a => a.answer_value != null).map(a => a.question_id));
      const missing = questions.filter(q => !answeredIds.has(q.id)).map(q => q.semantic_key!).filter(Boolean);
      setMissingFields(missing);
      setCheckingFields(false);
    };
    checkFields();
  }, [homeId]);

  // Fetch latest model_runs for dumb and smart scenarios
  useEffect(() => {
    if (!homeId) { setLoadingRuns(false); return; }
    const fetchRuns = async () => {
      setLoadingRuns(true);
      const { data: runs } = await supabase
        .from('model_runs')
        .select('scenario, results_summary')
        .eq('home_id', homeId)
        .order('created_at', { ascending: false });

      const dumb = runs?.find(r => r.scenario === 'dumb') || null;
      const smart = runs?.find(r => r.scenario === 'smart') || null;
      setDumbRun(dumb ? (dumb.results_summary as Record<string, any>) : null);
      setSmartRun(smart ? (smart.results_summary as Record<string, any>) : null);
      setLoadingRuns(false);
    };
    fetchRuns();
  }, [homeId]);

  const handleCreateProperty = async () => {
    if (!newPropertyName.trim() || !customerId) return;
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from('homes')
        .insert({ customer_id: customerId, name: newPropertyName.trim() })
        .select('id')
        .single();
      if (error) throw error;
      toast({ title: t('Fastighet skapad!', 'Property created!') });
      setAddPropertyOpen(false);
      setNewPropertyName('');
      navigate(`/portal/home-profile?home=${data.id}`);
    } catch (err) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const hasBothRuns = dumbRun != null && smartRun != null;
  const missingRuns = !loadingRuns && !hasBothRuns;

  const annualCostDumb = dumbRun?.annualCostSek ?? 0;
  const annualCostSmart = smartRun?.annualCostSek ?? 0;
  const annualSavings = hasBothRuns ? annualCostDumb - annualCostSmart : 0;
  const totalInvestment = hardwareCost + installCost;
  const annualSubscription = monthlySubscription * 12;
  const netAnnualSavings = annualSavings - annualSubscription;
  const paybackYears = netAnnualSavings > 0 ? totalInvestment / netAnnualSavings : Infinity;

  const costBreakdown = hasBothRuns ? [
    { name: t('Nätavgift', 'Network Fee'), dumb: dumbRun.annualNetworkCost ?? 0, smart: smartRun.annualNetworkCost ?? 0 },
    { name: t('Energi', 'Energy'), dumb: dumbRun.annualEnergyCost ?? 0, smart: smartRun.annualEnergyCost ?? 0 },
    { name: t('Fast avgift', 'Fixed Fee'), dumb: dumbRun.annualFixedCost ?? 0, smart: smartRun.annualFixedCost ?? 0 },
  ] : [];

  const scenarioComparison = [
    { label: t('Årlig kostnad (Dum)', 'Annual Cost (Dumb)'), value: hasBothRuns ? `${annualCostDumb.toLocaleString()} SEK` : '—' },
    { label: t('Årlig kostnad (Smart)', 'Annual Cost (Smart)'), value: hasBothRuns ? `${annualCostSmart.toLocaleString()} SEK` : '—' },
    { label: t('Årlig besparing', 'Annual Savings'), value: hasBothRuns ? `${annualSavings.toLocaleString()} SEK` : '—' },
    { label: t('Abonnemang/år', 'Subscription/yr'), value: `${annualSubscription.toLocaleString()} SEK` },
    { label: t('Nettobesparing/år', 'Net Savings/yr'), value: hasBothRuns ? `${netAnnualSavings.toLocaleString()} SEK` : '—' },
    { label: t('Återbetalningstid', 'Payback Period'), value: !hasBothRuns ? '—' : paybackYears === Infinity ? '—' : `${paybackYears.toFixed(1)} ${t('år', 'years')}` },
  ];

  if (!homeId) {
    return (
      <div className="flex items-center justify-center min-h-[300px] text-muted-foreground">
        <p>{t('Välj ett hem för att se lönsamhet.', 'Select a home to view ROI.')}</p>
      </div>
    );
  }

  const hasMissingFields = missingFields.length > 0 && !checkingFields;

  return (
    <div className="space-y-6">
      {homeCount <= 1 && homeName && (
        <p className="text-sm text-muted-foreground">
          {t('Lönsamhet för', 'ROI for')}: {homeName}
        </p>
      )}

      {/* Missing fields panel */}
      {hasMissingFields && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-primary mt-0.5 shrink-0" />
              <div className="space-y-3 flex-1">
                <p className="font-medium text-sm">
                  {t('Några detaljer behövs för att beräkna lönsamhet', 'A few details needed to calculate ROI')}
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

      {/* Missing runs banner */}
      {missingRuns && !hasMissingFields && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <Play className="w-5 h-5 text-primary mt-0.5 shrink-0" />
              <div className="space-y-2 flex-1">
                <p className="font-medium text-sm">
                  {t(
                    'Kör båda Dum och Smart simuleringar för att beräkna lönsamhet.',
                    'Run both Dumb and Smart simulations to calculate ROI.'
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {!dumbRun && !smartRun
                    ? t('Inga simuleringar hittades.', 'No simulations found.')
                    : !dumbRun
                      ? t('Dum-scenario saknas.', 'Dumb scenario missing.')
                      : t('Smart-scenario saknas.', 'Smart scenario missing.')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ROI content */}
      <div className={hasMissingFields || missingRuns ? 'opacity-50 pointer-events-none' : ''}>
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
                  <p className="text-xl font-semibold">{!hasBothRuns ? '—' : paybackYears === Infinity ? '—' : `${paybackYears.toFixed(1)} ${t('år', 'yr')}`}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>


        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-4">
          {/* Cost breakdown chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4" />
                {t('Kostnadsfördelning', 'Cost Breakdown')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {costBreakdown.length > 0 ? (
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
              ) : (
                <div className="flex items-center justify-center h-[300px] text-sm text-muted-foreground">
                  {t('Kör simuleringar för att se data', 'Run simulations to see data')}
                </div>
              )}
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

      {/* Add Property Dialog */}
      <Dialog open={addPropertyOpen} onOpenChange={setAddPropertyOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('Lägg till en annan fastighet', 'Add another property')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t('Fastighetens namn', 'Property name')}</Label>
              <Input
                value={newPropertyName}
                onChange={e => setNewPropertyName(e.target.value)}
                placeholder={t('t.ex. Sommarhus, Hyreslägenhet', 'e.g. Summer house, Rental apartment')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddPropertyOpen(false)}>{t('Avbryt', 'Cancel')}</Button>
            <Button onClick={handleCreateProperty} disabled={creating || !newPropertyName.trim()}>
              {creating && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              {t('Börja inställning', 'Start setup')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ROITab;
