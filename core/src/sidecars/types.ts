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
};
