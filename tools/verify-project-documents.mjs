import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectDocumentStore } from '../core/dist/documents/project-document-store.js';
import { documentRoute } from '../core/dist/documents/document-route.js';
import { DocumentStore } from '../core/dist/documents/document-store.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'project-documents-'));
const root = path.join(temp, 'project');
mkdirSync(path.join(root, 'docs'), { recursive: true });
mkdirSync(path.join(root, '.my_agent_remote'), { recursive: true });
writeFileSync(path.join(root, 'README.md'), '# 시작\n', 'utf8');
writeFileSync(path.join(root, '.my_agent_remote', 'ignored.md'), '# 제외\n', 'utf8');
const projects = new ProjectDocumentStore(path.join(temp, 'project-documents.sqlite'));
const legacy = new DocumentStore(path.join(temp, 'legacy'));
let server;
try {
  const listed = projects.list(root);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, 'README.md');
  const first = projects.get(root, listed[0].id);
  assert.equal(first.source, 'project');
  assert.equal(first.markdown, '# 시작\n');
  assert.throws(
    () => projects.save(root, first.id, { title: '../escape.md', markdown: first.markdown, revision: first.revision }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => projects.save(root, first.id, { title: 'C:\\outside.md', markdown: first.markdown, revision: first.revision }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => projects.save(root, first.id, { title: 'README.md', markdown: 'x'.repeat(2_000_001), revision: first.revision }),
    (error) => error.status === 400,
  );
  assert.throws(() => projects.list('\\\\server\\share'), (error) => error.status === 403);

  const noted = projects.save(root, first.id, {
    title: 'README.md',
    markdown: '# 시작\n',
    revision: first.revision,
    notes: [{ id: 'n', quote: '시작', note: '검토', from: 1, to: 3, revision: first.revision + 1, kind: 'reference' }],
  });
  writeFileSync(path.join(root, 'README.md'), '# 모델 변경\n', 'utf8');
  const external = projects.get(root, noted.id);
  assert.equal(external.revision, noted.revision + 1);
  assert.equal(external.notes[0].detached, true);
  assert.throws(
    () => projects.save(root, external.id, { ...external, revision: noted.revision }),
    (error) => error.status === 409,
  );

  const renamed = projects.save(root, external.id, {
    title: 'docs/협업.md',
    markdown: '# 함께 편집\n',
    revision: external.revision,
    notes: external.notes,
  });
  assert.equal(renamed.path, 'docs/협업.md');
  assert.equal(existsSync(path.join(root, 'README.md')), false);
  assert.equal(readFileSync(path.join(root, 'docs', '협업.md'), 'utf8'), '# 함께 편집\n');
  writeFileSync(path.join(root, 'MODEL.md'), '# 모델 게시\n', 'utf8');
  assert.equal(projects.list(root).some((item) => item.path === 'MODEL.md'), true);

  server = createServer((req, res) => void documentRoute(
    req,
    res,
    new URL(req.url, 'http://localhost'),
    req.method ?? 'GET',
    (id) => id === 'session' || id === 'recipient',
    () => legacy,
    {
      workspaceRootForSession: (id) => id === 'session' ? root : null,
      projectDocuments: projects,
      sessions: () => [{ id: 'session', title: '소유 챗' }, { id: 'recipient', title: '수신 챗' }],
      attachments: () => [{ id: '11111111-1111-1111-1111-111111111111', name: 'fixture.bin' }],
      attachment: (_session, id) => id === '11111111-1111-1111-1111-111111111111'
        ? { id, name: 'fixture.bin', mime: 'application/octet-stream', bytes: Buffer.from([0, 1, 255]) }
        : null,
    },
  ));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/workspace/documents`;
  const request = (suffix = '', method = 'GET', body, session = 'session') => fetch(base + suffix, {
    method,
    headers: { 'X-CQR-Session': session, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const response = await request();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.projectRoot, true);
  assert.equal(payload.root, root);
  assert.equal(payload.documents.length, 2);
  const createdResponse = await request('', 'POST', {
    title: '회의/결정.md',
    markdown: `# 결정\n\n[첨부](/attachments/11111111-1111-1111-1111-111111111111)\n`,
    revision: 0,
    notes: [],
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(readFileSync(path.join(root, '회의', '결정.md'), 'utf8'), `# 결정\n\n[첨부](/attachments/11111111-1111-1111-1111-111111111111)\n`);
  const blockedShare = await request(`/${created.id}/share`, 'POST', { targetSession: 'recipient' });
  assert.equal(blockedShare.status, 409);
  const storedAttachment = await request(`/${created.id}/attachments`, 'POST', { attachmentId: '11111111-1111-1111-1111-111111111111' });
  assert.equal(storedAttachment.status, 200);
  const shared = await request(`/${created.id}/share`, 'POST', { targetSession: 'recipient' });
  assert.equal(shared.status, 200);
  const recipientList = await request('', 'GET', undefined, 'recipient');
  assert.equal(recipientList.status, 200);
  const recipientPayload = await recipientList.json();
  assert.equal(recipientPayload.documents.find((item) => item.id === created.id).readOnly, true);
  const recipientDocument = await request(`/${created.id}`, 'GET', undefined, 'recipient');
  assert.equal(recipientDocument.status, 200);
  assert.equal((await recipientDocument.json()).readOnly, true);
  const bundleResponse = await request(`/${created.id}/bundle`);
  assert.equal(bundleResponse.status, 200);
  assert.equal((await bundleResponse.json()).attachments[0].base64, 'AAH/');
  const put = await request(`/${created.id}`, 'PUT', { ...created, markdown: '# 결정 완료\n' });
  assert.equal(put.status, 200);
  assert.equal(readFileSync(path.join(root, '회의', '결정.md'), 'utf8'), '# 결정 완료\n');
  console.log('PASS project document collaboration: root discovery, direct file source, notes/version sync, route attachment guard, read-only cross-chat share, bundle, API create/update');
} finally {
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  projects.close();
  legacy.close();
  rmSync(temp, { recursive: true, force: true });
}
