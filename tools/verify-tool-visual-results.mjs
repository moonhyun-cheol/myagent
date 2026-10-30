import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { executeAgentTool } from '../core/dist/agent/agent-tool-execute.js';
import { toolImageDataUrl, toolImageFromBase64, readToolImage, TOOL_IMAGE_MAX_BYTES } from '../core/dist/agent/tool-image.js';
import { normalizeUserMcpResult, saveUserMcpConfig, closeUserMcpServer } from '../core/dist/agent/user-mcp.js';
import { chatCompletion } from '../core/dist/providers/openai-compatible.js';
import { buildToolImageMessage } from '../core/dist/agent/agent-multimodal.js';
import { paginateMarkitdownText } from '../core/dist/sidecars/markitdown-sidecar.js';
import { prepareAgentContextForRequest } from '../core/dist/agent/agent-context-assembler.js';
import { AgentEvidenceStore } from '../core/dist/agent/agent-evidence-store.js';
import { getCodeAgentToolsByPack } from '../core/dist/agent/agent-tool-registry.js';
import { needsHumanApproval } from '../core/dist/agent/tool-approval.js';
import { startVisibleBrowserBridge } from '../core/dist/browser/visible-browser-bridge.js';
import { PlaywrightSession } from '../core/dist/browser/playwright-session.js';
import { runCodeAgent } from '../core/dist/agent/agent-run-loop.js';

