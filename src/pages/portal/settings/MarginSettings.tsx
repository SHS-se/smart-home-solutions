import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import PortalLayout from '@/components/portal/PortalLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Settings2, Info, Save } from 'lucide-react';
import { toast } from '@/hooks/use-toast';

interface MarginRule {
  category: string;
  description: string | null;
  margin_percent: number;
  rounding: number;
}

const ROUNDING_OPTIONS = [1, 5, 10, 50, 100];

const MarginSettings: React.FC = () => {
  const { t } = useLanguage();
  const { isStaff, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  
  const [localRules, setLocalRules] = React.useState<MarginRule[]>([]);
  const [hasChanges, setHasChanges] = React.useState(false);

  // Fetch margin rules
  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['margin_rules'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('margin_rules')
        .select('*')
        .order('category');
      if (error) throw error;
      return data as MarginRule[];
    },
    enabled: isStaff,
  });

  // Sync local state with fetched data
  React.useEffect(() => {
    if (rules.length > 0) {
      setLocalRules(rules);
      setHasChanges(false);
    }
  }, [rules]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      for (const rule of localRules) {
        const { error } = await supabase
          .from('margin_rules')
          .update({ 
            margin_percent: rule.margin_percent, 
            rounding: rule.rounding 
          })
          .eq('category', rule.category);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['margin_rules'] });
      setHasChanges(false);
      toast({ title: t('Ändringar sparade', 'Changes saved') });
    },
    onError: (error: any) => {
      toast({ title: t('Kunde inte spara', 'Failed to save'), description: error.message, variant: 'destructive' });
    },
  });

  const handleChange = (category: string, field: 'margin_percent' | 'rounding', value: number) => {
    setLocalRules(prev => 
      prev.map(rule => 
        rule.category === category ? { ...rule, [field]: value } : rule
      )
    );
    setHasChanges(true);
  };

  // Calculate example prices
  const calculateExample = (cost: number, marginPercent: number, rounding: number) => {
    const rawPrice = cost * (1 + marginPercent / 100);
    const marginAmount = cost * (marginPercent / 100);
    const beforeRounding = rawPrice;
    const afterRounding = Math.round(rawPrice / rounding) * rounding;
    return { marginAmount, beforeRounding, afterRounding };
  };

  // Redirect if not staff
  if (!authLoading && !isStaff) {
    navigate('/portal');
    return null;
  }

  const exampleCosts = [
    { category: 'Sensorer', cost: 145, marginPercent: 35 },
    { category: 'Controllers', cost: 1250, marginPercent: 25 },
    { category: 'Material', cost: 890, marginPercent: 60 },
  ];

  return (
    <PortalLayout>
      <div className="space-y-6 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Settings2 className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">{t('Marginalregler', 'Margin Rules')}</h1>
            <p className="text-muted-foreground">
              {t('Automatiska prisberäkningar baserat på kategori och marginal', 
                 'Automatic price calculations based on category and margin')}
            </p>
          </div>
        </div>

        {/* Info Card */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <Info className="h-5 w-5 text-primary mt-0.5" />
              <div className="text-sm space-y-1">
                <p className="font-medium">{t('Hur det fungerar', 'How it works')}:</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  <li>{t('När du lägger till en SKU beräknas säljpriset automatiskt från kostnad + marginal', 
                        'When you add a SKU, the sell price is automatically calculated from cost + margin')}</li>
                  <li>{t('Säljpriset avrundas till närmaste {avrundning} SEK för snyggare prissättning', 
                        'The sell price is rounded to the nearest {rounding} SEK for cleaner pricing')}</li>
                  <li>{t('Du kan alltid justera säljpriset manuellt i BOM Builder', 
                        'You can always adjust the sell price manually in BOM Builder')}</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Formula Card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('Formel', 'Formula')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted p-4 rounded-lg font-mono text-sm">
              <span className="text-primary">Säljpris</span> = Kostnad × (1 + Marginal%) → Avrundas till närmaste {'{avrundning}'} kr
            </div>
            <p className="text-sm text-muted-foreground mt-3">
              {t('Exempel: Sensor kostar 145 kr, marginal 35%, avrundning 5 kr', 
                 'Example: Sensor costs 145 kr, margin 35%, rounding 5 kr')}<br />
              → 145 × 1.35 = 195.75 kr → avrundas till <span className="font-medium text-foreground">195 kr</span>
            </p>
          </CardContent>
        </Card>

        {/* Rules Table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('Kategoriregler', 'Category Rules')}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-center py-8 text-muted-foreground">{t('Laddar...', 'Loading...')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs uppercase">{t('Kategori', 'Category')}</TableHead>
                    <TableHead className="text-xs uppercase">{t('Beskrivning', 'Description')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Standard marginal (%)', 'Standard Margin (%)')}</TableHead>
                    <TableHead className="text-xs uppercase text-center">{t('Avrundning (SEK)', 'Rounding (SEK)')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {localRules.map(rule => (
                    <TableRow key={rule.category}>
                      <TableCell className="font-medium">{rule.category}</TableCell>
                      <TableCell className="text-muted-foreground">{rule.description}</TableCell>
                      <TableCell className="text-center">
                        <Input
                          type="number"
                          value={rule.margin_percent}
                          onChange={(e) => handleChange(rule.category, 'margin_percent', parseFloat(e.target.value) || 0)}
                          className="w-20 text-center mx-auto"
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <Select
                          value={rule.rounding.toString()}
                          onValueChange={(value) => handleChange(rule.category, 'rounding', parseInt(value))}
                        >
                          <SelectTrigger className="w-24 mx-auto">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROUNDING_OPTIONS.map(opt => (
                              <SelectItem key={opt} value={opt.toString()}>{opt}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Example Calculations */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('Exempel på beräkningar', 'Example Calculations')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {localRules.slice(0, 3).map(rule => {
                const exampleCost = rule.category === 'Sensorer' ? 145 
                  : rule.category === 'Controllers' ? 1250 
                  : rule.category === 'Material' ? 890 
                  : 100;
                const calc = calculateExample(exampleCost, rule.margin_percent, rule.rounding);
                
                return (
                  <div key={rule.category} className="bg-muted/50 p-4 rounded-lg">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
                      {rule.category} ({rule.margin_percent}%)
                    </p>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('Kostnad', 'Cost')}:</span>
                        <span>{exampleCost} kr</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">+ {rule.margin_percent}% marginal:</span>
                        <span>{calc.marginAmount.toFixed(2)} kr</span>
                      </div>
                      <div className="flex justify-between text-muted-foreground">
                        <span>= Före avrundning:</span>
                        <span>{calc.beforeRounding.toFixed(2)} kr</span>
                      </div>
                      <div className="flex justify-between pt-2 border-t border-border">
                        <span className="font-medium">{t('Säljpris', 'Sell Price')}:</span>
                        <span className="font-bold text-primary">{calc.afterRounding} kr</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t('Avrundat till närmaste', 'Rounded to nearest')} {rule.rounding} kr
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end">
          <Button 
            size="lg" 
            onClick={() => saveMutation.mutate()}
            disabled={!hasChanges || saveMutation.isPending}
          >
            <Save className="h-4 w-4 mr-2" />
            {saveMutation.isPending ? t('Sparar...', 'Saving...') : t('Spara ändringar', 'Save changes')}
          </Button>
        </div>
      </div>
    </PortalLayout>
  );
};

export default MarginSettings;
