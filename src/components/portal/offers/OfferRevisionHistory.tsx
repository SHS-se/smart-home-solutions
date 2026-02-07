import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getQuoteStatusBadge } from '@/lib/quote-status-badge';

interface QuoteVersion {
  id: string;
  quote_number: string | null;
  version: number;
  status: string;
  created_at: string;
  is_latest: boolean;
}

interface OfferRevisionHistoryProps {
  versions: QuoteVersion[];
  currentQuoteId: string;
  t: (sv: string, en: string) => string;
}

const formatDate = (dateString: string) =>
  new Date(dateString).toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const OfferRevisionHistory: React.FC<OfferRevisionHistoryProps> = ({
  versions,
  currentQuoteId,
  t,
}) => {
  const navigate = useNavigate();

  // Only show other versions (not the currently viewed one)
  const otherVersions = versions
    .filter((v) => v.id !== currentQuoteId)
    .sort((a, b) => b.version - a.version);

  if (otherVersions.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4" />
          {t('Tidigare versioner av offerten', 'Previous versions of the offer')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />

          <div className="space-y-4">
            {otherVersions.map((version) => (
              <div key={version.id} className="relative flex items-center gap-4 pl-8">
                {/* Timeline dot */}
                <div className="absolute left-1.5 w-3 h-3 rounded-full bg-muted border-2 border-border" />

                <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="flex items-center gap-2 flex-1">
                    <span className="font-mono text-sm font-medium">
                      {version.quote_number || t('Utkast', 'Draft')}
                    </span>
                    <Badge variant="outline" className="font-mono text-xs">
                      v{version.version}
                    </Badge>
                    {getQuoteStatusBadge(version.status, t)}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(version.created_at)}
                  </span>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => navigate(`/portal/offers/${version.id}`)}
                >
                  {t('Visa', 'View')}
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default OfferRevisionHistory;