const root = path.resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(root, '.tmp', 'tool-visual-'));
const app = path.join(tmp, 'app');
const workspace = path.join(tmp, 'workspace');
mkdirSync(app); mkdirSync(workspace);
const oldUsage = process.env.MY_AGENT_LLM_USAGE_LOG_DIR;
process.env.MY_AGENT_LLM_USAGE_LOG_DIR = path.join(tmp, 'usage');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const call = (name, args = {}) => ({ id: 'test', type: 'function', function: { name, arguments: JSON.stringify(args) } });
const ctx = { cqrRoot: app, sessionId: 'session-a' };
let count = 0;
const check = async (name, fn) => { await fn(); count++; console.log(`PASS ${name}`); };
let bridge;
let browser;
let server;
try {
  writeFileSync(path.join(workspace, 'chart.png'), png);
  writeFileSync(path.join(workspace, 'chart2.png'), png);
  await check('format, MIME, size, dimensions and base64 guards', () => {
    assert.match(toolImageDataUrl(png), /^data:image\/png;base64,/);
    assert.throws(() => toolImageDataUrl(Buffer.from('<svg/>')), /IMAGE_FORMAT/);
    assert.throws(() => toolImageDataUrl(png, 'image/jpeg'), /MIME_MISMATCH/);
    assert.throws(() => toolImageDataUrl(Buffer.alloc(TOOL_IMAGE_MAX_BYTES + 1)), /SIZE_LIMIT/);
    assert.throws(() => toolImageFromBase64('bad!'), /BASE64_REJECTED/);
    const large = Buffer.from(png); large.writeUInt32BE(20_000, 16);
    assert.throws(() => toolImageDataUrl(large), /DIMENSION_LIMIT/);
    assert.throws(() => toolImageDataUrl(png.subarray(0, 20)), /FORMAT/);
    // Large but allowed base64 should not overflow the regexp stack.
    const padded = Buffer.alloc(1024 * 1024); png.copy(padded);
    assert.match(toolImageFromBase64(padded.toString('base64')), /^data:image\/png/);
  });
  await check('local image tool and URL/traversal rejection', async () => {
    const result = await executeAgentTool(workspace, call('image_get', { path: 'chart.png' }), {}, ctx);
    assert.equal(JSON.parse(result.output).ok, true);
    assert.match(result.followUpImage, /^data:image\/png/);
    assert.ok(!result.output.includes(png.toString('base64')), 'text evidence has no image bytes');
    assert.throws(() => readToolImage(workspace, '../outside/chart.png', ctx), /outside dev workspace|OUTSIDE/);
    assert.throws(() => readToolImage(workspace, 'https://example.invalid/a.png', ctx), /LOCAL_PATH/);
    assert.equal(needsHumanApproval('image_get', { path: path.join(tmp, 'outside.png') }, {}, { workspaceRoot: workspace }).access, 'external_read');
    assert.ok(getCodeAgentToolsByPack(root, 'read_only').some(t => t.function.name === 'image_get'));
  });
  await check('internal data and cross-session access including junctions', () => {
    for (const sid of ['session-a', 'session-b']) {
      const dir = path.join(app, 'data', 'outputs', 'web', sid); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'img.png'), png);
    }
    const own = path.join(app, 'data', 'outputs', 'web', 'session-a', 'img.png');
    const other = path.join(app, 'data', 'outputs', 'web', 'session-b', 'img.png');
    assert.match(readToolImage(workspace, own, ctx), /^data:image\/png/);
    assert.throws(() => readToolImage(workspace, other, ctx), /SESSION_SCOPE/);
    assert.throws(() => readToolImage(workspace, own, { cqrRoot: app }), /SESSION_SCOPE/);
    mkdirSync(path.join(app, 'data', 'attachments'), { recursive: true });
    writeFileSync(path.join(app, 'data', 'attachments', 'private.png'), png);
    assert.throws(() => readToolImage(workspace, path.join(app, 'data', 'attachments', 'private.png'), ctx), /SESSION_SCOPE/);
    const link = path.join(workspace, 'foreign-link');
    symlinkSync(path.dirname(other), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readToolImage(workspace, path.join(link, 'img.png'), ctx), /SESSION_SCOPE/);
    const ownLink = path.join(path.dirname(own), 'escape');
    symlinkSync(path.dirname(other), ownLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readToolImage(workspace, path.join(ownLink, 'img.png'), ctx), /SESSION_SCOPE/);
  });
  await check('MCP image-only, mixed, multi-image, rejected and error results', () => {
    const image = { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
    const result = normalizeUserMcpResult({ content: [{ type: 'text', text: 'chart' }, image, image] });
    assert.equal(result.followUpImages.length, 2);
    assert.equal(JSON.parse(result.output).text, 'chart');
    assert.equal(result.output.includes(image.data), false);
    assert.equal(normalizeUserMcpResult({ content: [image] }).followUpImages.length, 1);
    assert.equal(normalizeUserMcpResult({ isError: true, content: [image] }).followUpImages, undefined);
    const over = normalizeUserMcpResult({ content: Array(5).fill(image) });
    assert.equal(over.followUpImages.length, 4); assert.equal(JSON.parse(over.output).warnings.length, 1);
    const invalid = normalizeUserMcpResult({ content: [{ ...image, mimeType: 'image/svg+xml' }] });
    assert.equal(invalid.followUpImages.length, 0); assert.equal(JSON.parse(invalid.output).warnings.length, 1);
    assert.equal(normalizeUserMcpResult({ content: [{ type: 'text', text: 'old text behavior' }] }).output, 'old text behavior');
  });
  await check('document pages recover every character beyond old 80000 limit', () => {
    const text = '가나다 abc\n'.repeat(20_000) + 'LAST-PAGE-SENTINEL';
    let offset = 0; let recovered = ''; let hash;
    do {
      const page = paginateMarkitdownText(text, offset);
      recovered += page.text;
      if (hash) assert.equal(page.coverage.sha256, hash);
      hash = page.coverage.sha256;
      offset = page.coverage.next_start_char;
    } while (offset !== null);
    assert.equal(recovered, text);
    assert.equal(paginateMarkitdownText('short').coverage.truncated, false);
    assert.equal(paginateMarkitdownText('short', 999).text, '');
    assert.equal(paginateMarkitdownText(text, 0, 999999).text.length, 80_000);
    assert.notEqual(paginateMarkitdownText(text + 'changed').coverage.sha256, hash);
  });
  await check('document conversion subprocess carries paging arguments and incomplete status', async () => {
    const oldBin = process.env.MY_AGENT_MARKITDOWN_BIN;
    try {
      // Node substitutes only the external converter executable, exercising real stdout capture.
      process.env.MY_AGENT_MARKITDOWN_BIN = process.execPath;
      writeFileSync(path.join(workspace, 'convert-fixture.cjs'), 'process.stdout.write("x".repeat(90000) + "TAIL");');
      const result = await executeAgentTool(workspace, call('markitdown_convert', { path: 'convert-fixture.cjs', start_char: 90000, max_chars: 100 }), {}, ctx);
      const doc = JSON.parse(result.output);
      assert.equal(doc.ok, true); assert.equal(doc.rawLog, 'TAIL');
      assert.equal(doc.coverage.start_char, 90000); assert.equal(doc.coverage.total_chars, 90004);
      assert.equal(doc.coverage.source_complete, true); assert.equal(doc.coverage.next_start_char, null);
      writeFileSync(path.join(workspace, 'convert-fail.cjs'), 'process.stdout.write("partial"); process.exit(1);');
      const bad = JSON.parse((await executeAgentTool(workspace, call('markitdown_convert', { path: 'convert-fail.cjs' }), {}, ctx)).output);
      assert.equal(bad.ok, false); assert.equal(bad.coverage.source_complete, false); assert.ok(bad.coverage.warning);
    } finally {
      if (oldBin === undefined) delete process.env.MY_AGENT_MARKITDOWN_BIN; else process.env.MY_AGENT_MARKITDOWN_BIN = oldBin;
    }
  });
  await check('visible capture executor attaches pixels and reports rejected images', async () => {
    bridge = startVisibleBrowserBridge(45000 + process.pid % 10000);
    bridge.isConnected = () => true;
    bridge.request = async () => ({ image_base64: png.toString('base64'), url: 'fixture://local' });
    const result = await executeAgentTool(workspace, call('browser_screenshot', { target: 'visible' }), {}, ctx);
    assert.equal(JSON.parse(result.output).image_attached, true);
    assert.equal(result.followUpImage, toolImageDataUrl(png));
    assert.ok(readFileSync(JSON.parse(result.output).path).equals(png));
    bridge.request = async () => ({ image_base64: Buffer.from('not png').toString('base64') });
    const bad = await executeAgentTool(workspace, call('browser_screenshot', { target: 'visible', path: 'invalid.png' }), {}, ctx);
    assert.equal(JSON.parse(bad.output).image_attached, false); assert.equal(bad.followUpImage, undefined);
    bridge.isConnected = () => false;
  });
  // Real Chromium against local HTTP only; no user browser or internal admin URL.
  server = createServer(async (req, res) => {
    if (req.url === '/mcp' && req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Local visual fixture</h1><div style="width:160px;height:80px;background:#187b42">Chart</div>'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/mcp') {
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'picture', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return;
    }
    if (req.url.endsWith('/chat/completions')) {
      chatReceived.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: { role: 'assistant', content: '확인했습니다.' }, finish_reason: 'stop' }] })); return;
    }
    received.push(body);
    const output = received.length === 1 ? ['chart.png', 'chart2.png'].map((p, i) => ({ type: 'function_call', call_id: `image_${i}`, name: 'image_get', arguments: JSON.stringify({ path: p }) }))
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '이미지를 확인했습니다.' }] }];
    const doc = { id: `fixture_${received.length}`, status: 'completed', model: 'fixture-model', output, usage: { input_tokens: 10, output_tokens: 5 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: doc })}\n\n`);
  });
  const received = [];
  const chatReceived = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await check('local MCP HTTP -> executor preserves image blocks', async () => {
    saveUserMcpConfig(app, { version: 3, servers: [{ id: 'fixture', url: `${base}/mcp`, enabled: true }] });
    try {
      const result = await executeAgentTool(workspace, call('mcp_fixture_picture'), {}, ctx);
      assert.equal(JSON.parse(result.output).image_count, 1, result.output);
      assert.equal(result.followUpImages[0], toolImageDataUrl(png));
    } finally {
      await closeUserMcpServer(app, 'fixture');
      saveUserMcpConfig(app, { version: 3, servers: [] });
    }
  });
  await check('Chat Completions wire preserves tool image parts', async () => {
    await chatCompletion(`${base}/v1`, 'fixture-key', 'fixture-model', [buildToolImageMessage('mcp_fixture_picture', [toolImageDataUrl(png)])]);
    assert.equal(chatReceived[0].messages[0].content[1].image_url.url, toolImageDataUrl(png));
  });
  await check('real isolated Chromium capture -> executor -> image input', async () => {
    // Reuse installed dev runtime read-only; keep screenshots/session state in temp.
    symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(path.join(root, 'runtime'), path.join(app, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    browser = new PlaywrightSession(app, { headless: true, urlGuard: { allowLocalhost: true } });
    await browser.navigate(base);
    const result = await executeAgentTool(workspace, call('browser_screenshot', { target: 'isolated' }), {}, { ...ctx, browserSession: browser });
    assert.equal(JSON.parse(result.output).image_attached, true, result.output);
    assert.match(result.followUpImage, /^data:image\/png/);
    assert.ok(Buffer.from(result.followUpImage.split(',')[1], 'base64').length > 100);
    await browser.close(); browser = undefined;
  });
  await check('real agent loop sends two tool images after paired results to local Responses API', async () => {
    let rounds = 0;
    await runCodeAgent({ workspaceRoot: workspace, cqrRoot: app, sessionId: 'wire-fixture',
      userMessage: '두 로컬 이미지의 내용을 확인해 주세요.', providerId: 'fixture', modelId: 'fixture-model', autopilot: false,
      providerStore: { resolveProvider: () => ({ def: { kind: 'openai_compatible', name: 'Fixture' }, secret: { api_key: 'fixture-key' }, baseUrl: `${base}/v1`, modelId: 'fixture-model', wireApi: 'responses', toolProtocol: 'native' }) },
      hooks: { beforeModel: () => ++rounds > 2 ? { stop: true, reason: 'fixture completed' } : undefined },
    });
    assert.ok(received.length >= 2, 'must issue a model request after tool execution');
    const input = received[1].input;
    const images = input.filter(item => Array.isArray(item.content) && item.content.some(p => p.type === 'input_image'));
    assert.equal(images.length, 2);
    const lastTool = Math.max(...input.map((item, i) => item.type === 'function_call_output' ? i : -1));
    assert.ok(input.indexOf(images[0]) > lastTool, 'all tool outputs precede images');
    assert.equal(images[0].content.find(p => p.type === 'input_image').image_url, toolImageDataUrl(png));
  });
  await check('forced context rebuild preserves fresh tool image parts', () => {
    const image = buildToolImageMessage('image_get', [toolImageDataUrl(png)]);
    const store = new AgentEvidenceStore({ cqrRoot: app, sessionId: 'assembly-test', runId: 'fixture-run' });
    const result = prepareAgentContextForRequest({ phase: 'work', forceRebuild: true, messages: [{ role: 'system', content: 'stable' }, { role: 'user', content: 'request' }, image], userMessage: 'request', evidenceStore: store });
    assert.ok(result.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')));
  });
  console.log(JSON.stringify({ ok: true, checks: count, paid_api_calls: 0 }));
} finally {
  if (browser) await browser.close();
  bridge?.stop();
  if (server) await new Promise(resolve => server.close(resolve));
  if (oldUsage === undefined) delete process.env.MY_AGENT_LLM_USAGE_LOG_DIR; else process.env.MY_AGENT_LLM_USAGE_LOG_DIR = oldUsage;
  rmSync(tmp, { recursive: true, force: true });
}
