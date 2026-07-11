export interface PurchaseReviewNavigationState {
  purchaseReview: {
    source: 'upload_batch';
    purchaseIds: string[];
  };
}

export interface PurchaseReviewAfterDelete {
  destinationPurchaseId: string | null;
  remainingPurchaseIds: string[];
}

function validatePurchaseIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const id = item.trim();
    if (!id || seen.has(id)) return null;
    ids.push(id);
    seen.add(id);
  }

  return ids;
}

export function createBatchPurchaseReviewState(
  purchaseIds: string[],
): PurchaseReviewNavigationState | null {
  const validatedIds = validatePurchaseIds(purchaseIds);
  if (!validatedIds) return null;

  return {
    purchaseReview: {
      source: 'upload_batch',
      purchaseIds: validatedIds,
    },
  };
}

export function readBatchPurchaseReviewIds(
  state: unknown,
  currentPurchaseId: string | null | undefined,
): string[] | null {
  if (!state || typeof state !== 'object' || !currentPurchaseId) return null;

  const navigation = (state as Partial<PurchaseReviewNavigationState>).purchaseReview;
  if (!navigation || navigation.source !== 'upload_batch') return null;

  const purchaseIds = validatePurchaseIds(navigation.purchaseIds);
  return purchaseIds?.includes(currentPurchaseId) ? purchaseIds : null;
}

export function getPurchaseReviewAfterDelete(
  purchaseIds: string[],
  deletedPurchaseId: string,
): PurchaseReviewAfterDelete {
  const deletedIndex = purchaseIds.indexOf(deletedPurchaseId);
  if (deletedIndex === -1) {
    throw new Error('Deleted purchase is not in the active review sequence');
  }

  return {
    destinationPurchaseId:
      purchaseIds[deletedIndex + 1] ?? purchaseIds[deletedIndex - 1] ?? null,
    remainingPurchaseIds: purchaseIds.filter((id) => id !== deletedPurchaseId),
  };
}
