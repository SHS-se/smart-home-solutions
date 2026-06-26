import React, { useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { callManageStaff } from '@/lib/staff-api';

interface DeleteStaffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  staffName: string;
  onDeleted: () => void;
}

export const DeleteStaffDialog: React.FC<DeleteStaffDialogProps> = ({
  open,
  onOpenChange,
  userId,
  staffName,
  onDeleted,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await callManageStaff(
        { action: 'delete', user_id: userId },
        t('Kunde inte ta bort personalanvändaren', 'Could not delete staff user'),
      );
      toast({
        title: t('Personal borttagen', 'Staff removed'),
        description: t('Personalkontot har tagits bort.', 'The staff account has been removed.'),
      });
      onDeleted();
    } catch (err) {
      toast({
        title: t('Fel', 'Error'),
        description: err instanceof Error ? err.message : t('Något gick fel.', 'Something went wrong.'),
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-destructive" />
            {t('Ta bort personal?', 'Remove staff user?')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              `Du håller på att ta bort "${staffName}". Kontot och inloggningen tas bort permanent. Denna åtgärd kan inte ångras.`,
              `You are about to remove "${staffName}". The account and its login will be permanently deleted. This action cannot be undone.`,
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t('Avbryt', 'Cancel')}</AlertDialogCancel>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {t('Ta bort', 'Remove')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
