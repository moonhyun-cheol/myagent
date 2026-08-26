/**
 * Public façade for workspace indexing and retrieval.
 * Implementations live under `core/src/agent/index/`.
 */
export {
  enrichWorkspaceIndexContext,
} from './agent-workspace-index.js';

export {
  queryRepoMap,
  invalidateRepoMapCache,
  buildRepoMapContext,
  focusTokensFromMessage,
  type RepoSymbol,
} from './repo-map.js';

export {
  searchEmbeddingIndexAsync,
  invalidateEmbeddingIndex,
  buildEmbeddingSearchContext,
} from './agent-embedding-index.js';

export {
  buildSymbolChunkContext,
} from './agent-symbol-chunks.js';
