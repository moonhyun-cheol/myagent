// Synthetic benchmark for the GET /workspace tree build (new-chat latency path).
// Usage: node node_modules/typescript/bin/tsc -p tsconfig.json && node tools/bench-workspace-tree.mjs [sessions] [heavyKb]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../core/dist/sessions/session-store.js';
import { ProjectStore } from '../core/dist/projects/project-store.js';

const SESSION_COUNT = Number(process.argv[2] ?? 300);
const HEAVY_KB = Number(process.argv[3] ?? 300);
const PROJECTS = 12;
const ROUNDS = 5;

const root = mkdtempSync(path.join(tmpdir(), 'bench-workspace-'));
try {
  const sessionsDir = path.join(root, 'data', 'sessions');
  const projectsDir = path.join(root, 'data', 'projects');
  mkdirSync(projectsDir, { recursive: true });
  const now = Date.now();
  const iso = (offset) => new Date(now - offset * 60_000).toISOString();
  const projects = [
    { id: 'ws-root', title: 'Workspace', kind: 'workspace_root', folder_path: root, parent_id: null, created_at: iso(9999), updated_at: iso(0) },
    ...Array.from({ length: PROJECTS }, (_, i) => ({
      id: `p${i}`, title: `Folder ${i}`, kind: i % 2 ? 'project' : 'folder',
      parent_id: i % 2 ? null : 'ws-root', created_at: iso(9999), updated_at: iso(i),
    })),
  ];
  writeFileSync(path.join(projectsDir, 'index.json'), JSON.stringify({ version: 1, projects }), 'utf8');

  const sessionStore = new SessionStore(sessionsDir, root);
  const projectStore = new ProjectStore(projectsDir, root);
  const heavyItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(1024) }] };
  const db = new DatabaseSync(path.join(sessionsDir, 'sessions.sqlite'));
  db.exec('BEGIN');
  const insertSession = db.prepare('INSERT INTO sessions(id, body) VALUES (?, ?)');
  const insertMessage = db.prepare('INSERT INTO messages(session_id, seq, body) VALUES (?, ?, ?)');
  for (let i = 0; i < SESSION_COUNT; i++) {
    const id = `s${i}`;
    const heavy = i % 3 === 0;
    const body = {
      id, title: `대화 ${i}`, created_at: iso(i), updated_at: iso(i),
      project_id: i % 4 === 0 ? null : `p${i % PROJECTS}`, workspace_project_id: null,
      archived: i % 7 === 0,
      ...(heavy ? { responses_states: { chat: { replay_items: Array.from({ length: HEAVY_KB }, () => heavyItem) } } } : {}),
    };
    insertSession.run(id, JSON.stringify(body));
    for (let m = 1; m <= 20; m++) insertMessage.run(id, m, JSON.stringify({ role: m % 2 ? 'user' : 'assistant', content: 'hello', at: iso(i) }));
  }
  db.exec('COMMIT');
  db.close();

  const oldPath = () => {
    // Pre-change GET /workspace: one full list() per helper call.
    sessionStore.autoArchive();
    const sessions = sessionStore.listActive();
    projectStore.listWorkspaceRoots().map((r) => projectStore.buildNodeTree(r.id, sessions));
    projectStore.listGeneral(sessions).map((p) => sessionStore.listByProject(p.id));
    sessionStore.listStandalone();
    sessionStore.listArchived();
  };
  const newPath = typeof sessionStore.workspaceSnapshot === 'function'
    ? () => {
      const snap = sessionStore.workspaceSnapshot();
      projectStore.listWorkspaceRoots().map((r) => projectStore.buildNodeTree(r.id, snap.active));
      projectStore.listGeneral(snap.active).map((p) => snap.byProject(p.id));
    }
    : null;

  const measure = (label, fn) => {
    fn(); // warm-up (also performs the one-time auto-archive writes)
    const samples = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t = performance.now();
      fn();
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    console.log(`${label}: median ${samples[Math.floor(ROUNDS / 2)].toFixed(1)} ms (min ${samples[0].toFixed(1)}, max ${samples.at(-1).toFixed(1)})`);
  };
  console.log(`sessions=${SESSION_COUNT}, heavy(1/3)≈${HEAVY_KB}KB, projects=${PROJECTS}`);
  measure('list() x1', () => sessionStore.list());
  measure('old /workspace path', oldPath);
  if (newPath) measure('new /workspace path', newPath);
} finally {
  rmSync(root, { recursive: true, force: true });
}
