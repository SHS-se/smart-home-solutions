import React, { useState } from 'react';
import { MoreHorizontal, Pencil, KeyRound, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { StaffFormDialog, type StaffUser } from './StaffFormDialog';
import { SetStaffPasswordDialog } from './SetStaffPasswordDialog';
import { DeleteStaffDialog } from './DeleteStaffDialog';

interface StaffActionsMenuProps {
  staff: StaffUser;
  /** The currently logged-in user's id — used to disable self-deletion. */
  currentUserId: string | undefined;
  onUpdated: () => void;
}

export const StaffActionsMenu: React.FC<StaffActionsMenuProps> = ({
  staff,
  currentUserId,
  onUpdated,
}) => {
  const { t } = useLanguage();
  const [showEdit, setShowEdit] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const staffName = staff.full_name || staff.email || t('Namnlös', 'Unnamed');
  const isSelf = staff.user_id === currentUserId;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onClick={() => setShowEdit(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            {t('Redigera', 'Edit')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setShowPassword(true)}>
            <KeyRound className="mr-2 h-4 w-4" />
            {t('Ange lösenord', 'Set password')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setShowDelete(true)}
            disabled={isSelf}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {isSelf ? t('Ta bort (du själv)', 'Remove (yourself)') : t('Ta bort', 'Remove')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <StaffFormDialog
        open={showEdit}
        onOpenChange={setShowEdit}
        staff={staff}
        onSaved={onUpdated}
      />
      <SetStaffPasswordDialog
        open={showPassword}
        onOpenChange={setShowPassword}
        userId={staff.user_id}
        staffName={staffName}
      />
      <DeleteStaffDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        userId={staff.user_id}
        staffName={staffName}
        onDeleted={onUpdated}
      />
    </>
  );
};
