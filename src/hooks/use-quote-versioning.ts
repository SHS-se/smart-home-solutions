import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { supersedeActiveQuotesInChain } from '@/lib/supersede-quotes';

interface QuoteVersion {
  id: string;
  quote_number: string | null;
  version: number;
  status: string;
  created_at: string;
  is_latest: boolean;
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

      // Fetch all quotes in the family
      const { data, error } = await supabase
        .from('quotes')
        .select('id, quote_number, version, status, created_at, is_latest')
        .or(`id.eq.${rootId},parent_quote_id.eq.${rootId}`)
        .order('version', { ascending: false });

      if (error) throw error;
      return data as QuoteVersion[];
    },
    enabled: !!quoteId,
  });

  // Create new quote version by copying current quote's lines
  const createNewVersionMutation = useMutation({
    mutationFn: async ({ updatedHardwareQuantities }: { updatedHardwareQuantities?: Record<string, number> } = {}) => {
      if (!quoteId) throw new Error('Missing quoteId');

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

      // Mark all existing quotes in family as not latest (is_latest only, superseding handled after insert)
      await supabase
        .from('quotes')
        .update({ is_latest: false })
        .or(`id.eq.${rootId},parent_quote_id.eq.${rootId}`);

      // Get existing lines to copy
      const { data: existingLines } = await supabase
        .from('quote_lines')
        .select('*')
        .eq('quote_id', currentQuote.id);

      // Create new quote
      const { data: newQuote, error: createError } = await supabase
        .from('quotes')
        .insert({
          version: newVersion,
          parent_quote_id: rootId,
          supersedes_quote_id: currentQuote.id,
          is_latest: true,
          bom_id: currentQuote.bom_id,
          bom_version: currentQuote.bom_version,
          customer_id: currentQuote.customer_id,
          status: 'draft',
          created_by: currentQuote.created_by,
        })
        .select()
        .single();

      if (createError) throw createError;

      // Copy all lines, optionally updating hardware quantities
      if (existingLines && existingLines.length > 0) {
        const copiedLines = existingLines.map(line => {
          const quantity = (line.section === 'hardware' && updatedHardwareQuantities && line.sku_id && updatedHardwareQuantities[line.sku_id] !== undefined)
            ? updatedHardwareQuantities[line.sku_id]
            : line.quantity;
          
          return {
            quote_id: newQuote.id,
            section: line.section,
            description: line.description,
            quantity,
            unit_price: line.unit_price,
            unit_price_ex_vat: line.unit_price_ex_vat,
            vat_rate: line.vat_rate,
            unit_price_inc_vat: line.unit_price_inc_vat,
            sku_id: line.sku_id,
            cost_ex_vat_at_time: line.cost_ex_vat_at_time,
            original_sku_name: line.original_sku_name,
            original_sku_code: line.original_sku_code,
            pricing_source: line.pricing_source,
            source_bom_id: line.source_bom_id,
            source_bom_item_id: line.source_bom_item_id,
            source_bom_version: line.source_bom_version,
          };
        });

        await supabase.from('quote_lines').insert(copiedLines);
      }

      // Supersede active quotes in the chain
      if (currentQuote.bom_id) {
        await supersedeActiveQuotesInChain({ newQuoteId: newQuote.id, bomId: currentQuote.bom_id });
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
    createNewVersion: createNewVersionMutation.mutateAsync,
    isCreatingVersion: createNewVersionMutation.isPending,
  };
}
