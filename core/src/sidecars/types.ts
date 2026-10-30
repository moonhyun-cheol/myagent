/** Shared sidecar I/O contract (ADR-009). */
export type SidecarEvidence = {
  kind: 'stdout' | 'stderr' | 'path' | 'exit';
  detail: string;
};

export type SidecarResult = {
  ok: boolean;
  engine: string;
  summaryKo: string;
  artifacts: string[];
  mutations: string[];
  evidence: SidecarEvidence[];
  error?: string;
  hitlRequired?: boolean;
  rawLog?: string;
  coverage?: {
    total_chars: number;
    start_char: number;
    end_char: number;
    truncated: boolean;
    next_start_char: number | null;
    sha256: string;
    source_complete: boolean;
    guidance: string;
    warning?: string;
  };
};
