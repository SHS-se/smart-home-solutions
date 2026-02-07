import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Lock, ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';

interface BOMVersionSelectorProps {
  bomGroupId: string;
  currentBomId: string;
  currentVersion: number;
}

const BOMVersionSelector: React.FC<BOMVersionSelectorProps> = ({
  bomGroupId,
  currentBomId,
  currentVersion,
}) => {
  const { t } = useLanguage();
  const navigate = useNavigate();

  const { data: revisions = [] } = useQuery({
    queryKey: ['bom-revisions', bomGroupId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boms')
        .select('id, version, created_at')
        .eq('bom_group_id', bomGroupId)
        .order('version', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!bomGroupId,
  });

  // Check locked status for each revision
  const { data: lockedVersions = new Set<number>() } = useQuery({
    queryKey: ['bom-locked-versions', bomGroupId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('quotes')
        .select('bom_id, bom_version')
        .in('bom_id', revisions.map(r => r.id))
        .in('status', ['sent', 'viewed', 'accepted', 'revision_requested']);
      if (error) throw error;
      const locked = new Set<number>();
      for (const row of data) {
        if (row.bom_version !== null) locked.add(row.bom_version);
      }
      return locked;
    },
    enabled: revisions.length > 1,
  });

  if (revisions.length <= 1) {
    return (
      <Badge variant="outline" className="font-mono">
        BOM v{currentVersion}
      </Badge>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-0.5 text-sm font-mono font-medium hover:bg-muted transition-colors cursor-pointer">
          BOM v{currentVersion}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="text-xs font-medium text-muted-foreground mb-2 px-2">
          {t('Revisioner', 'Revisions')}
        </div>
        <div className="space-y-0.5">
          {revisions.map((rev) => {
            const isCurrent = rev.id === currentBomId;
            const isLocked = lockedVersions.has(rev.version);
            return (
              <button
                key={rev.id}
                className={`w-full flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${
                  isCurrent
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted text-foreground'
                }`}
                onClick={() => {
                  if (!isCurrent) navigate(`/portal/boms/${rev.id}`);
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono">v{rev.version}</span>
                  {isCurrent && (
                    <span className="text-xs text-muted-foreground">
                      ({t('aktuell', 'current')})
                    </span>
                  )}
                  {isLocked && (
                    <Lock className="h-3 w-3 text-muted-foreground" />
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {format(new Date(rev.created_at), 'yyyy-MM-dd', { locale: sv })}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default BOMVersionSelector;
