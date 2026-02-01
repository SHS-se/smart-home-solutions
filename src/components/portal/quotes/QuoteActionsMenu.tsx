import React from 'react';
import { MoreHorizontal, TestTube, TestTubeDiagonal, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLanguage } from '@/contexts/LanguageContext';

interface QuoteActionsMenuProps {
  isTest: boolean;
  status: string;
  onMarkTest: () => void;
  onUnmarkTest: () => void;
  onCancel: () => void;
}

const QuoteActionsMenu: React.FC<QuoteActionsMenuProps> = ({
  isTest,
  status,
  onMarkTest,
  onUnmarkTest,
  onCancel,
}) => {
  const { t } = useLanguage();

  const canCancel = status !== 'cancelled';
  const showAnyAction = canCancel || isTest || !isTest;

  if (!showAnyAction) return null;

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
        {canCancel && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onCancel}
              className="text-destructive focus:text-destructive"
            >
              <XCircle className="mr-2 h-4 w-4" />
              {t('Avbryt offert', 'Cancel quote')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default QuoteActionsMenu;
