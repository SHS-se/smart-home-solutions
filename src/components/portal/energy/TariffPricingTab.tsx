import React, { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface TariffRule {
  id: string;
  provider: string;
  name: string;
  rule_type: string;
  params: Record<string, unknown>;
}

interface TariffPricingTabProps {
  customerId: string;
}

const TariffPricingTab: React.FC<TariffPricingTabProps> = ({ customerId }) => {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState<TariffRule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState('');

  const [networkPrice, setNetworkPrice] = useState('0.045');
  const [fixedFee, setFixedFee] = useState('0');
  const [energyPriceModel, setEnergyPriceModel] = useState('fixed');
  const [energyPrice, setEnergyPrice] = useState('1.50');
  const [instanceId, setInstanceId] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const [rulesRes, settingsRes] = await Promise.all([
          supabase.from('tariff_rules').select('id, provider, name, rule_type, params').eq('is_active', true),
          supabase.from('energy_home_settings').select('id, tariff_instance_id').eq('customer_id', customerId).maybeSingle(),
        ]);

        if (rulesRes.data) {
          setRules(rulesRes.data as unknown as TariffRule[]);
          if (rulesRes.data.length > 0) setSelectedRuleId(rulesRes.data[0].id);
        }

        if (settingsRes.data?.tariff_instance_id) {
          const { data: instance } = await supabase
            .from('tariff_instances')
            .select('*')
            .eq('id', settingsRes.data.tariff_instance_id)
            .maybeSingle();
          if (instance) {
            setInstanceId(instance.id);
            setSelectedRuleId(instance.tariff_rule_id);
            setNetworkPrice(String(instance.network_price_sek_per_w_month));
            setFixedFee(String(instance.fixed_monthly_fee_sek));
            setEnergyPriceModel(instance.energy_price_model);
            setEnergyPrice(String(instance.energy_price_sek_per_kwh));
          }
        }
      } catch (err) {
        console.error('Error loading tariff:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [customerId]);

  const selectedRule = rules.find(r => r.id === selectedRuleId);

  // Mock monthly peak data for chart
  const monthlyPeakData = Array.from({ length: 12 }, (_, i) => ({
    month: ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'][i],
    peak: Math.round(3000 + Math.random() * 5000 + (i < 3 || i > 9 ? 4000 : 0)),
  }));

  const handleSave = async () => {
    if (!user || !selectedRuleId) return;
    setSaving(true);
    try {
      const payload = {
        customer_id: customerId,
        tariff_rule_id: selectedRuleId,
        title: selectedRule?.name || 'Custom',
        network_price_sek_per_w_month: Number(networkPrice),
        fixed_monthly_fee_sek: Number(fixedFee),
        energy_price_model: energyPriceModel,
        energy_price_sek_per_kwh: Number(energyPrice),
      };

      let newInstanceId = instanceId;
      if (instanceId) {
        const { error } = await supabase.from('tariff_instances').update(payload).eq('id', instanceId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from('tariff_instances').insert(payload).select('id').single();
        if (error) throw error;
        newInstanceId = data.id;
        setInstanceId(data.id);
      }

      // Link to energy_home_settings
      if (newInstanceId) {
        await supabase
          .from('energy_home_settings')
          .update({ tariff_instance_id: newInstanceId })
          .eq('customer_id', customerId);
      }

      toast({ title: t('Sparat!', 'Saved!') });
    } catch (err) {
      toast({ title: t('Fel', 'Error'), description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center min-h-[300px]"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-6">
        {/* Tariff rule selector */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('Tariffnätsregel', 'Tariff Rule')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select value={selectedRuleId} onValueChange={setSelectedRuleId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {rules.map(r => (
                  <SelectItem key={r.id} value={r.id}>{r.provider} – {r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRule && (
              <div className="text-sm space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Typ', 'Type')}</span><Badge variant="outline">{selectedRule.rule_type}</Badge></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t('Leverantör', 'Provider')}</span><span>{selectedRule.provider}</span></div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pricing inputs */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('Prissättning', 'Pricing')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm">{t('Nätavgift (SEK/W/mån)', 'Network Price (SEK/W/month)')}</Label>
              <Input type="number" step="0.001" value={networkPrice} onChange={e => setNetworkPrice(e.target.value)} />
            </div>
            <div>
              <Label className="text-sm">{t('Fast månadsavgift (SEK)', 'Fixed Monthly Fee (SEK)')}</Label>
              <Input type="number" value={fixedFee} onChange={e => setFixedFee(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">{t('Energiprismodell', 'Energy Price Model')}</Label>
              <RadioGroup value={energyPriceModel} onValueChange={setEnergyPriceModel}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="fixed" id="ep-fixed" />
                  <Label htmlFor="ep-fixed" className="text-sm cursor-pointer">{t('Fast pris', 'Fixed Price')}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="spot" id="ep-spot" />
                  <Label htmlFor="ep-spot" className="text-sm cursor-pointer">{t('Spotpris', 'Spot Price')}</Label>
                </div>
              </RadioGroup>
            </div>
            <div>
              <Label className="text-sm">{t('Energipris (SEK/kWh)', 'Energy Price (SEK/kWh)')}</Label>
              <Input type="number" step="0.01" value={energyPrice} onChange={e => setEnergyPrice(e.target.value)} />
            </div>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              <Save className="w-4 h-4 mr-2" />
              {t('Spara', 'Save')}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Monthly peak chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('Månatlig toppeffekt', 'Monthly Peak Power')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={monthlyPeakData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" className="text-xs" />
              <YAxis tickFormatter={v => `${(v / 1000).toFixed(1)}`} label={{ value: 'kW', angle: -90, position: 'insideLeft' }} className="text-xs" />
              <Tooltip formatter={(v: number) => [`${(v / 1000).toFixed(1)} kW`, t('Topp', 'Peak')]} />
              <Bar dataKey="peak" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-muted-foreground mt-2">
            {t('Simulerad toppeffekt per månad (exempeldata)', 'Simulated monthly peak power (example data)')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default TariffPricingTab;
