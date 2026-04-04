import React, { useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { Loader2 } from 'lucide-react';

interface QuoteCancelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteNumber: string;
  onConfirm: (reason?: string) => Promise<void>;
  isLoading?: boolean;
}

const QuoteCancelDialog: React.FC<QuoteCancelDialogProps> = ({
  open,
  onOpenChange,
  quoteNumber,
  onConfirm,
  isLoading = false,
}) => {
  const { t } = useLanguage();
  const [reason, setReason] = useState('');

  const handleConfirm = async () => {
    await onConfirm(reason.trim() || undefined);
    setReason('');
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!isLoading) {
      onOpenChange(newOpen);
      if (!newOpen) {
        setReason('');
      }
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('Avbryt offert?', 'Cancel quote?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              `Detta kommer att avbryta offert #${quoteNumber} och dölja den från den aktiva listan.`,
              `This will cancel quote #${quoteNumber} and hide it from the active list.`
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="cancel-reason">
            {t('Anledning (valfritt)', 'Reason (optional)')}
          </Label>
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('Ange anledning till avbrytning...', 'Enter cancellation reason...')}
            disabled={isLoading}
            className="min-h-[80px]"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {t('Tillbaka', 'Back')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={isLoading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('Avbryter...', 'Cancelling...')}
              </>
            ) : (
              t('Bekräfta avbrytning', 'Confirm cancel')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default QuoteCancelDialog;
