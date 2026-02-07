import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

interface QuoteLine {
  id: string;
  section: string;
  description: string;
  quantity: number;
  unit_price_ex_vat: number | null;
  unit_price_inc_vat: number | null;
  vat_rate: number | null;
}

interface ComputedTotals {
  hardware_total: number | null;
  labor_total: number | null;
  travel_total: number | null;
  subtotal_ex_vat: number | null;
  vat_total: number | null;
  total_inc_vat: number | null;
}

interface OfferLineBreakdownProps {
  lines: QuoteLine[];
  totals: ComputedTotals | null;
  t: (sv: string, en: string) => string;
}

const formatSEK = (amount: number | null) => {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(amount)) + ' kr';
};

const SectionBlock: React.FC<{
  title: string;
  items: QuoteLine[];
  sectionTotal: number | null;
}> = ({ title, items, sectionTotal }) => {
  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
        {title}
      </h4>
      <div className="space-y-1">
        {items.map((item) => {
          const lineTotal = (item.unit_price_ex_vat ?? 0) * item.quantity;
          return (
            <div key={item.id} className="flex justify-between items-center text-sm py-1">
              <span className="flex-1">
                {item.description}
                {item.quantity > 1 && (
                  <span className="text-muted-foreground ml-1">× {item.quantity}</span>
                )}
              </span>
              <span className="font-medium ml-4 tabular-nums">{formatSEK(lineTotal)}</span>
            </div>
          );
        })}
      </div>
      {sectionTotal !== null && (
        <div className="flex justify-between text-sm font-medium pt-1 border-t border-border/50">
          <span className="text-muted-foreground">{title}</span>
          <span className="tabular-nums">{formatSEK(sectionTotal)}</span>
        </div>
      )}
    </div>
  );
};

const OfferLineBreakdown: React.FC<OfferLineBreakdownProps> = ({ lines, totals, t }) => {
  const hardwareItems = lines.filter((l) => l.section === 'hardware');
  const laborItems = lines.filter((l) => l.section === 'labor');
  const travelItems = lines.filter((l) => l.section === 'travel');
  const otherItems = lines.filter(
    (l) => !['hardware', 'labor', 'travel'].includes(l.section)
  );

  if (lines.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('Specifikation', 'Specification')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t('Inga rader att visa.', 'No items to display.')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t('Specifikation', 'Specification')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <SectionBlock
          title={t('Hårdvara', 'Hardware')}
          items={hardwareItems}
          sectionTotal={totals?.hardware_total ?? null}
        />

        <SectionBlock
          title={t('Arbete', 'Labor')}
          items={laborItems}
          sectionTotal={totals?.labor_total ?? null}
        />

        <SectionBlock
          title={t('Resa & övrigt', 'Travel & other')}
          items={travelItems}
          sectionTotal={totals?.travel_total ?? null}
        />

        {otherItems.length > 0 && (
          <SectionBlock
            title={t('Övrigt', 'Other')}
            items={otherItems}
            sectionTotal={null}
          />
        )}

        {/* Totals summary */}
        <Separator />
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Summa exkl. moms', 'Subtotal excl. VAT')}</span>
            <span className="tabular-nums">{formatSEK(totals?.subtotal_ex_vat ?? null)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Moms (25%)', 'VAT (25%)')}</span>
            <span className="tabular-nums">{formatSEK(totals?.vat_total ?? null)}</span>
          </div>
          <Separator />
          <div className="flex justify-between text-lg font-bold">
            <span>{t('Totalt inkl. moms', 'Total incl. VAT')}</span>
            <span className="text-primary tabular-nums">{formatSEK(totals?.total_inc_vat ?? null)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default OfferLineBreakdown;
