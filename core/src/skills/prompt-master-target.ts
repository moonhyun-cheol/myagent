import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PromptMasterTargetId =
  | 'midjourney'
  | 'dalle3'
  | 'stable_diffusion'
  | 'seedream'
  | 'comfyui'
  | 'my_agent'
  | 'cursor'
  | 'claude'
  | 'chatgpt'
  | 'gemini'
  | 'sora'
  | 'runway'
  | 'elevenlabs'
  | 'general';

export interface PromptMasterTargetResult {
  id: PromptMasterTargetId;
  label: string;
  confidence: number;
  reason: string;
}

interface TargetRule {
  id: PromptMasterTargetId;
  label: string;
  patterns: RegExp[];
  phrases: string[];
  weight?: number;
}

/** Template letters from prompt-master-templates.md to inject per target. */
const TARGET_TEMPLATE_LETTERS: Record<PromptMasterTargetId, string[]> = {
  midjourney: ['I', 'J'],
  dalle3: ['I', 'J'],
  stable_diffusion: ['I', 'J'],
  seedream: ['I', 'J'],
  comfyui: ['K', 'I'],
  my_agent: ['G', 'H', 'M'],
  cursor: ['G', 'H'],
  claude: ['A', 'M', 'H'],
  chatgpt: ['A', 'B', 'F'],
  gemini: ['A', 'C'],
  sora: ['I'],
  runway: ['I'],
  elevenlabs: ['A'],
  general: ['A', 'L'],
};

const IMAGE_TARGETS: TargetRule[] = [
  {
    id: 'midjourney',
    label: 'Midjourney',
    phrases: ['midjourney', '미드저니', 'mj 프롬', 'mj prompt', '--ar', '--v 6', '--v 7', '--style raw', '--cref', '--sref'],
    patterns: [/\bmj\b/i, /--(?:ar|v|style|no|cref|sref)\b/i],
    weight: 2,
  },
  {
    id: 'stable_diffusion',
    label: 'Stable Diffusion',
    phrases: [
      'stable diffusion',
      '스테이블 디퓨전',
      'sd 프롬',
      '네거티브 프롬',
      'negative prompt',
      'cfg scale',
      'denoising',
    ],
    patterns: [/\(\s*[\w가-힣]+:\s*[\d.]+\s*\)/, /\bcfg\s*\d/i, /img2img|txt2img/i],
    weight: 2,
  },
  {
    id: 'seedream',
    label: 'SeeDream',
    phrases: ['seedream', 'see dream', '씨드림', '시드림'],
    patterns: [/see\s*dream/i],
    weight: 2,
  },
  {
    id: 'dalle3',
    label: 'DALL-E 3',
    phrases: ['dall-e', 'dalle', '달리', 'chatgpt 이미지', 'gpt 이미지', 'openai 이미지'],
    patterns: [/dall[\s-]?e/i],
    weight: 2,
  },
  {
    id: 'comfyui',
    label: 'ComfyUI',
    phrases: ['comfyui', 'comfy ui', '컴피ui', '워크플로우 노드'],
    patterns: [/comfy\s*ui/i],
    weight: 3,
  },
];

const OTHER_TARGETS: TargetRule[] = [
  {
    id: 'my_agent',
    label: 'MY Agent code agent',
    phrases: ['my_agent', 'cqr pa', '코드 에이전트'],
    patterns: [/cqr[_\s-]?pa/i],
    weight: 3,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    phrases: ['cursor', '커서', 'windsurf'],
    patterns: [/\bcursor\b/i, /\bwindsurf\b/i],
  },
  {
    id: 'claude',
    label: 'Claude',
    phrases: ['claude', '클로드', 'claude code', '클로드 코드'],
    patterns: [/\bclaude\b/i],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT / GPT',
    phrases: ['chatgpt', 'gpt-5', 'gpt-4'],
    patterns: [/\bgpt[\s-]?\d/i, /\bchatgpt\b/i],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    phrases: ['gemini', '제미니'],
    patterns: [/\bgemini\b/i],
  },
  {
    id: 'sora',
    label: 'Sora',
    phrases: ['sora', '소라'],
    patterns: [/\bsora\b/i],
  },
  {
    id: 'runway',
    label: 'Runway / Kling',
    phrases: ['runway', '런웨이', 'kling', '클링'],
    patterns: [/\brunway\b/i, /\bkling\b/i],
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    phrases: ['elevenlabs', '일레븐랩', 'tts 프롬', '보이스 프롬'],
    patterns: [/eleven\s*labs/i, /\btts\b/i],
  },
];

const IMAGE_INTENT =
  /(?:이미지|그림|일러|로고|포스터|썸네일|배경|아이콘|캐릭터|비주얼|image|illustration|logo|poster|thumbnail|wallpaper|visual|artwork|portrait|scene)/iu;

