/** UI-reported busy flags (mutate review, etc.) for update idle gate. */

let mutateReviewPending = false;
let updatedAt = 0;

export function setMutateReviewPending(pending: boolean): void {
  mutateReviewPending = pending;
  updatedAt = Date.now();
}

export function isMutateReviewPending(): boolean {
  return mutateReviewPending;
}

export function uiBusySnapshot(): { mutate_review_pending: boolean; updated_at: number } {
  return {
    mutate_review_pending: mutateReviewPending,
    updated_at: updatedAt,
  };
}
