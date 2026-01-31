import React from 'react';
import { format } from 'date-fns';
import { sv, enUS } from 'date-fns/locale';
import { History, RotateCcw } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { PriceRevision } from '@/hooks/use-bom-pricing-revisions';

interface PricingRevisionDropdownProps {
  revisions: PriceRevision[];
  latestRevision: PriceRevision | null;
  onRevert: (revision: PriceRevision) => void;
  isReverting: boolean;
}

const PricingRevisionDropdown: React.FC<PricingRevisionDropdownProps> = ({
  revisions,
  latestRevision,
  onRevert,
  isReverting,
}) => {
  const { t, language } = useLanguage();
  const [revertTarget, setRevertTarget] = React.useState<PriceRevision | null>(null);

  const formatDate = (dateStr: string) => {
    return format(new Date(dateStr), 'dd MMM yyyy HH:mm', {
      locale: language === 'sv' ? sv : enUS,
    });
  };

  if (!latestRevision) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t('Ingen prisrev', 'No price rev')}
      </Badge>
    );
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1.5">
            <span className="font-mono">r{latestRevision.revision}</span>
            <History className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <div className="p-3 border-b border-border">
            <h4 className="font-medium text-sm">{t('Prisrevisioner', 'Pricing Revisions')}</h4>
            <p className="text-xs text-muted-foreground mt-1">
              {t('Historik över prisändringar', 'History of pricing changes')}
            </p>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {revisions.map((rev, index) => {
              const isLatest = index === 0;
              return (
                <div 
                  key={rev.id} 
                  className={`flex items-center justify-between p-3 border-b border-border last:border-0 ${isLatest ? 'bg-muted/30' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium">r{rev.revision}</span>
                      {isLatest && (
                        <Badge variant="secondary" className="text-xs">
                          {t('Aktuell', 'Current')}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(rev.created_at)}
                    </div>
                    {rev.note && (
                      <div className="text-xs text-muted-foreground italic mt-0.5 truncate">
                        {rev.note}
                      </div>
                    )}
                  </div>
                  {!isLatest && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => setRevertTarget(rev)}
                      disabled={isReverting}
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1" />
                      {t('Återställ', 'Revert')}
                    </Button>
                  )}
                </div>
              );
            })}
            {revisions.length === 0 && (
              <div className="p-4 text-center text-sm text-muted-foreground">
                {t('Inga revisioner ännu', 'No revisions yet')}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Revert Confirmation Dialog */}
      <AlertDialog open={!!revertTarget} onOpenChange={(open) => !open && setRevertTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Återställ till prisrevision', 'Revert to pricing revision')} r{revertTarget?.revision}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Detta skapar en ny prisrevision med priserna från den valda revisionen. Befintlig historik påverkas inte.',
                'This will create a new pricing revision with prices from the selected revision. Existing history will not be affected.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Avbryt', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => {
                if (revertTarget) {
                  onRevert(revertTarget);
                  setRevertTarget(null);
                }
              }}
            >
              {t('Återställ', 'Revert')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default PricingRevisionDropdown;
