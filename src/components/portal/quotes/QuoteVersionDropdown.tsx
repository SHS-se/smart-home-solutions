import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, Check } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { format } from 'date-fns';

interface QuoteVersion {
  id: string;
  quote_number: string | null;
  version: number;
  status: string;
  created_at: string;
  is_latest: boolean;
}

interface QuoteVersionDropdownProps {
  versions: QuoteVersion[];
  currentQuoteId: string;
}

const QuoteVersionDropdown: React.FC<QuoteVersionDropdownProps> = ({
  versions,
  currentQuoteId,
}) => {
  const { t } = useLanguage();
  const navigate = useNavigate();

  const currentVersion = versions.find((v) => v.id === currentQuoteId);

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      draft: 'outline',
      sent: 'secondary',
      accepted: 'default',
      invoiced: 'default',
      cancelled: 'destructive',
      superseded: 'outline',
    };

    const labels: Record<string, string> = {
      draft: t('Utkast', 'Draft'),
      sent: t('Skickad', 'Sent'),
      accepted: t('Accepterad', 'Accepted'),
      invoiced: t('Fakturerad', 'Invoiced'),
      cancelled: t('Avbruten', 'Cancelled'),
      superseded: t('Ersatt', 'Superseded'),
    };

    return (
      <Badge variant={variants[status] || 'outline'} className="text-xs">
        {labels[status] || status}
      </Badge>
    );
  };

  if (versions.length <= 1) {
    return (
      <Badge variant="outline" className="font-mono">
        v{currentVersion?.version || 1}
      </Badge>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 font-mono">
          v{currentVersion?.version || 1}
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {versions.map((version) => (
          <DropdownMenuItem
            key={version.id}
            onClick={() => navigate(`/portal/quotes/${version.id}`)}
            className="flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              {version.id === currentQuoteId && (
                <Check className="h-4 w-4 text-primary" />
              )}
              {version.id !== currentQuoteId && <div className="w-4" />}
              <span className="font-mono">v{version.version}</span>
              {version.is_latest && (
                <Badge variant="secondary" className="text-xs">
                  {t('Senaste', 'Latest')}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{format(new Date(version.created_at), 'dd MMM')}</span>
              {getStatusBadge(version.status)}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default QuoteVersionDropdown;
