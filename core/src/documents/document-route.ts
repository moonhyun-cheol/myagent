import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sessionFromReq } from '../http/json.js';
import { DocumentError, getDocumentStore } from './document-store.js';
import { getProjectDocumentStore, type ProjectDocumentStore } from './project-document-store.js';

export interface DocumentRouteContext {
  projectForSession?: (session: string) => string | null;
  workspaceRootForSession?: (session: string) => string | null;
  projectDocuments?: ProjectDocumentStore;
  sessions?: () => { id: string; title: string }[];
  attachments?: (session: string) => { id: string; name: string }[];
  attachment?: (session: string, id: string) => { id: string; name: string; mime: string; bytes: Buffer } | null;
}

export async function documentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  sessionExists: (id: string) => boolean,
  storeProvider = getDocumentStore,
  context: DocumentRouteContext = {},
): Promise<void> {
  try {
    const session = sessionFromReq(req);
    if (!sessionExists(session)) throw new DocumentError(404, '먼저 챗을 생성하거나 선택하세요.');
    const suffix = url.pathname.slice('/workspace/documents'.length);
    const workspaceRoot = context.workspaceRootForSession?.(session) ?? null;
    if (workspaceRoot) {
      const projectDocuments = context.projectDocuments ?? getProjectDocumentStore();
      if (method === 'GET' && suffix === '') {
        return sendJson(res, 200, {
          documents: projectDocuments.list(workspaceRoot),
          root: workspaceRoot,
          projectRoot: true,
        });
      }
      const projectMatch = /^\/([a-f0-9-]{36})$/.exec(suffix);
      if (method === 'GET' && projectMatch) {
        return sendJson(res, 200, projectDocuments.get(workspaceRoot, projectMatch[1]));
      }
      if ((method === 'POST' && suffix === '') || (method === 'PUT' && projectMatch)) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 3_000_000) throw new DocumentError(413, '요청이 너무 큽니다.');
          chunks.push(Buffer.from(chunk));
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw new DocumentError(400, '잘못된 JSON입니다.');
        }
        if (!body || typeof body !== 'object') throw new DocumentError(400, '문서가 필요합니다.');
        return sendJson(
          res,
          200,
          projectDocuments.save(workspaceRoot, projectMatch?.[1] ?? null, body),
        );
      }
      throw new DocumentError(404, '프로젝트 문서협업에서 지원하지 않는 경로입니다.');
    }

    const store = storeProvider();
    const project = context.projectForSession?.(session);
    const projectScope = project ? `project:${project}` : null;
    const scopeFor = (id: string) => (projectScope && store.ownedBy(projectScope, id) ? projectScope : session);
    if (method === 'GET' && suffix === '') {
      const documents = [...store.list(session), ...(projectScope ? store.list(projectScope) : [])];
      return sendJson(res, 200, {
        documents: [...new Map(documents.map((d) => [d.id, { ...d, readOnly: !store.ownedBy(scopeFor(d.id), d.id) }])).values()],
        root: store.root,
        project: project ?? null,
        sessions: context.sessions?.() ?? [],
        attachments: context.attachments?.(session) ?? [],
      });
    }
    const operation = /^\/([a-f0-9-]{36})\/(share|move|attachments|bundle)$/.exec(suffix);
    if (operation) {
      const [, id, action] = operation;
      const scope = scopeFor(id);
      const document = store.get(scope, id);
      const linkedAssets = [...new Set([...document.markdown.matchAll(/\/attachments\/([a-f0-9-]{36})(?=[?\s)#"']|$)/g)].map((m) => m[1]))];
      const missing = () => linkedAssets.filter((asset) => !store.hasAsset(id, asset));
      if (method === 'GET' && action === 'bundle') {
        if (missing().length) throw new DocumentError(409, '본문의 첨부 사본이 아직 없습니다. 소유 챗에서 첨부 사본 보관 후 내보내세요.');
        const bundle = store.bundle(scope, id);
        res.setHeader('Content-Disposition', `attachment; filename="${id}.document-bundle.json"`);
        return sendJson(res, 200, bundle);
      }
      if (method !== 'POST') throw new DocumentError(405, 'POST 요청이 필요합니다.');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 4096) throw new DocumentError(413, '요청이 너무 큽니다.');
        chunks.push(Buffer.from(chunk));
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new DocumentError(400, '잘못된 JSON입니다.');
      }
      if (!body || typeof body !== 'object') throw new DocumentError(400, '요청 본문이 필요합니다.');
      if ((action === 'move' || (action === 'share' && body.remove !== true)) && missing().length) throw new DocumentError(409, '먼저 본문에 연결된 첨부 사본을 보관하세요. 원본 챗 삭제 후에도 첨부를 유지하기 위한 조건입니다.');
      if (action === 'share') {
        if (typeof body.targetSession !== 'string' || !sessionExists(body.targetSession) || (body.remove !== undefined && typeof body.remove !== 'boolean')) throw new DocumentError(400, '대상 챗/연결 해제 값이 잘못되었습니다.');
        store.share(scope, id, body.targetSession, body.remove === true);
      } else if (action === 'move') {
        // Only the current server-resolved project is a valid ownership destination.
        if (!project || body.project !== project || !Number.isSafeInteger(body.revision)) throw new DocumentError(403, '현재 챗의 프로젝트로만 이동할 수 있습니다.');
        store.moveToProject(scope, id, project, body.revision);
      } else if (action === 'attachments') {
        if (typeof body.attachmentId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.attachmentId)) throw new DocumentError(400, '첨부 ID가 필요합니다.');
        const asset = context.attachment?.(session, body.attachmentId);
        if (!asset) throw new DocumentError(404, '현재 챗의 첨부가 필요합니다.');
        store.addAsset(scope, id, asset);
      } else throw new DocumentError(405, '지원하지 않는 요청입니다.');
      return sendJson(res, 200, { ok: true });
    }
    const match = /^\/([a-f0-9-]{36})(\/versions)?$/.exec(suffix);
    if (method === 'GET' && match) return sendJson(res, 200, match[2] ? { versions: store.versions(scopeFor(match[1]), match[1]) } : { ...store.get(scopeFor(match[1]), match[1]), readOnly: !store.ownedBy(scopeFor(match[1]), match[1]) });
    if ((method === 'POST' && suffix === '') || (method === 'PUT' && match && !match[2])) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 3_000_000) throw new DocumentError(413, '요청이 너무 큽니다.');
        chunks.push(Buffer.from(chunk));
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new DocumentError(400, '잘못된 JSON입니다.');
      }
      if (!body || typeof body !== 'object') throw new DocumentError(400, '문서가 필요합니다.');
      return sendJson(res, 200, store.save(match ? scopeFor(match[1]) : session, match?.[1] ?? null, body));
    }
    throw new DocumentError(404, '지원하지 않는 문서 경로입니다.');
  } catch (error) {
    sendJson(res, error instanceof DocumentError ? error.status : 500, { error: error instanceof Error ? error.message : '문서 저장 실패' });
  }
}
