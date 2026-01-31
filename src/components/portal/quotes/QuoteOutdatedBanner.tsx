import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertTriangle, ArrowRight, Eye } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

interface QuoteOutdatedBannerProps {
  quoteRevision: number;
  latestRevision: number;
  onUpdate: () => void;
  onShowDiff: () => void;
  isUpdating: boolean;
}

const QuoteOutdatedBanner: React.FC<QuoteOutdatedBannerProps> = ({
  quoteRevision,
  latestRevision,
  onUpdate,
  onShowDiff,
  isUpdating,
}) => {
  const { t } = useLanguage();

  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {t('Priserna har uppdaterats', 'Prices have been updated')}
      </AlertTitle>
      <AlertDescription className="mt-2">
        <p className="text-sm mb-3">
          {t(
            `Priserna i BOM har uppdaterats. Denna offert använder r${quoteRevision}, senaste är r${latestRevision}.`,
            `BOM prices have been updated. This quote uses r${quoteRevision}, latest is r${latestRevision}.`
          )}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onUpdate}
            disabled={isUpdating}
          >
            <ArrowRight className="h-4 w-4 mr-2" />
            {isUpdating
              ? t('Skapar ny version...', 'Creating new version...')
              : t(`Uppdatera offert till r${latestRevision}`, `Update quote to r${latestRevision}`)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onShowDiff}
          >
            <Eye className="h-4 w-4 mr-2" />
            {t('Visa skillnader', 'Show differences')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
};

export default QuoteOutdatedBanner;
