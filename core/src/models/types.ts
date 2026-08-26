export type ModelKind = 'llm' | 'image';

export interface ModelRecord {
  id: string;
  kind: ModelKind;
  filename: string;
  path: string;
  rel_path: string;
  format: string;
  size_bytes: number;
  last_scanned: string;
  last_verified: string | null;
  verified_ok: boolean | null;
  verify_note: string | null;
}

export interface ModelRegistryFile {
  version: 1;
  default_llm_id: string | null;
  default_image_id: string | null;
  models: ModelRecord[];
}
