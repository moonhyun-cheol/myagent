export interface DocumentNote { id: string; quote: string; note: string; from: number; to: number; revision: number; kind: 'highlight' | 'reference'; detached?: boolean }
export interface DocumentRecord { id: string; title: string; markdown: string; revision: number; hash: string; notes: DocumentNote[]; updatedAt: string }
export type DocumentSummary = Pick<DocumentRecord, 'id' | 'title' | 'revision' | 'updatedAt'>;
export async function documentApi<T>(session: string, suffix = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/workspace/documents${suffix}`, { method, headers: { 'Content-Type':'application/json', 'X-CQR-Session':session }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `문서 요청 실패 (${response.status})`);
  return result as T;
}
export const DOCUMENT_REQUEST_EVENT = 'my-agent-document-request';
