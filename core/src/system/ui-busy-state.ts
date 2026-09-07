/** UI-reported busy flags (mutate review, workspace work) for update idle gate. */

let mutateReviewPending = false;
let workspaceBusy = false;
let updatedAt = 0;

export function setMutateReviewPending(pending: boolean): void {
  mutateReviewPending = pending;
  updatedAt = Date.now();
}

export function isMutateReviewPending(): boolean {
  return mutateReviewPending;
}

export function setWorkspaceBusy(pending: boolean): void {
  workspaceBusy = pending;
  updatedAt = Date.now();
}

export function isWorkspaceBusy(): boolean {
  return workspaceBusy;
}

export function uiBusySnapshot(): {
  mutate_review_pending: boolean;
  workspace_busy: boolean;
  updated_at: number;
} {
  return {
    mutate_review_pending: mutateReviewPending,
    workspace_busy: workspaceBusy,
    updated_at: updatedAt,
  };
}
