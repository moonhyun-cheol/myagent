export interface EvidenceLineRange {
  start: number;
  end: number;
}

export interface EvidenceCoverage {
  lines?: EvidenceLineRange[];
  totalLines?: number;
  returnedRanges?: EvidenceLineRange[];
  omittedRanges?: EvidenceLineRange[];
}

export interface EvidenceSource {
  path?: string;
  kind?: 'workspace_file' | 'tool_output' | 'browser' | 'terminal' | 'other';
}

/** Durable metadata for one exact tool outcome. The body is stored outside session meta. */
export interface EvidenceRecord {
  version: 1;
  evidenceId: string;
  runId: string;
  sessionId?: string;
  tool: string;
  args: Record<string, unknown>;
  source?: EvidenceSource;
  coverage?: EvidenceCoverage;
  complete: boolean;
  fingerprint: string;
  ok: boolean;
  at: string;
  bytes: number;
  bodyFile: string;
  /** New evidence must be shown in full once before it may be projected as a reference. */
  observedByModel: boolean;
}

export interface EvidenceSelector {
  evidenceId: string;
  lines?: EvidenceLineRange[];
  keys?: string[];
}

export type EvidenceProjectionForm = 'exact' | 'digest' | 'reference';

export interface EvidenceReadResult {
  record: EvidenceRecord;
  content: string;
  selectedLines?: EvidenceLineRange[];
}