const FIX_OR_DECOMPILE_RE =
  /(?:고쳐|개선|수정|고쳐\s*줘|decompile|adapt|분석|깨진|나쁜\s*프롬|fix\s*(?:this\s+)?prompt|improve\s*(?:this\s+)?prompt)/iu;

function scoreRule(text: string, rule: TargetRule): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const phrase of rule.phrases) {
    if (lower.includes(phrase.toLowerCase())) score += (rule.weight ?? 1) * 3;
  }
  for (const re of rule.patterns) {
    if (re.test(text)) score += (rule.weight ?? 1) * 4;
  }
  return score;
}

function pickBest(rules: TargetRule[], text: string): { rule: TargetRule; score: number } | null {
  let best: { rule: TargetRule; score: number } | null = null;
  for (const rule of rules) {
    const score = scoreRule(text, rule);
    if (!best || score > best.score) best = { rule, score };
  }
  if (!best || best.score < 3) return null;
  return best;
}

/** Infer which AI tool's prompt syntax to use from the user message. */
export function resolvePromptMasterTarget(message: string): PromptMasterTargetResult {
  const text = message.trim();
  if (!text) {
    return {
      id: 'general',
      label: 'General',
      confidence: 0,
      reason: 'empty message',
    };
  }

  const comfy = pickBest([IMAGE_TARGETS.find((r) => r.id === 'comfyui')!], text);
  if (comfy && comfy.score >= 3) {
    return {
      id: 'comfyui',
      label: 'ComfyUI',
      confidence: Math.min(0.95, 0.5 + comfy.score * 0.08),
      reason: 'ComfyUI / workflow keywords detected',
    };
  }

  const imageHit = pickBest(
    IMAGE_TARGETS.filter((r) => r.id !== 'comfyui'),
    text,
  );
  const otherHit = pickBest(OTHER_TARGETS, text);

  if (imageHit && (!otherHit || imageHit.score >= otherHit.score)) {
    return {
      id: imageHit.rule.id,
      label: imageHit.rule.label,
      confidence: Math.min(0.95, 0.45 + imageHit.score * 0.08),
      reason: `${imageHit.rule.label} keywords detected`,
    };
  }

  if (otherHit) {
    return {
      id: otherHit.rule.id,
      label: otherHit.rule.label,
      confidence: Math.min(0.92, 0.4 + otherHit.score * 0.08),
      reason: `${otherHit.rule.label} keywords detected`,
    };
  }

  if (IMAGE_INTENT.test(text)) {
    return {
      id: 'dalle3',
      label: 'DALL-E 3',
      confidence: 0.55,
      reason: 'image intent without explicit tool — defaulting to DALL-E 3 (natural language)',
    };
  }

  return {
    id: 'general',
    label: 'General',
    confidence: 0.35,
    reason: 'no strong tool signal — use best-fit from task type',
  };
}

const TARGET_INSTRUCTIONS: Partial<Record<PromptMasterTargetId, string>> = {
  midjourney:
    'Use comma-separated descriptors (not prose). Subject → style → mood → lighting → composition. End with `--ar`, `--v`, `--style` as needed. Use `--no` for negatives.',
  dalle3:
    'Use clear prose description. Add "do not include text in the image unless specified." For complex scenes, separate foreground / midground / background.',
  stable_diffusion:
    'Output POSITIVE and NEGATIVE prompt blocks separately. Use `(keyword:weight)` syntax. Mention CFG 7–12 and steps 20–30 (draft) or 40–50 (final).',
  seedream:
    'Lead with art style (anime, cinematic, painterly). Mood and atmosphere before scene details. Include a negative prompt block.',
  comfyui:
    'Assume node workflow. Output separate Positive and Negative prompt blocks. Note checkpoint/model if unknown, do not block on it.',
  my_agent:
    'File path anchors + Done when (disk/verify evidence) + do-not-touch list. Prefer atomic apply_patch. For UI: one Acceptance click-path. ASK=explain only; PLAN=enterprise; AGENT=mutate now. Never claim 완료 without mutate + verify evidence. Scope to workspace paths.',
  cursor:
    'File path + function + current vs desired behavior + do-not-touch + Done when. Never give a global instruction without a path anchor.',
};

export function templateLettersForTarget(
  targetId: PromptMasterTargetId,
  userMessage: string,
): string[] {
  const letters = new Set(TARGET_TEMPLATE_LETTERS[targetId] ?? ['A', 'L']);
  if (FIX_OR_DECOMPILE_RE.test(userMessage)) letters.add('L');
  return [...letters].sort();
}

export function shouldIncludePromptMasterPatterns(userMessage: string): boolean {
  return FIX_OR_DECOMPILE_RE.test(userMessage);
}

