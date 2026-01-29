import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useLanguage } from '@/contexts/LanguageContext';

interface QuoteLine {
  id: string;
  section: string;
  description: string;
  quantity: number;
  unit_price: number;
}

interface QuotePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quote: {
    quote_number: string;
    customer?: { org_name: string } | null;
    bom?: { project_name: string } | null;
    created_at: string;
  } | null;
  lines: QuoteLine[];
  totals: {
    hardwareExVat: number;
    laborExVat: number;
    travelExVat: number;
    subtotalExVat: number;
    vatTotal: number;
    totalIncVat: number;
  };
}

const QuotePreviewDialog: React.FC<QuotePreviewDialogProps> = ({
  open,
  onOpenChange,
  quote,
  lines,
  totals,
}) => {
  const { t } = useLanguage();
  
  const formatPrice = (value: number) => 
    value.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('sv-SE');
  };

  const expiryDate = () => {
    const date = new Date(quote?.created_at || new Date());
    date.setDate(date.getDate() + 30);
    return formatDate(date.toISOString());
  };

  const hardwareLines = lines.filter(l => l.section === 'hardware');
  const laborLines = lines.filter(l => l.section === 'labor');
  const travelLines = lines.filter(l => l.section === 'travel');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0">
        {/* Stripe-style quote document */}
        <div className="bg-white text-gray-900 min-h-[800px]">
          {/* Header */}
          <div className="bg-[#635bff] text-white px-8 py-6">
            <div className="flex justify-between items-start">
              <div>
                <h1 className="text-2xl font-semibold">Smart Home Solutions</h1>
                <p className="text-white/80 text-sm mt-1">smarthomesolutions.se</p>
              </div>
              <div className="text-right">
                <div className="text-white/80 text-sm uppercase tracking-wide">{t('Offert', 'Quote')}</div>
                <div className="text-xl font-mono mt-1">#{quote?.quote_number}</div>
              </div>
            </div>
          </div>

          {/* Quote info bar */}
          <div className="bg-gray-50 border-b border-gray-200 px-8 py-4">
            <div className="flex justify-between text-sm">
              <div>
                <span className="text-gray-500">{t('Datum', 'Date')}:</span>
                <span className="ml-2 font-medium">{formatDate(quote?.created_at || new Date().toISOString())}</span>
              </div>
              <div>
                <span className="text-gray-500">{t('Giltig till', 'Valid until')}:</span>
                <span className="ml-2 font-medium">{expiryDate()}</span>
              </div>
            </div>
          </div>

          {/* Customer info */}
          <div className="px-8 py-6 border-b border-gray-200">
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">{t('Till', 'Bill to')}</div>
            <div className="font-medium text-lg">{quote?.customer?.org_name || t('Kund ej angiven', 'Customer not specified')}</div>
            {quote?.bom?.project_name && (
              <div className="text-gray-500 text-sm mt-1">
                {t('Projekt', 'Project')}: {quote.bom.project_name}
              </div>
            )}
          </div>

          {/* Line items */}
          <div className="px-8 py-6">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="pb-3 font-medium">{t('Beskrivning', 'Description')}</th>
                  <th className="pb-3 font-medium text-right">{t('Antal', 'Qty')}</th>
                  <th className="pb-3 font-medium text-right">{t('À-pris', 'Unit price')}</th>
                  <th className="pb-3 font-medium text-right">{t('Belopp', 'Amount')}</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {/* Hardware section */}
                {hardwareLines.length > 0 && (
                  <>
                    <tr>
                      <td colSpan={4} className="pt-4 pb-2 font-semibold text-gray-700">
                        {t('Hårdvara', 'Hardware')}
                      </td>
                    </tr>
                    {hardwareLines.map(line => (
                      <tr key={line.id} className="border-b border-gray-100">
                        <td className="py-3 text-gray-700">{line.description || '—'}</td>
                        <td className="py-3 text-right text-gray-600">{line.quantity}</td>
                        <td className="py-3 text-right text-gray-600">{formatPrice(line.unit_price)} kr</td>
                        <td className="py-3 text-right font-medium">{formatPrice(line.quantity * line.unit_price)} kr</td>
                      </tr>
                    ))}
                  </>
                )}

                {/* Labor section */}
                {laborLines.length > 0 && (
                  <>
                    <tr>
                      <td colSpan={4} className="pt-6 pb-2 font-semibold text-gray-700">
                        {t('Arbete', 'Labor')}
                      </td>
                    </tr>
                    {laborLines.map(line => (
                      <tr key={line.id} className="border-b border-gray-100">
                        <td className="py-3 text-gray-700">{line.description || '—'}</td>
                        <td className="py-3 text-right text-gray-600">{line.quantity} {t('tim', 'hrs')}</td>
                        <td className="py-3 text-right text-gray-600">{formatPrice(line.unit_price)} kr</td>
                        <td className="py-3 text-right font-medium">{formatPrice(line.quantity * line.unit_price)} kr</td>
                      </tr>
                    ))}
                  </>
                )}

                {/* Travel section */}
                {travelLines.length > 0 && (
                  <>
                    <tr>
                      <td colSpan={4} className="pt-6 pb-2 font-semibold text-gray-700">
                        {t('Resa / Övrigt', 'Travel / Other')}
                      </td>
                    </tr>
                    {travelLines.map(line => (
                      <tr key={line.id} className="border-b border-gray-100">
                        <td className="py-3 text-gray-700">{line.description || '—'}</td>
                        <td className="py-3 text-right text-gray-600">{line.quantity}</td>
                        <td className="py-3 text-right text-gray-600">{formatPrice(line.unit_price)} kr</td>
                        <td className="py-3 text-right font-medium">{formatPrice(line.quantity * line.unit_price)} kr</td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>

            {/* Totals */}
            <div className="mt-8 flex justify-end">
              <div className="w-72">
                <div className="flex justify-between py-2 text-sm">
                  <span className="text-gray-500">{t('Delsumma (ex moms)', 'Subtotal (ex VAT)')}</span>
                  <span className="font-medium">{formatPrice(totals.subtotalExVat)} kr</span>
                </div>
                <div className="flex justify-between py-2 text-sm border-b border-gray-200">
                  <span className="text-gray-500">{t('Moms (25%)', 'VAT (25%)')}</span>
                  <span className="font-medium">{formatPrice(totals.vatTotal)} kr</span>
                </div>
                <div className="flex justify-between py-3">
                  <span className="font-semibold">{t('Totalt att betala', 'Total due')}</span>
                  <span className="text-xl font-bold text-[#635bff]">{formatPrice(totals.totalIncVat)} kr</span>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-8 py-6 bg-gray-50 border-t border-gray-200 mt-8">
            <div className="text-xs text-gray-500 text-center">
              {t('Denna offert är giltig i 30 dagar från utfärdandedatum.', 'This quote is valid for 30 days from the issue date.')}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default QuotePreviewDialog;
