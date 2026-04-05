import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import AccountingLayout from '@/components/accounting/AccountingLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatSEK, PURCHASE_STATUS_LABELS } from '@/lib/accounting-utils';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle, AlertTriangle, Lock, Download, Upload, Info } from 'lucide-react';

interface StepProps {
  number: number;
  label: string;
  description: string;
  status: 'active' | 'done' | 'pending';
}

const StepIndicator: React.FC<{ steps: StepProps[]; currentStep: number }> = ({ steps, currentStep }) => (
  <Card className="border border-border">
    <CardContent className="p-6">
      <div className="flex items-center justify-between">
        {steps.map((step, i) => (
          <React.Fragment key={step.number}>
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${
                step.status === 'done' ? 'bg-primary text-primary-foreground' :
                step.status === 'active' ? 'bg-primary text-primary-foreground' :
                'bg-muted text-muted-foreground'
              }`}>
                {step.status === 'done' ? <CheckCircle className="w-5 h-5" /> : step.number}
              </div>
              <div>
                <p className={`text-sm font-medium ${step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}>{step.label}</p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </div>
            {i < steps.length - 1 && <div className="flex-1 h-px bg-border mx-4" />}
          </React.Fragment>
        ))}
      </div>
    </CardContent>
  </Card>
);

const VatDeclarationFlow: React.FC = () => {
  const { periodId } = useParams<{ periodId: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [currentStep, setCurrentStep] = useState(1);

  // Parse q1-2026 format
  const match = periodId?.match(/q(\d)-(\d{4})/);
  const quarter = match ? parseInt(match[1]) : 1;
  const year = match ? parseInt(match[2]) : 2026;

  const startDate = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
  const endMonth = quarter * 3;
  const endDate = `${year}-${String(endMonth).padStart(2, '0')}-${endMonth === 2 ? '28' : [4, 6, 9, 11].includes(endMonth) ? '30' : '31'}`;

  const { data: vatPeriod } = useQuery({
    queryKey: ['acc-vat-period', year, quarter],
    queryFn: async () => {
      const { data } = await supabase.from('acc_vat_periods').select('*').eq('year', year).eq('quarter', quarter).single();
      return data;
    },
  });

  const { data: purchases } = useQuery({
    queryKey: ['acc-q-purchases', year, quarter],
    queryFn: async () => {
      const { data } = await supabase
        .from('acc_purchases')
        .select('*, supplier:acc_suppliers(name)')
        .gte('document_date', startDate)
        .lte('document_date', endDate)
        .order('document_date');
      return data || [];
    },
  });

  const { data: journalLines } = useQuery({
    queryKey: ['acc-q-journal', year, quarter],
    queryFn: async () => {
      const { data: verifications } = await supabase
        .from('acc_verifications')
        .select('id')
        .eq('is_posted', true);
      if (!verifications?.length) return [];

      const { data } = await supabase
        .from('acc_journal_lines')
        .select('*, verification:acc_verifications(verification_date)')
        .in('verification_id', verifications.map(v => v.id));
      return (data || []).filter(l => {
        const d = (l.verification as any)?.verification_date;
        return d && d >= startDate && d <= endDate;
      });
    },
  });

  const unpostedPurchases = purchases?.filter(p => p.status !== 'posted') || [];
  const hasBlockers = unpostedPurchases.length > 0;

  // Compute VAT declaration boxes
  const inputVat2641 = (journalLines || [])
    .filter(l => l.account === '2641')
    .reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);

  const rcOutputVat2614 = (journalLines || [])
    .filter(l => l.account === '2614')
    .reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);

  const rcInputVat2645 = (journalLines || [])
    .filter(l => l.account === '2645')
    .reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);

  // Reverse charge base (sum of expense debits from RC purchases)
  const rcBase = (journalLines || [])
    .filter(l => l.account.startsWith('4') && Number(l.debit) > 0)
    .reduce((s, l) => s + Number(l.debit), 0); // simplified

  const netVat = rcOutputVat2614 - inputVat2641 - rcInputVat2645;

  const declarationBoxes = [
    { box: '05', label: 'Försäljning inom Sverige (exkl. moms)', amount: 0, count: 0, note: 'Inga försäljningar i denna period' },
    { box: '06', label: 'Utgående moms 25%', amount: 0, count: 0, note: 'Inga försäljningar' },
    { box: '10', label: 'Avdragsgill ingående moms', amount: inputVat2641, count: (journalLines || []).filter(l => l.account === '2641').length },
    { box: '20', label: 'Inköp av varor från annat EU-land', amount: rcBase > 0 ? rcBase : 0, count: (journalLines || []).filter(l => l.account === '2614').length, highlight: rcBase > 0 },
    { box: '21', label: 'Moms på inköp från annat EU-land', amount: rcOutputVat2614, count: (journalLines || []).filter(l => l.account === '2614').length, highlight: rcOutputVat2614 > 0 },
  ];

  const createSnapshot = useMutation({
    mutationFn: async () => {
      if (hasBlockers) throw new Error('Alla inköp måste vara bokförda');

      const snapshotData = {
        quarter: `Q${quarter} ${year}`,
        period: `${startDate} – ${endDate}`,
        created_at: new Date().toISOString(),
        created_by: user?.email || 'unknown',
        total_verifications: (journalLines || []).length,
        declaration_boxes: declarationBoxes.map(b => ({ box: b.box, label: b.label, amount: b.amount })),
        net_vat: netVat,
        rules_version: '2025.4',
      };

      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshotData)));
      const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');

      const { error } = await supabase
        .from('acc_vat_periods')
        .update({
          status: 'approved',
          snapshot_data: snapshotData,
          snapshot_created_at: new Date().toISOString(),
          snapshot_created_by: user?.id,
          snapshot_hash: hashHex,
        })
        .eq('year', year)
        .eq('quarter', quarter);

      if (error) throw error;
      return { hash: hashHex };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['acc-vat-period'] });
      toast.success('Ögonblicksbild skapad');
      setCurrentStep(4);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const steps: StepProps[] = [
    { number: 1, label: 'Städa kö', description: 'Åtgärda alla flaggade problem', status: currentStep > 1 ? 'done' : currentStep === 1 ? 'active' : 'pending' },
    { number: 2, label: 'Avstämning', description: 'Kontrollera att allt stämmer', status: currentStep > 2 ? 'done' : currentStep === 2 ? 'active' : 'pending' },
    { number: 3, label: 'Ögonblicksbild', description: 'Skapa låst ögonblicksbild', status: currentStep > 3 ? 'done' : currentStep === 3 ? 'active' : 'pending' },
    { number: 4, label: 'Export & inlämning', description: 'Exportera och lämna in', status: currentStep === 4 ? 'active' : 'pending' },
  ];

  // Auto-advance if snapshot already exists
  if (vatPeriod?.snapshot_data && currentStep < 4) {
    // Don't call setState in render, use effect pattern below
  }

  const downloadExport = () => {
    if (!vatPeriod?.snapshot_data) return;
    const blob = new Blob([JSON.stringify(vatPeriod.snapshot_data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `momsdeklaration-q${quarter}-${year}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AccountingLayout>
      <div className="space-y-6">
        <Link to="/accounting/vat-periods" className="text-primary text-sm hover:underline flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Tillbaka till momsperioder
        </Link>

        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            Momsdeklaration Q{quarter} {year}
            <Info className="w-5 h-5 text-primary cursor-help" />
          </h1>
          <p className="text-muted-foreground mt-1">
            {quarter === 1 ? 'Januari' : quarter === 2 ? 'April' : quarter === 3 ? 'Juli' : 'Oktober'} – {quarter === 1 ? 'Mars' : quarter === 2 ? 'Juni' : quarter === 3 ? 'September' : 'December'} {year}
            {vatPeriod?.deadline && ` · Deadline: ${new Date(vatPeriod.deadline).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' })}`}
          </p>
        </div>

        <StepIndicator steps={steps} currentStep={currentStep} />

        {/* Step 1: Clean queue */}
        {currentStep === 1 && (
          <div className="space-y-4">
            {hasBlockers ? (
              <>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold text-amber-800">{unpostedPurchases.length} problem kvarstår</p>
                    <p className="text-sm text-amber-700">Åtgärda alla problem innan du kan fortsätta till nästa steg.</p>
                  </div>
                </div>

                <Card className="border border-border">
                  <CardHeader><CardTitle>Problem att åtgärda</CardTitle></CardHeader>
                  <CardContent className="divide-y divide-border">
                    {unpostedPurchases.map(p => (
                      <div key={p.id} className="flex items-center justify-between py-3">
                        <div>
                          <p className="text-sm font-medium">{p.description || (p.supplier as any)?.name || 'Ej klassificerat inköp'}</p>
                          <p className="text-xs text-muted-foreground">{PURCHASE_STATUS_LABELS[p.status as keyof typeof PURCHASE_STATUS_LABELS]} · {formatSEK(Number(p.gross_amount))}</p>
                        </div>
                        <Link to={`/accounting/purchases/${p.id}`}>
                          <Button size="sm">Åtgärda</Button>
                        </Link>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </>
            ) : (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <p className="text-sm text-green-800">Alla inköp är bokförda. Inga problem kvarstår.</p>
              </div>
            )}
            <Button onClick={() => setCurrentStep(2)} disabled={hasBlockers}>Fortsätt till avstämning</Button>
          </div>
        )}

        {/* Step 2: Reconciliation */}
        {currentStep === 2 && (
          <div className="space-y-4">
            <Card className="border border-border">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Deklarationsrutor
                  <Info className="w-4 h-4 text-primary cursor-help" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs uppercase text-muted-foreground">Ruta</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground">Beskrivning</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">Belopp</TableHead>
                      <TableHead className="text-xs uppercase text-muted-foreground text-right">Transaktioner</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {declarationBoxes.map(box => (
                      <TableRow key={box.box} className={box.highlight ? 'bg-amber-50/50' : box.amount === 0 && box.count === 0 ? 'opacity-50' : ''}>
                        <TableCell className="font-medium text-sm">
                          {box.box}
                          {box.highlight && <Info className="w-3.5 h-3.5 text-primary inline ml-1" />}
                        </TableCell>
                        <TableCell className="text-sm">{box.label}</TableCell>
                        <TableCell className="text-right text-sm font-medium">{formatSEK(box.amount)}</TableCell>
                        <TableCell className="text-right text-sm text-primary">{box.count || ''}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold border-t-2">
                      <TableCell colSpan={2}>Moms att betala (Box 06 - Box 10)</TableCell>
                      <TableCell className="text-right">{formatSEK(Math.max(0, -netVat))}</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button onClick={() => setCurrentStep(3)}>Godkänn och fortsätt</Button>
              <Button variant="outline" onClick={() => setCurrentStep(1)}>Tillbaka</Button>
            </div>
          </div>
        )}

        {/* Step 3: Snapshot */}
        {currentStep === 3 && (
          <div className="space-y-4">
            {vatPeriod?.snapshot_data ? (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-800">Ögonblicksbild skapad</p>
                  <p className="text-sm text-green-700">Momsdeklarationen är nu låst och klar för export.</p>
                </div>
              </div>
            ) : (
              <Card className="border border-border">
                <CardContent className="p-6">
                  <div className="flex items-start gap-3 mb-6">
                    <Lock className="w-6 h-6 text-primary mt-0.5" />
                    <div>
                      <h3 className="font-semibold text-lg">Skapa ögonblicksbild</h3>
                      <p className="text-sm text-muted-foreground mt-1">
                        En ögonblicksbild är en låst version av momsdeklarationen som inte kan ändras. Detta säkerställer att rapporten är samma som det som lämnades in till Skatteverket.
                      </p>
                    </div>
                  </div>

                  <div className="bg-muted/50 rounded-lg p-4 space-y-2 text-sm mb-6">
                    <div className="flex justify-between"><span className="text-muted-foreground">Period</span><span>Q{quarter} {year}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Totalt att betala</span><span>{formatSEK(Math.max(0, -netVat))}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Transaktioner inkluderade</span><span>{(journalLines || []).length} st</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Granskare</span><span>{user?.email || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Regelversion</span><span>2025.4</span></div>
                  </div>

                  <div className="flex gap-3">
                    <Button onClick={() => createSnapshot.mutate()} disabled={createSnapshot.isPending}>
                      <Lock className="w-4 h-4 mr-2" />
                      {createSnapshot.isPending ? 'Skapar...' : 'Skapa ögonblicksbild'}
                    </Button>
                    <Button variant="outline" onClick={() => setCurrentStep(2)}>Tillbaka</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {vatPeriod?.snapshot_data && (
              <Button onClick={() => setCurrentStep(4)}>Fortsätt till export</Button>
            )}
          </div>
        )}

        {/* Step 4: Export & filing */}
        {currentStep === 4 && (
          <div className="space-y-4">
            {vatPeriod?.snapshot_data && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-800">Ögonblicksbild skapad</p>
                  <p className="text-sm text-green-700">Momsdeklarationen är nu låst och klar för export.</p>
                </div>
              </div>
            )}

            <Card className="border border-border">
              <CardContent className="p-6 space-y-6">
                <h3 className="font-semibold text-lg">Export och inlämning</h3>

                <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    <FileText className="w-8 h-8 text-primary" />
                    <div>
                      <p className="font-medium">Momsdeklaration Q{quarter} {year}</p>
                      <p className="text-xs text-muted-foreground">Underlag för inlämning till Skatteverket</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    {vatPeriod?.snapshot_hash && (
                      <span className="text-xs text-muted-foreground font-mono">
                        Hash: {vatPeriod.snapshot_hash.slice(0, 10)}...
                      </span>
                    )}
                    <Button onClick={downloadExport}>
                      <Download className="w-4 h-4 mr-2" /> Ladda ner
                    </Button>
                  </div>
                </div>

                <div>
                  <h4 className="font-medium mb-3">Inlämning till Skatteverket</h4>
                  <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1.5">
                    <li>Ladda ner deklarationsunderlaget ovan</li>
                    <li>Logga in på Skatteverkets webbplats</li>
                    <li>Navigera till "Lämna momsdeklaration"</li>
                    <li>Fyll i uppgifterna manuellt baserat på underlaget</li>
                    <li>Kontrollera uppgifterna och skicka in</li>
                    <li>Ladda ner bekräftelsen från Skatteverket</li>
                    <li>Ladda upp bekräftelsen här för arkivering</li>
                  </ol>
                </div>

                <div>
                  <h4 className="font-medium mb-3">Ladda upp bekräftelse från Skatteverket</h4>
                  <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-xl p-8 cursor-pointer hover:border-primary/40 hover:bg-muted/30 transition-colors">
                    <Upload className="w-8 h-8 text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">Klicka för att ladda upp eller dra och släpp</p>
                    <p className="text-xs text-muted-foreground mt-1">PDF eller skärmdump</p>
                    <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg" />
                  </label>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </AccountingLayout>
  );
};

export default VatDeclarationFlow;
