export interface WebSearchAugmentResult {
  applied: boolean;
  query: string;
  context: string;
  sourceCount: number;
}

/** Web search integration removed — always no-op. */
export function shouldAutoWebSearch(_message: string, _cqrRoot: string, _explicit = false): boolean {
  return false;
}

export async function augmentWithWebSearch(
  message: string,
  _providerStore: unknown,
  _opts?: { maxResults?: number; explicit?: boolean; cqrRoot?: string },
): Promise<WebSearchAugmentResult> {
  return { applied: false, query: message, context: '', sourceCount: 0 };
}

export function mergeSearchContext(
  attachmentContext: string | undefined,
  searchContext: string,
  workspaceContext?: string,
): string {
  const parts = [attachmentContext, workspaceContext, searchContext].filter(Boolean);
  return parts.join('\n\n');
}
