import React from 'react';
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
import { useLanguage } from '@/contexts/LanguageContext';

interface QuoteUpdateConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentVersion: number;
  targetRevision: number;
  onConfirm: () => void;
}

const QuoteUpdateConfirmDialog: React.FC<QuoteUpdateConfirmDialogProps> = ({
  open,
  onOpenChange,
  currentVersion,
  targetRevision,
  onConfirm,
}) => {
  const { t } = useLanguage();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('Skapa ny offertversion?', 'Create new quote version?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              `Detta skapar en ny offertversion (v${currentVersion + 1}) baserad på Prisrev r${targetRevision}. Tidigare offertversioner påverkas inte.`,
              `This will create a new quote version (v${currentVersion + 1}) based on Price rev r${targetRevision}. Previous quote versions will not be affected.`
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('Avbryt', 'Cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('Skapa ny version', 'Create new version')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default QuoteUpdateConfirmDialog;
