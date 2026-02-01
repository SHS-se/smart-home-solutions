import React from 'react';
import { MoreHorizontal, TestTube, TestTubeDiagonal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLanguage } from '@/contexts/LanguageContext';

interface InvoiceActionsMenuProps {
  isTest: boolean;
  status: string;
  onMarkTest: () => void;
  onUnmarkTest: () => void;
}

const InvoiceActionsMenu: React.FC<InvoiceActionsMenuProps> = ({
  isTest,
  status,
  onMarkTest,
  onUnmarkTest,
}) => {
  const { t } = useLanguage();

  // Only show test toggle for draft invoices
  const canToggleTest = status === 'draft';

  if (!canToggleTest) return null;

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
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default InvoiceActionsMenu;
