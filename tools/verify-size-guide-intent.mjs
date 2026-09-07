import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  matchSizeGuideIntent,
  shouldAutoRouteSizeGuide,
} from '../core/dist/skills/size-guide-capability.js';

assert.equal(matchSizeGuideIntent('일반 코드 리뷰해줘'), false);
assert.equal(matchSizeGuideIntent('/심층리서치 foo'), false);
assert.equal(matchSizeGuideIntent('이 링크 샘플 사이즈 뭐 사야 해?'), true);
assert.equal(matchSizeGuideIntent('사이즈 차트 확인해줘'), true);
assert.equal(matchSizeGuideIntent('허리 인심 매칭 부탁'), true);
assert.equal(matchSizeGuideIntent('UF PRO size chart for L'), true);

const emptyRoot = mkdtempSync(path.join(tmpdir(), 'my-agent-size-guide-empty-'));
assert.equal(shouldAutoRouteSizeGuide('샘플 사이즈 추천', emptyRoot), false);

const withSkill = mkdtempSync(path.join(tmpdir(), 'my-agent-size-guide-mod-'));
const skillsDir = path.join(withSkill, 'modules', 'organization', 'skills');
mkdirSync(skillsDir, { recursive: true });
writeFileSync(
  path.join(skillsDir, 'manifest.json'),
  JSON.stringify({
    version: 1,
    skills: {
      size_guide: {
        label: '샘플 사이즈',
        mode: 'org:size_guide',
        user_selectable: false,
        brand_files: ['skills/size-guide.md'],
        bundle_files: [],
      },
    },
  }),
);
assert.equal(shouldAutoRouteSizeGuide('샘플 사이즈 추천', withSkill), true);
assert.equal(shouldAutoRouteSizeGuide('TypeScript 고쳐줘', withSkill), false);

rmSync(emptyRoot, { recursive: true, force: true });
rmSync(withSkill, { recursive: true, force: true });
console.log('verify-size-guide-intent: PASS');
