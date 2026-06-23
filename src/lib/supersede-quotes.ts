import { supabase } from '@/integrations/supabase/client';

/**
 * Supersede all active quotes in the same offer chain when a new quote revision is created.
 *
 * Uses bom_group_id to identify the chain. Quotes in terminal statuses
 * (accepted, invoiced, cancelled, expired, superseded, declined) are never touched.
 *
 * @returns Array of superseded quote IDs
 */
export async function supersedeActiveQuotesInChain({
  newQuoteId,
  bomId,
}: {
  newQuoteId: string;
  bomId: string;
}): Promise<string[]> {
  // 1. Get bom_group_id for the BOM
  const { data: bom, error: bomError } = await supabase
    .from('boms')
    .select('bom_group_id')
    .eq('id', bomId)
    .single();

  if (bomError || !bom) {
    console.warn('[supersede] Could not find BOM', bomId, bomError);
    return [];
  }

  const bomGroupId = (bom as { bom_group_id?: string }).bom_group_id;
  if (!bomGroupId) {
    console.warn('[supersede] BOM has no bom_group_id', bomId);
    return [];
  }

  // 2. Find all BOMs in the group
  const { data: bomsInGroup } = await supabase
    .from('boms')
    .select('id')
    .eq('bom_group_id', bomGroupId);

  const bomIds = (bomsInGroup || []).map(b => b.id);
  if (bomIds.length === 0) return [];

  // 3. Find all active quotes linked to those BOMs (excluding the new one)
  const activeStatuses = ['draft', 'sent', 'viewed', 'revision_requested'];

  const { data: activeQuotes, error: queryError } = await supabase
    .from('quotes')
    .select('id')
    .in('bom_id', bomIds)
    .in('status', activeStatuses)
    .neq('id', newQuoteId);

  if (queryError || !activeQuotes || activeQuotes.length === 0) return [];

  const quoteIds = activeQuotes.map(q => q.id);

  // 4. Update: status = 'superseded', superseded_at, superseded_by_quote_id, is_latest = false
  const { error: updateError } = await supabase
    .from('quotes')
    .update({
      status: 'superseded',
      superseded_at: new Date().toISOString(),
      superseded_by_quote_id: newQuoteId,
      is_latest: false,
    })
    .in('id', quoteIds);

  if (updateError) {
    console.error('[supersede] Failed to update quotes', updateError);
    return [];
  }

  // 5. Log superseded events
  const events = quoteIds.map(qId => ({
    quote_id: qId,
    event_type: 'superseded',
    actor_type: 'system',
    metadata: { superseded_by_quote_id: newQuoteId },
  }));

  await supabase.from('quote_events').insert(events);

  console.log(`[supersede] Superseded ${quoteIds.length} quotes for new quote ${newQuoteId}`);
  return quoteIds;
}
