import React from 'react';
import { MoreHorizontal, TestTube, TestTubeDiagonal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLanguage } from '@/contexts/LanguageContext';

interface SKUActionsMenuProps {
  isTest: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMarkTest: () => void;
  onUnmarkTest: () => void;
}

const SKUActionsMenu: React.FC<SKUActionsMenuProps> = ({
  isTest,
  onEdit,
  onDelete,
  onMarkTest,
  onUnmarkTest,
}) => {
  const { t } = useLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">{t('Åtgärder', 'Actions')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="mr-2 h-4 w-4" />
          {t('Redigera', 'Edit')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {!isTest && (
          <DropdownMenuItem onClick={onMarkTest}>
            <TestTube className="mr-2 h-4 w-4" />
            {t('Markera som test', 'Mark as test')}
          </DropdownMenuItem>
        )}
        {isTest && (
          <DropdownMenuItem onClick={onUnmarkTest}>
            <TestTubeDiagonal className="mr-2 h-4 w-4" />
            {t('Avmarkera test', 'Unmark test')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t('Radera', 'Delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default SKUActionsMenu;
