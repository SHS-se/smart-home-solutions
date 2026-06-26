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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/hooks/use-toast';
import { callManageStaff } from '@/lib/staff-api';

export interface StaffUser {
  user_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  role: string;
  created_at: string;
}

interface StaffFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the dialog edits this staff user; otherwise it creates one. */
  staff?: StaffUser | null;
  onSaved: () => void;
}

interface FormState {
  full_name: string;
  email: string;
  phone: string;
  address: string;
  role: string;
  password: string;
}

const emptyForm: FormState = {
  full_name: '',
  email: '',
  phone: '',
  address: '',
  role: 'staff',
  password: '',
};

export const StaffFormDialog: React.FC<StaffFormDialogProps> = ({
  open,
  onOpenChange,
  staff,
  onSaved,
}) => {
  const { t } = useLanguage();
  const { toast } = useToast();
  const isEditing = !!staff;
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (staff) {
      setForm({
        full_name: staff.full_name ?? '',
        email: staff.email ?? '',
        phone: staff.phone ?? '',
        address: staff.address ?? '',
        role: staff.role ?? 'staff',
        password: '',
      });
    } else {
      setForm(emptyForm);
    }
  }, [open, staff]);

  const update = (key: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.email.trim()) {
      toast({
        title: t('Fel', 'Error'),
        description: t('E-post krävs.', 'Email is required.'),
        variant: 'destructive',
      });
      return;
    }

    if (!isEditing && form.password.length < 8) {
      toast({
        title: t('Fel', 'Error'),
        description: t('Lösenordet måste vara minst 8 tecken.', 'Password must be at least 8 characters.'),
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      await callManageStaff(
        {
          action: isEditing ? 'update' : 'create',
          user_id: staff?.user_id,
          email: form.email.trim(),
          full_name: form.full_name.trim() || null,
          phone: form.phone.trim() || null,
          address: form.address.trim() || null,
          role: form.role,
          ...(isEditing ? {} : { password: form.password }),
        },
        isEditing
          ? t('Kunde inte spara personalanvändaren', 'Could not save staff user')
          : t('Kunde inte skapa personalanvändaren', 'Could not create staff user'),
      );

      toast({
        title: isEditing
          ? t('Personal uppdaterad', 'Staff updated')
          : t('Personal skapad', 'Staff created'),
        description: isEditing
          ? t('Ändringarna har sparats.', 'The changes have been saved.')
          : t('Den nya personalanvändaren har skapats.', 'The new staff user has been created.'),
      });
      onSaved();
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
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t('Redigera personal', 'Edit staff user')
              : t('Lägg till personal', 'Add staff user')}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? t('Uppdatera personalens uppgifter.', "Update this staff member's details.")
              : t('Skapa ett nytt personalkonto med inloggning.', 'Create a new staff account with login access.')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="staff-name">{t('Namn', 'Name')}</Label>
            <Input
              id="staff-name"
              value={form.full_name}
              onChange={(e) => update('full_name', e.target.value)}
              placeholder={t('T.ex. Anna Andersson', 'E.g. Anna Andersson')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="staff-email">{t('E-post', 'Email')} *</Label>
            <Input
              id="staff-email"
              type="email"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              placeholder="namn@smarthomesolutions.se"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="staff-phone">{t('Telefon', 'Phone')}</Label>
            <Input
              id="staff-phone"
              value={form.phone}
              onChange={(e) => update('phone', e.target.value)}
              placeholder="+46 70 123 45 67"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="staff-address">{t('Adress', 'Address')}</Label>
            <Textarea
              id="staff-address"
              value={form.address}
              onChange={(e) => update('address', e.target.value)}
              rows={2}
              placeholder={t('Gatuadress, postnummer, ort', 'Street, postcode, city')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="staff-role">{t('Roll', 'Role')}</Label>
            <Select value={form.role} onValueChange={(value) => update('role', value)}>
              <SelectTrigger id="staff-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="staff">{t('Personal', 'Staff')}</SelectItem>
                <SelectItem value="admin">{t('Administratör', 'Admin')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {!isEditing && (
            <div className="space-y-2">
              <Label htmlFor="staff-password">{t('Lösenord', 'Password')} *</Label>
              <Input
                id="staff-password"
                type="password"
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
                placeholder={t('Minst 8 tecken', 'At least 8 characters')}
                autoComplete="new-password"
                required
              />
              <p className="text-xs text-muted-foreground">
                {t(
                  'Personalen kan ändra sitt lösenord senare.',
                  'The staff member can change their password later.',
                )}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('Avbryt', 'Cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              {isEditing ? t('Spara', 'Save') : t('Skapa', 'Create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
