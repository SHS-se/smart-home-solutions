import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { callManageStaff } from '@/lib/staff-api';

interface SetStaffPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  staffName: string;
}

export const SetStaffPasswordDialog: React.FC<SetStaffPasswordDialogProps> = ({
  open,
  onOpenChange,
  userId,
  staffName,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword('');
      setConfirm('');
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password.length < 8) {
      toast({
        title: t('Fel', 'Error'),
        description: t('Lösenordet måste vara minst 8 tecken.', 'Password must be at least 8 characters.'),
        variant: 'destructive',
      });
      return;
    }
    if (password !== confirm) {
      toast({
        title: t('Fel', 'Error'),
        description: t('Lösenorden matchar inte.', 'Passwords do not match.'),
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      await callManageStaff(
        { action: 'set_password', user_id: userId, password },
        t('Kunde inte ändra lösenordet', 'Could not change password'),
      );
      toast({
        title: t('Lösenord uppdaterat', 'Password updated'),
        description: t('Det nya lösenordet har sparats.', 'The new password has been saved.'),
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: t('Fel', 'Error'),
        description: err instanceof Error ? err.message : t('Något gick fel.', 'Something went wrong.'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('Ange lösenord', 'Set password')}</DialogTitle>
          <DialogDescription>
            {t(
              `Ange ett nytt lösenord för ${staffName}.`,
              `Set a new password for ${staffName}.`,
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-staff-password">{t('Nytt lösenord', 'New password')}</Label>
            <Input
              id="new-staff-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('Minst 8 tecken', 'At least 8 characters')}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-staff-password">{t('Bekräfta lösenord', 'Confirm password')}</Label>
            <Input
              id="confirm-staff-password"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              {t('Spara lösenord', 'Save password')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
