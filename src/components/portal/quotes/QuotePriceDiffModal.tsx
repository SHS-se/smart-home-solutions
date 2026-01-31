import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/contexts/LanguageContext';

interface PriceDiffItem {
  sku_id: string;
  sku_name: string;
  sku_code: string;
  quantity: number;
  old_unit_price: number;
  new_unit_price: number;
  delta_per_unit: number;
  delta_total: number;
}

interface PriceDiffResult {
  items: PriceDiffItem[];
  old_total_ex_vat: number;
  new_total_ex_vat: number;
  delta_total_ex_vat: number;
  old_total_inc_vat: number;
  new_total_inc_vat: number;
  delta_total_inc_vat: number;
}

interface QuotePriceDiffModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diff: PriceDiffResult | null;
  quoteRevision: number;
  latestRevision: number;
}

const QuotePriceDiffModal: React.FC<QuotePriceDiffModalProps> = ({
  open,
  onOpenChange,
  diff,
  quoteRevision,
  latestRevision,
}) => {
  const { t } = useLanguage();

  const formatPrice = (value: number) =>
    value.toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  const formatDelta = (value: number) => {
    const formatted = formatPrice(Math.abs(value));
    if (value > 0) return `+${formatted}`;
    if (value < 0) return `-${formatted}`;
    return '0';
  };

  const getDeltaColor = (value: number) => {
    if (value > 0) return 'text-destructive';
    if (value < 0) return 'text-green-600';
    return 'text-muted-foreground';
  };

  if (!diff) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('Prisskillnader', 'Price Differences')}
            <Badge variant="outline" className="font-mono text-xs">
              r{quoteRevision} → r{latestRevision}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {t(
              'Jämförelse mellan offertens priser och senaste prisrevision',
              'Comparison between quote prices and latest pricing revision'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-3 font-medium">{t('Produkt', 'Product')}</th>
                <th className="pb-3 font-medium">{t('SKU', 'SKU')}</th>
                <th className="pb-3 font-medium text-center">{t('Antal', 'Qty')}</th>
                <th className="pb-3 font-medium text-right">{t('Gammalt pris', 'Old price')}</th>
                <th className="pb-3 font-medium text-right">{t('Nytt pris', 'New price')}</th>
                <th className="pb-3 font-medium text-right">{t('Δ/st', 'Δ/unit')}</th>
                <th className="pb-3 font-medium text-right">{t('Δ totalt', 'Δ total')}</th>
              </tr>
            </thead>
            <tbody>
              {diff.items.map((item) => (
                <tr key={item.sku_id} className="border-b border-border">
                  <td className="py-3 font-medium">{item.sku_name}</td>
                  <td className="py-3 text-muted-foreground font-mono text-xs">{item.sku_code}</td>
                  <td className="py-3 text-center">{item.quantity}</td>
                  <td className="py-3 text-right text-muted-foreground">
                    {formatPrice(item.old_unit_price)} kr
                  </td>
                  <td className="py-3 text-right">{formatPrice(item.new_unit_price)} kr</td>
                  <td className={`py-3 text-right ${getDeltaColor(item.delta_per_unit)}`}>
                    {formatDelta(item.delta_per_unit)} kr
                  </td>
                  <td className={`py-3 text-right font-medium ${getDeltaColor(item.delta_total)}`}>
                    {formatDelta(item.delta_total)} kr
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Summary */}
        <div className="mt-6 border-t border-border pt-4 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Gammal summa (ex moms)', 'Old total (ex VAT)')}:</span>
            <span>{formatPrice(diff.old_total_ex_vat)} kr</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Ny summa (ex moms)', 'New total (ex VAT)')}:</span>
            <span>{formatPrice(diff.new_total_ex_vat)} kr</span>
          </div>
          <div className="flex justify-between text-sm font-medium">
            <span>{t('Skillnad (ex moms)', 'Difference (ex VAT)')}:</span>
            <span className={getDeltaColor(diff.delta_total_ex_vat)}>
              {formatDelta(diff.delta_total_ex_vat)} kr
            </span>
          </div>

          <div className="border-t border-border pt-3 mt-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('Gammal summa (ink moms)', 'Old total (inc VAT)')}:</span>
              <span>{formatPrice(diff.old_total_inc_vat)} kr</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('Ny summa (ink moms)', 'New total (inc VAT)')}:</span>
              <span>{formatPrice(diff.new_total_inc_vat)} kr</span>
            </div>
            <div className="flex justify-between text-sm font-medium mt-2">
              <span>{t('Skillnad (ink moms)', 'Difference (inc VAT)')}:</span>
              <span className={getDeltaColor(diff.delta_total_inc_vat)}>
                {formatDelta(diff.delta_total_inc_vat)} kr
              </span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QuotePriceDiffModal;