/** Extract `## Template X — ...` sections by letter (A–M). */
export function extractTemplateSections(templatesMd: string, letters: string[]): string {
  const want = new Set(letters.map((l) => l.toUpperCase()));
  const parts = templatesMd.split(/^## Template /m);
  const out: string[] = [];
  for (const part of parts) {
    const m = part.match(/^([A-M])\s+[—\-]/);
    if (!m) continue;
    if (!want.has(m[1]!)) continue;
    out.push(`## Template ${part.trim()}`);
  }
  if (out.length === 0) return '';
  return ['# Prompt Templates Reference (selected)', '', ...out].join('\n\n');
}

function skillsDefaultsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'config', 'defaults', 'skills'),
    path.join(here, '..', 'config', 'defaults', 'skills'),
    path.join(here, 'config', 'defaults', 'skills'),
  ];
  for (const p of candidates) {
    if (existsSync(path.join(p, 'prompt-master-templates.md'))) return p;
  }
  return candidates[0]!;
}

function readSkillFile(name: string): string | null {
  const p = path.join(skillsDefaultsDir(), name);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Append only the templates (and optionally patterns) needed for this turn. */
export function buildPromptMasterReferenceAppend(
  targetId: PromptMasterTargetId,
  userMessage: string,
): string {
  const letters = templateLettersForTarget(targetId, userMessage);
  const chunks: string[] = [];

  // On-demand tool routing slice from full core (not loaded in slim system prompt).
  const fullCore = readSkillFile('prompt-master-core.md');
  if (fullCore) {
    const routing = extractPromptMasterRoutingSlice(fullCore, targetId);
    if (routing) chunks.push(routing);
  }

  const templates = readSkillFile('prompt-master-templates.md');
  if (templates) {
    const selected = extractTemplateSections(templates, letters);
    if (selected) chunks.push(selected);
  }
  if (shouldIncludePromptMasterPatterns(userMessage)) {
    const patterns = readSkillFile('prompt-master-patterns.md');
    if (patterns) chunks.push(patterns);
  }
  return chunks.join('\n\n---\n\n');
}

/** Pull targeted tool-routing paragraphs from MIDDLE ZONE by keyword. */
export function extractPromptMasterRoutingSlice(
  coreMd: string,
  targetId: PromptMasterTargetId,
): string {
  const mid = coreMd.search(/^## MIDDLE ZONE\b/m);
  if (mid < 0) return '';
  const body = coreMd.slice(mid);
  // Generic intent table always useful and short relative to full dump
  const intent = body.match(/### Intent Extraction[\s\S]*?(?=### Tool Routing|\n## )/i)?.[0] || '';
  const keywordMap: Record<PromptMasterTargetId, RegExp> = {
    midjourney: /\*\*Midjourney[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    dalle3: /\*\*DALL[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    stable_diffusion: /\*\*Stable Diffusion[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    seedream: /\*\*SeeDream[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    comfyui: /\*\*ComfyUI[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    claude: /\*\*Claude[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    chatgpt: /\*\*ChatGPT[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    gemini: /\*\*Gemini[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    cursor: /\*\*Cursor[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    my_agent: /\*\*MY Agent[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )|code agent|에이전트/i,
    sora: /\*\*Sora[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    runway: /\*\*Runway[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    elevenlabs: /\*\*ElevenLabs[\s\S]*?(?=\n\*\*[A-Z]|\n### |\n## )/i,
    general: /$a/, // never match full; keep general thin
  };
  const toolSlice = targetId === 'general' ? '' : (body.match(keywordMap[targetId])?.[0] || '');
  const parts = ['# Prompt Master Routing (selected)', intent.trim(), toolSlice.trim()].filter(Boolean);
  if (parts.length <= 1) return '';
  const out = parts.join('\n\n');
  // Hard cap routing inject so one tool never re-expands to 20k+
  return out.length > 6_000 ? `${out.slice(0, 6_000)}\n\n[... routing slice truncated ...]` : out;
}

export function augmentPromptMasterSystemPrompt(base: string, userMessage: string): string {
  const target = resolvePromptMasterTarget(userMessage);
  const syntax = TARGET_INSTRUCTIONS[target.id];
  const letters = templateLettersForTarget(target.id, userMessage);
  const refs = buildPromptMasterReferenceAppend(target.id, userMessage);
  const block = [
    '## MY Agent auto-detected target (overrides Primacy "confirm target tool" — do not ask unless two tools conflict)',
    `Target: **${target.label}** (${target.id})`,
    `Confidence: ${target.confidence.toFixed(2)} — ${target.reason}`,
    syntax
      ? `Syntax lock: ${syntax}`
      : 'Infer the best syntax from task type; do not ask a multiple-choice tool question.',
    `Loaded templates: ${letters.join(', ')}${shouldIncludePromptMasterPatterns(userMessage) ? ' + patterns' : ''}`,
    'Output order (mandatory):',
    '1. One line: `🎯 대상: [tool] · [why]`',
    '2. Single copy-paste prompt block',
    '3. Optional 1–2 line setup note only if needed',
    'Only ask ONE clarifying question if a required slot is missing (subject, style, or SKU) — never ask "which image AI?" when a target is already detected.',
  ].join('\n');
  const parts = [base, block];
  if (refs) parts.push(refs);
  return parts.join('\n\n---\n\n');
}
