import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';

interface BomInfo {
  id: string;
  version: number;
  bom_group_id: string;
  project_name: string;
  customer_id: string | null;
}

interface UseInvoiceBomRevisionOptions {
  invoiceId: string | null;
  bomId: string | null;
}

/**
 * Hook for managing BOM revisions triggered from the invoice draft editor.
 *
 * When a user adds an SKU from the invoice, this hook determines whether:
 * - Case A: The current BOM is locked → prompt to create a new revision
 * - Case B: An editable BOM revision already exists → silently reuse it
 *
 * Mirrors the exact lifecycle used by quotes.
 */
export function useInvoiceBomRevision({ invoiceId, bomId }: UseInvoiceBomRevisionOptions) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const [showRevisionDialog, setShowRevisionDialog] = useState(false);
  const [pendingSkuAction, setPendingSkuAction] = useState<{
    skuId: string;
    quantity: number;
    skuData: { sku: string; name: string; sell_price_ex_vat: number | null; vat_rate: number };
  } | null>(null);

  // Fetch current BOM info
  const { data: currentBom } = useQuery({
    queryKey: ['invoice-bom-info', bomId],
    queryFn: async () => {
      if (!bomId) return null;
      const { data, error } = await supabase
        .from('boms')
        .select('id, version, bom_group_id, project_name, customer_id')
        .eq('id', bomId)
        .single();
      if (error) throw error;
      return data as BomInfo;
    },
    enabled: !!bomId,
  });

  // Fetch all BOM versions in the group
  const { data: groupVersions = [] } = useQuery({
    queryKey: ['bom-group-versions', currentBom?.bom_group_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('boms')
        .select('id, version, bom_group_id')
        .eq('bom_group_id', currentBom!.bom_group_id)
        .order('version', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!currentBom?.bom_group_id,
  });

  // Check if a BOM version is locked (by quote or finalized invoice)
  const isVersionLocked = async (bomVersionId: string, version: number): Promise<boolean> => {
    // Check quotes
    const { count: quoteCount } = await supabase
      .from('quotes')
      .select('id', { count: 'exact', head: true })
      .eq('bom_id', bomVersionId)
      .eq('bom_version', version)
      .in('status', ['sent', 'viewed', 'accepted', 'revision_requested']);

    if ((quoteCount ?? 0) > 0) return true;

    // Check finalized invoices
    const { count: invoiceCount } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('bom_id', bomVersionId)
      .in('status', ['open', 'paid']);

    return (invoiceCount ?? 0) > 0;
  };

  // Find an existing editable (unlocked) BOM revision in the group
  const findEditableRevision = async (): Promise<BomInfo | null> => {
    for (const ver of groupVersions) {
      if (ver.version <= (currentBom?.version ?? 0)) continue;
      const locked = await isVersionLocked(ver.id, ver.version);
      if (!locked) {
        // Fetch full info
        const { data } = await supabase
          .from('boms')
          .select('id, version, bom_group_id, project_name, customer_id')
          .eq('id', ver.id)
          .single();
        return data as BomInfo | null;
      }
    }
    return null;
  };

  // Create a new BOM revision from invoice context
  const createRevisionMutation = useMutation({
    mutationFn: async ({ skuId, quantity }: { skuId: string; quantity: number }) => {
      if (!currentBom || !invoiceId) throw new Error('Missing BOM or invoice');

      const newVersion = Math.max(...groupVersions.map(v => v.version), currentBom.version) + 1;

      // Get the latest BOM's items to copy
      const latestBomId = groupVersions[0]?.id || currentBom.id;
      const { data: existingItems } = await supabase
        .from('bom_items')
        .select('sku_id, quantity, cost_ex_vat_at_time')
        .eq('bom_id', latestBomId);

      // Create new BOM
      const { data: newBom, error: bomError } = await supabase
        .from('boms')
        .insert({
          project_name: currentBom.project_name,
          customer_id: currentBom.customer_id,
          version: newVersion,
          bom_group_id: currentBom.bom_group_id,
          revision_reason_type: 'invoice_change',
          revision_reason_note: 'Invoice draft added hardware requiring a new BOM revision',
          revision_created_by: user?.id,
          revision_created_at: new Date().toISOString(),
        } as any)
        .select()
        .single();
      if (bomError) throw bomError;

      // Copy existing items + add new SKU
      const itemsToInsert = [
        ...(existingItems || []).map(item => ({
          bom_id: newBom.id,
          sku_id: item.sku_id,
          quantity: item.quantity,
          cost_ex_vat_at_time: item.cost_ex_vat_at_time,
        })),
      ];

      // Check if SKU already exists in copied items
      const existingSkuItem = itemsToInsert.find(i => i.sku_id === skuId);
      if (existingSkuItem) {
        existingSkuItem.quantity += quantity;
      } else {
        // Get cost for new SKU
        const { data: skuCost } = await supabase
          .from('skus')
          .select('cost_ex_vat_computed')
          .eq('id', skuId)
          .single();

        itemsToInsert.push({
          bom_id: newBom.id,
          sku_id: skuId,
          quantity,
          cost_ex_vat_at_time: skuCost?.cost_ex_vat_computed ?? null,
        });
      }

      if (itemsToInsert.length > 0) {
        const { error: itemsError } = await supabase.from('bom_items').insert(itemsToInsert);
        if (itemsError) throw itemsError;
      }

      // Log bom_event
      await supabase.from('bom_events' as any).insert({
        bom_id: newBom.id,
        event_type: 'revision_created',
        actor_email: user?.email,
        actor_type: 'staff',
        metadata: {
          from_version: currentBom.version,
          to_version: newVersion,
          reason_type: 'invoice_change',
          reason_note: 'Invoice draft added hardware requiring a new BOM revision',
          source_bom_id: currentBom.id,
          source_document_type: 'invoice',
          source_document_stage: 'draft',
          internal_invoice_id: invoiceId,
        },
      });

      // Update invoice to point to new BOM
      await supabase
        .from('invoices')
        .update({ bom_id: newBom.id, bom_version: newVersion })
        .eq('id', invoiceId);

      return newBom;
    },
    onSuccess: (newBom) => {
      setShowRevisionDialog(false);
      setPendingSkuAction(null);
      toast({
        title: t(
          `Ny BOM-revision #${newBom.version} skapad`,
          `New BOM revision #${newBom.version} created`
        ),
        description: t(
          'Den förblir redigerbar tills fakturan fastställs.',
          'It will remain editable until the invoice is finalized.'
        ),
      });
      queryClient.invalidateQueries({ queryKey: ['invoice-bom-info'] });
      queryClient.invalidateQueries({ queryKey: ['bom-group-versions'] });
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      queryClient.invalidateQueries({ queryKey: ['bom_items_for_invoice'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Kunde inte skapa BOM-revision', 'Failed to create BOM revision'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // Add SKU to existing editable BOM revision (silently)
  const addSkuToExistingRevision = async (editableBom: BomInfo, skuId: string, quantity: number) => {
    // Get cost
    const { data: skuCost } = await supabase
      .from('skus')
      .select('cost_ex_vat_computed')
      .eq('id', skuId)
      .single();

    // Check if SKU already in BOM
    const { data: existingItem } = await supabase
      .from('bom_items')
      .select('id, quantity')
      .eq('bom_id', editableBom.id)
      .eq('sku_id', skuId)
      .maybeSingle();

    if (existingItem) {
      await supabase
        .from('bom_items')
        .update({ quantity: existingItem.quantity + quantity })
        .eq('id', existingItem.id);
    } else {
      await supabase.from('bom_items').insert({
        bom_id: editableBom.id,
        sku_id: skuId,
        quantity,
        cost_ex_vat_at_time: skuCost?.cost_ex_vat_computed ?? null,
      });
    }

    // Update invoice to point to this BOM if not already
    if (invoiceId) {
      await supabase
        .from('invoices')
        .update({ bom_id: editableBom.id, bom_version: editableBom.version })
        .eq('id', invoiceId);
    }

    toast({
      title: t('Tillagd i faktura och BOM-utkast', 'Added to invoice and current BOM draft'),
    });

    queryClient.invalidateQueries({ queryKey: ['bom_items_for_invoice'] });
    queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
  };

  /**
   * Main entry point: called when user selects an SKU from the picker.
   * Returns whether the SKU was handled (added to BOM) or just added to invoice only.
   */
  const handleSkuAddedFromInvoice = async (
    skuId: string,
    quantity: number,
    skuData: { sku: string; name: string; sell_price_ex_vat: number | null; vat_rate: number }
  ): Promise<'no_bom' | 'editable_found' | 'needs_confirmation'> => {
    if (!bomId || !currentBom) return 'no_bom';

    // Check if current BOM is locked
    const currentLocked = await isVersionLocked(currentBom.id, currentBom.version);

    if (!currentLocked) {
      // Current BOM is editable — add directly
      await addSkuToExistingRevision(currentBom, skuId, quantity);
      return 'editable_found';
    }

    // Look for an existing editable revision
    const editable = await findEditableRevision();
    if (editable) {
      await addSkuToExistingRevision(editable, skuId, quantity);
      return 'editable_found';
    }

    // No editable revision — need confirmation
    setPendingSkuAction({ skuId, quantity, skuData });
    setShowRevisionDialog(true);
    return 'needs_confirmation';
  };

  const confirmRevision = () => {
    if (!pendingSkuAction) return;
    createRevisionMutation.mutate({
      skuId: pendingSkuAction.skuId,
      quantity: pendingSkuAction.quantity,
    });
  };

  const cancelRevision = () => {
    setShowRevisionDialog(false);
    setPendingSkuAction(null);
  };

  // Latest BOM version in group (for display)
  const latestVersion = groupVersions.length > 0 ? groupVersions[0] : null;

  return {
    currentBom,
    latestVersion,
    showRevisionDialog,
    pendingSkuAction,
    isCreatingRevision: createRevisionMutation.isPending,
    handleSkuAddedFromInvoice,
    confirmRevision,
    cancelRevision,
  };
}
