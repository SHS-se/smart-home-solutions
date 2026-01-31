import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';

export interface PriceRevision {
  id: string;
  bom_id: string;
  revision: number;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

export interface PriceRevisionItem {
  id: string;
  bom_price_revision_id: string;
  sku_id: string;
  quantity: number;
  cost_ex_vat: number;
  sell_ex_vat: number;
  vat_rate: number;
  margin_pct: number | null;
}

interface BOMItem {
  id: string;
  sku_id: string;
  quantity: number;
  sku: {
    cost_ex_vat_computed: number | null;
    sell_price_ex_vat: number | null;
    vat_rate: number;
    effective_margin_percent: number | null;
  };
}

export function useBomPricingRevisions(bomId: string | undefined, t: (sv: string, en: string) => string) {
  const queryClient = useQueryClient();

  // Fetch all pricing revisions for this BOM
  const { data: revisions = [], isLoading: revisionsLoading } = useQuery({
    queryKey: ['bom_price_revisions', bomId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bom_price_revisions')
        .select('*')
        .eq('bom_id', bomId)
        .order('revision', { ascending: false });
      if (error) throw error;
      return data as PriceRevision[];
    },
    enabled: !!bomId,
  });

  // Get latest revision
  const latestRevision = revisions.length > 0 ? revisions[0] : null;

  // Fetch items for a specific revision
  const fetchRevisionItems = async (revisionId: string): Promise<PriceRevisionItem[]> => {
    const { data, error } = await supabase
      .from('bom_price_revision_items')
      .select('*')
      .eq('bom_price_revision_id', revisionId);
    if (error) throw error;
    return data as PriceRevisionItem[];
  };

  // Create new pricing revision
  const createRevisionMutation = useMutation({
    mutationFn: async (bomItems: BOMItem[]) => {
      const nextRevision = (latestRevision?.revision ?? 0) + 1;

      // Create the revision record
      const { data: revision, error: revError } = await supabase
        .from('bom_price_revisions')
        .insert({
          bom_id: bomId,
          revision: nextRevision,
          note: 'manual update',
        })
        .select()
        .single();
      if (revError) throw revError;

      // Snapshot all BOM items with current SKU prices
      const revisionItems = bomItems.map(item => ({
        bom_price_revision_id: revision.id,
        sku_id: item.sku_id,
        quantity: item.quantity,
        cost_ex_vat: item.sku.cost_ex_vat_computed ?? 0,
        sell_ex_vat: item.sku.sell_price_ex_vat ?? 0,
        vat_rate: item.sku.vat_rate ?? 0.25,
        margin_pct: item.sku.effective_margin_percent ?? null,
      }));

      const { error: itemsError } = await supabase
        .from('bom_price_revision_items')
        .insert(revisionItems);
      if (itemsError) throw itemsError;

      return { revision, revisionItems };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['bom_price_revisions', bomId] });
      toast({ 
        title: t('Ny prisrevision skapad', 'New pricing revision created'),
        description: `r${data.revision.revision}`
      });
    },
    onError: (error: any) => {
      toast({ 
        title: t('Kunde inte skapa prisrevision', 'Failed to create pricing revision'), 
        description: error.message, 
        variant: 'destructive' 
      });
    },
  });

  // Revert to a previous revision (creates new revision with copied data)
  const revertRevisionMutation = useMutation({
    mutationFn: async ({ 
      targetRevision, 
      currentBomItems 
    }: { 
      targetRevision: PriceRevision; 
      currentBomItems: BOMItem[] 
    }) => {
      // Get items from target revision
      const targetItems = await fetchRevisionItems(targetRevision.id);

      // Safety check: compare SKU+quantity sets
      const currentSet = new Set(currentBomItems.map(i => `${i.sku_id}:${i.quantity}`));
      const targetSet = new Set(targetItems.map(i => `${i.sku_id}:${i.quantity}`));

      // Check if sets are equal
      const setsEqual = currentSet.size === targetSet.size && 
        [...currentSet].every(item => targetSet.has(item));

      if (!setsEqual) {
        throw new Error('BOM_ITEMS_MISMATCH');
      }

      // Create new revision with incremented number
      const nextRevision = (latestRevision?.revision ?? 0) + 1;

      const { data: newRevision, error: revError } = await supabase
        .from('bom_price_revisions')
        .insert({
          bom_id: bomId,
          revision: nextRevision,
          note: `reverted to r${targetRevision.revision}`,
        })
        .select()
        .single();
      if (revError) throw revError;

      // Copy items from target revision to new revision
      const copiedItems = targetItems.map(item => ({
        bom_price_revision_id: newRevision.id,
        sku_id: item.sku_id,
        quantity: item.quantity,
        cost_ex_vat: item.cost_ex_vat,
        sell_ex_vat: item.sell_ex_vat,
        vat_rate: item.vat_rate,
        margin_pct: item.margin_pct,
      }));

      const { error: itemsError } = await supabase
        .from('bom_price_revision_items')
        .insert(copiedItems);
      if (itemsError) throw itemsError;

      return { newRevision, targetRevision: targetRevision.revision };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['bom_price_revisions', bomId] });
      toast({ 
        title: t('Prisrevision återställd', 'Pricing revision reverted'),
        description: t(
          `Ny revision r${data.newRevision.revision} skapad från r${data.targetRevision}`,
          `New revision r${data.newRevision.revision} created from r${data.targetRevision}`
        )
      });
    },
    onError: (error: any) => {
      if (error.message === 'BOM_ITEMS_MISMATCH') {
        toast({ 
          title: t('Kan inte återställa', 'Cannot revert'),
          description: t(
            'Denna prisrevision tillhör en annan BOM-konfiguration och kan inte återställas.',
            'This pricing revision belongs to a different BOM configuration and cannot be reverted.'
          ), 
          variant: 'destructive' 
        });
      } else {
        toast({ 
          title: t('Kunde inte återställa prisrevision', 'Failed to revert pricing revision'), 
          description: error.message, 
          variant: 'destructive' 
        });
      }
    },
  });

  // Ensure a pricing revision exists (for quote creation)
  const ensureRevisionExists = async (bomItems: BOMItem[]): Promise<PriceRevision> => {
    if (latestRevision) {
      return latestRevision;
    }
    // Create r1 automatically
    const result = await createRevisionMutation.mutateAsync(bomItems);
    return result.revision;
  };

  return {
    revisions,
    latestRevision,
    revisionsLoading,
    createRevision: createRevisionMutation.mutate,
    createRevisionAsync: createRevisionMutation.mutateAsync,
    isCreatingRevision: createRevisionMutation.isPending,
    revertRevision: revertRevisionMutation.mutate,
    isReverting: revertRevisionMutation.isPending,
    ensureRevisionExists,
    fetchRevisionItems,
  };
}
