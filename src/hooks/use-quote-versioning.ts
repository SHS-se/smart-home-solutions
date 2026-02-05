import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface QuoteVersion {
  id: string;
  quote_number: string | null;
  version: number;
  status: string;
  created_at: string;
  is_latest: boolean;
  bom_price_revision_id: string | null;
}

interface PriceDiffItem {
  sku_id: string;
  sku_name: string;
  sku_code: string;
  quantity: number;
  old_unit_price: number;
  new_unit_price: number;
  delta_per_unit: number;
  delta_total: number;
}

interface PriceDiffResult {
  items: PriceDiffItem[];
  old_total_ex_vat: number;
  new_total_ex_vat: number;
  delta_total_ex_vat: number;
  old_total_inc_vat: number;
  new_total_inc_vat: number;
  delta_total_inc_vat: number;
}

export function useQuoteVersioning(quoteId: string | undefined) {
  const queryClient = useQueryClient();

  // Fetch all versions in the quote family
  const { data: quoteFamily = [], isLoading: isFamilyLoading } = useQuery({
    queryKey: ['quote_family', quoteId],
    queryFn: async () => {
      if (!quoteId) return [];

      // First get the current quote to find parent
      const { data: currentQuote, error: currentError } = await supabase
        .from('quotes')
        .select('id, parent_quote_id, quote_number')
        .eq('id', quoteId)
        .single();

      if (currentError) throw currentError;

      // Find the root quote ID (either parent_quote_id or current if it's v1)
      const rootId = currentQuote.parent_quote_id || currentQuote.id;

      // Fetch all quotes in the family (where parent_quote_id = rootId OR id = rootId)
      const { data, error } = await supabase
        .from('quotes')
        .select('id, quote_number, version, status, created_at, is_latest, bom_price_revision_id')
        .or(`id.eq.${rootId},parent_quote_id.eq.${rootId}`)
        .order('version', { ascending: false });

      if (error) throw error;
      return data as QuoteVersion[];
    },
    enabled: !!quoteId,
  });

  // Check if quote has outdated pricing
  const { data: pricingStatus, isLoading: isPricingStatusLoading } = useQuery({
    queryKey: ['quote_pricing_status', quoteId],
    queryFn: async () => {
      if (!quoteId) return null;

      // Get current quote details
      const { data: quote, error: quoteError } = await supabase
        .from('quotes')
        .select('bom_id, bom_version, bom_price_revision_id')
        .eq('id', quoteId)
        .single();

      if (quoteError) throw quoteError;
      if (!quote.bom_id || !quote.bom_price_revision_id) {
        return { isOutdated: false, quoteRevision: null, latestRevision: null, latestRevisionId: null };
      }

      // Get quote's pricing revision number
      const { data: quoteRevision, error: qRevError } = await supabase
        .from('bom_price_revisions')
        .select('revision')
        .eq('id', quote.bom_price_revision_id)
        .single();

      if (qRevError) throw qRevError;

      // Get latest pricing revision for this BOM
      const { data: latestRevision, error: latestError } = await supabase
        .from('bom_price_revisions')
        .select('id, revision')
        .eq('bom_id', quote.bom_id)
        .order('revision', { ascending: false })
        .limit(1)
        .single();

      if (latestError && latestError.code !== 'PGRST116') throw latestError;

      const isOutdated = latestRevision && latestRevision.revision > quoteRevision.revision;

      return {
        isOutdated,
        quoteRevision: quoteRevision.revision,
        latestRevision: latestRevision?.revision || quoteRevision.revision,
        latestRevisionId: latestRevision?.id || quote.bom_price_revision_id,
      };
    },
    enabled: !!quoteId,
  });

  // Compute price diff between quote snapshot and latest revision
  const computePriceDiff = async (): Promise<PriceDiffResult | null> => {
    if (!quoteId || !pricingStatus?.isOutdated || !pricingStatus.latestRevisionId) {
      return null;
    }

    // Get current quote's pricing revision items
    const { data: quote } = await supabase
      .from('quotes')
      .select('bom_price_revision_id')
      .eq('id', quoteId)
      .single();

    if (!quote?.bom_price_revision_id) return null;

    // Get old prices from quote's revision
    const { data: oldItems, error: oldError } = await supabase
      .from('bom_price_revision_items')
      .select('sku_id, quantity, sell_ex_vat, vat_rate, skus(name, sku)')
      .eq('bom_price_revision_id', quote.bom_price_revision_id);

    if (oldError) throw oldError;

    // Get new prices from latest revision
    const { data: newItems, error: newError } = await supabase
      .from('bom_price_revision_items')
      .select('sku_id, quantity, sell_ex_vat, vat_rate')
      .eq('bom_price_revision_id', pricingStatus.latestRevisionId);

    if (newError) throw newError;

    // Create lookup for new prices
    const newPriceMap = new Map(newItems.map(item => [item.sku_id, item]));

    const diffItems: PriceDiffItem[] = [];
    let oldTotalExVat = 0;
    let newTotalExVat = 0;

    for (const oldItem of oldItems) {
      const newItem = newPriceMap.get(oldItem.sku_id);
      const oldUnitPrice = oldItem.sell_ex_vat;
      const newUnitPrice = newItem?.sell_ex_vat ?? oldUnitPrice;
      const quantity = oldItem.quantity;

      const deltaPerUnit = newUnitPrice - oldUnitPrice;
      const deltaTotal = deltaPerUnit * quantity;

      oldTotalExVat += oldUnitPrice * quantity;
      newTotalExVat += newUnitPrice * quantity;

      diffItems.push({
        sku_id: oldItem.sku_id,
        sku_name: (oldItem.skus as any)?.name || 'Unknown',
        sku_code: (oldItem.skus as any)?.sku || '',
        quantity,
        old_unit_price: oldUnitPrice,
        new_unit_price: newUnitPrice,
        delta_per_unit: deltaPerUnit,
        delta_total: deltaTotal,
      });
    }

    const vatRate = 0.25;
    return {
      items: diffItems,
      old_total_ex_vat: oldTotalExVat,
      new_total_ex_vat: newTotalExVat,
      delta_total_ex_vat: newTotalExVat - oldTotalExVat,
      old_total_inc_vat: oldTotalExVat * (1 + vatRate),
      new_total_inc_vat: newTotalExVat * (1 + vatRate),
      delta_total_inc_vat: (newTotalExVat - oldTotalExVat) * (1 + vatRate),
    };
  };

  // Create new quote version with updated pricing
  const createNewVersionMutation = useMutation({
    mutationFn: async () => {
      if (!quoteId || !pricingStatus?.latestRevisionId) {
        throw new Error('Missing quote or pricing revision');
      }

      // Get current quote
      const { data: currentQuote, error: quoteError } = await supabase
        .from('quotes')
        .select('*')
        .eq('id', quoteId)
        .single();

      if (quoteError) throw quoteError;

      // Find root quote ID
      const rootId = currentQuote.parent_quote_id || currentQuote.id;

      // Get max version in family
      const { data: maxVersionData } = await supabase
        .from('quotes')
        .select('version')
        .or(`id.eq.${rootId},parent_quote_id.eq.${rootId}`)
        .order('version', { ascending: false })
        .limit(1)
        .single();

      const newVersion = (maxVersionData?.version || 1) + 1;

      // Mark all existing quotes in family as not latest
      await supabase
        .from('quotes')
        .update({ is_latest: false })
        .or(`id.eq.${rootId},parent_quote_id.eq.${rootId}`);

      // Get latest pricing revision items for hardware
      const { data: revisionItems } = await supabase
        .from('bom_price_revision_items')
        .select('sku_id, quantity, cost_ex_vat, sell_ex_vat, vat_rate, margin_pct, skus(name, sku)')
        .eq('bom_price_revision_id', pricingStatus.latestRevisionId);

      const hardwareTotal = (revisionItems || []).reduce(
        (acc, item) => acc + (item.quantity * item.sell_ex_vat),
        0
      );

      // Get existing labor/travel lines to preserve totals
      const { data: existingLines } = await supabase
        .from('quote_lines')
        .select('*')
        .eq('quote_id', currentQuote.id);

      const laborLines = (existingLines || []).filter(l => l.section === 'labor');
      const travelLines = (existingLines || []).filter(l => l.section === 'travel');

      const laborTotal = laborLines.reduce((acc, l) => acc + (l.quantity * (l.unit_price_ex_vat ?? l.unit_price)), 0);
      const travelTotal = travelLines.reduce((acc, l) => acc + (l.quantity * (l.unit_price_ex_vat ?? l.unit_price)), 0);
      const subtotal = hardwareTotal + laborTotal + travelTotal;

      // Create new quote
      const { data: newQuote, error: createError } = await supabase
        .from('quotes')
        .insert({
          // New versions don't get a quote_number until sent to Stripe
          version: newVersion,
          parent_quote_id: rootId,
          supersedes_quote_id: currentQuote.id,
          is_latest: true,
          bom_id: currentQuote.bom_id,
          bom_version: currentQuote.bom_version,
          bom_price_revision_id: pricingStatus.latestRevisionId,
          customer_id: currentQuote.customer_id,
          status: 'draft',
          created_by: currentQuote.created_by,
        })
        .select()
        .single();

      if (createError) throw createError;

      // Create new hardware lines from latest pricing revision (updated prices)
      if (revisionItems && revisionItems.length > 0) {
        const newHardwareLines = revisionItems.map(item => ({
          quote_id: newQuote.id,
          section: 'hardware',
          description: (item.skus as any)?.name || 'Unknown',
          quantity: item.quantity,
          unit_price: item.sell_ex_vat,
          unit_price_ex_vat: item.sell_ex_vat,
          vat_rate: item.vat_rate,
          unit_price_inc_vat: item.sell_ex_vat * (1 + item.vat_rate),
          sku_id: item.sku_id,
          cost_ex_vat_at_time: item.cost_ex_vat,
          original_sku_name: (item.skus as any)?.name || null,
          original_sku_code: (item.skus as any)?.sku || null,
          pricing_source: 'bom',
          source_bom_id: currentQuote.bom_id,
        }));

        await supabase.from('quote_lines').insert(newHardwareLines);
      }

      // Copy labor and travel lines (unchanged)
      const nonHardwareLines = (existingLines || []).filter(l => l.section !== 'hardware');
      if (nonHardwareLines.length > 0) {
        const copiedLines = nonHardwareLines.map(line => ({
          quote_id: newQuote.id,
          section: line.section,
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unit_price,
          unit_price_ex_vat: line.unit_price_ex_vat,
          vat_rate: line.vat_rate,
          unit_price_inc_vat: line.unit_price_inc_vat,
          sku_id: line.sku_id,
          cost_ex_vat_at_time: line.cost_ex_vat_at_time,
          original_sku_name: line.original_sku_name,
          original_sku_code: line.original_sku_code,
          pricing_source: line.pricing_source,
        }));

        await supabase.from('quote_lines').insert(copiedLines);
      }

      return newQuote;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quote_family'] });
      queryClient.invalidateQueries({ queryKey: ['quotes'] });
    },
  });

  return {
    quoteFamily,
    isFamilyLoading,
    pricingStatus,
    isPricingStatusLoading,
    computePriceDiff,
    createNewVersion: createNewVersionMutation.mutateAsync,
    isCreatingVersion: createNewVersionMutation.isPending,
  };
}
