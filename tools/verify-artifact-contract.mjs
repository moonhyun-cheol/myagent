#!/usr/bin/env node
/**
 * Artifact contract goldens — modality lock, OpenClaw split, invent ban, secrets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blocksOpenClawAutomatonRoute,
  contentSuggestsOpenClawForLocalBot,
  inferArtifactContract,
  legacyIsolateForDirectionReversal,
  mergeArtifactContracts,
  mutatedPathsViolateArtifactKind,
} from '../core/dist/agent/agent-artifact-contract.js';
import {
  loadLockedConstraints,
  looksLikeDirectionReversal,
  resolveLockedConstraintsForTurn,
  saveLockedConstraints,
  withArtifactContract,
} from '../core/dist/agent/agent-locked-constraints.js';

// --- Discord personal bot → local_node, not OpenClaw ---
{
  const c = inferArtifactContract(
    '개인용 Discord 일간 매크로. OpenClaw 연결 금지. guild 1509.',
  );
  assert.equal(c.artifactKind, 'discord_bot', `kind=${c.artifactKind}`);
  assert.equal(c.runtimeSurface, 'local_node', `surface=${c.runtimeSurface}`);
  assert.deepEqual(c.dataSources, []);
  assert.ok(c.requiredSecrets.includes('DISCORD_WEBHOOK_URL'));
  assert.ok(!c.requiredSecrets.includes('DISCORD_BOT_TOKEN'));
  assert.equal(
    blocksOpenClawAutomatonRoute(
      '개인용 Discord 봇 만들어줘. OpenClaw 금지. DISCORD_BOT_TOKEN',
    ),
    true,
  );
}

// Live no_self_deny / gh_explain: repo slug my_automaton must NOT become OpenClaw.
{
  const gh = inferArtifactContract(
    '공개 저장소 https://github.com/jose87ldj/my_automaton 의 한 줄 목적만 README 근거로 말해. 수정 금지.',
  );
  assert.notEqual(gh.runtimeSurface, 'openclaw', 'github slug ≠ openclaw');
  assert.notEqual(gh.artifactKind, 'scheduled_job', 'inspect ≠ scheduled_job');
}

// Explicit bot token mode still lists bot secrets
{
  const bot = inferArtifactContract(
    'Discord Bot Token + discord.js 게이트웨이 봇. OpenClaw 금지.',
  );
  assert.ok(bot.requiredSecrets.includes('DISCORD_BOT_TOKEN'));
  assert.ok(bot.requiredSecrets.includes('DISCORD_CHANNEL_ID'));
}

// --- Wrong modality: web files only under discord_bot ---
{
  const c = inferArtifactContract('Discord 봇 매크로 OpenClaw 금지');
  assert.equal(
    mutatedPathsViolateArtifactKind(c, ['index.html', 'app.js', 'styles.css']),
    true,
  );
  assert.equal(
    mutatedPathsViolateArtifactKind(c, ['package.json', 'src/discord/poster.js']),
    false,
  );
}

// --- OpenClaw bleed ---
assert.equal(
  contentSuggestsOpenClawForLocalBot('Discord 게시는 OpenClaw adapter /cqr/adapter 로'),
  true,
);

// --- Direction reversal seeds legacy ---
{
  const prev = inferArtifactContract('웹 SPA 대시보드 index.html');
  const legacy = legacyIsolateForDirectionReversal(
    prev,
    '아니지 웹앱이 아니다. Discord 매크로. OpenClaw 금지',
  );
  assert.ok(legacy.includes('index.html'));
  assert.ok(looksLikeDirectionReversal('아니지 웹앱이 아니다. Discord 매크로'));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cqr-art-'));
const sessionId = 'artifact-contract';
try {
  const locked = withArtifactContract(
    null,
    inferArtifactContract('웹 SPA index.html 만들어'),
  );
  saveLockedConstraints(tmp, sessionId, locked);
  const resolved = resolveLockedConstraintsForTurn({
    cqrRoot: tmp,
    sessionId,
    userMessage: '그게 아니라 웹앱이 아니다. Discord Bot Token 기반 일간 매크로. OpenClaw 금지.',
  });
  assert.equal(resolved?.invalidated, false);
  assert.equal(resolved?.artifactKind, 'web_spa');
  assert.equal(loadLockedConstraints(tmp, sessionId)?.artifactKind, 'web_spa');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// merge prefers locked kind
{
  const locked = inferArtifactContract('Discord 봇 OpenClaw 금지');
  const soft = inferArtifactContract('웹 SPA 만들어줘');
  const m = mergeArtifactContracts(locked, soft);
  assert.equal(m.artifactKind, 'discord_bot');
  assert.equal(m.runtimeSurface, 'local_node');
}

console.log('verify-artifact-contract: ok');
