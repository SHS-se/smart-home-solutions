import React from 'react';
import { MoreHorizontal, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLanguage } from '@/contexts/LanguageContext';

interface QuoteActionsMenuProps {
  status: string;
  onCancel: () => void;
}

const QuoteActionsMenu: React.FC<QuoteActionsMenuProps> = ({
  status,
  onCancel,
}) => {
  const { t } = useLanguage();

  const canCancel = status !== 'cancelled';

  if (!canCancel) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">{t('Åtgärder', 'Actions')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          onClick={onCancel}
          className="text-destructive focus:text-destructive"
        >
          <XCircle className="mr-2 h-4 w-4" />
          {t('Avbryt offert', 'Cancel quote')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default QuoteActionsMenu;
