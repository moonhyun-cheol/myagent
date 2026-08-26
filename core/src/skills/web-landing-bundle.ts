/**
 * Selective extras for web_landing — thin anti-slop (Taste/ui-skills inspired)
 * + design-first skeleton only when planning/spec. Keep short for OWUI budgets.
 */

const DESIGN_FIRST_RE =
  /(?:디자인\s*스펙|프롬프트\s*골격|와이어프레임|design[- ]?first|스펙\s*먼저|레이아웃\s*설계|기획만|계획만)/iu;

const MOTION_RE =
  /(?:모션|애니메이션|animation|motion|스크롤\s*연출|gsap|framer)/iu;

/** Thin anti-slop lock — not a full Taste/ui-skills dump. */
export const WEB_LANDING_ANTI_SLOP = [
  '## Anti-slop (thin — landing)',
  'Do NOT ship generic AI-template UI: Inter/Roboto default stack, purple→indigo gradients, cream+#terracotta cliché, pill-chip spam, stat strips, or card-grid hero.',
  'First viewport = one composition: brand/product signal + one headline + one short support + one CTA group + one real visual anchor (not decorative mesh alone).',
  'Pick one clear visual direction (editorial / technical / soft-premium / brutal — match brief). One accent color family; dual-mode contrast if dark.',
  'Prefer distinctive type (or a named Korean-safe stack). Prefer full-bleed or edge-to-edge hero over inset media cards unless the design system requires cards.',
  'Motion: intentional 2–3 cues max when asked; no noise. If user did not ask for motion, skip heavy animation libraries.',
].join('\n');

/** One-liner for web_dev — do not expand into always-on Taste dumps. */
export const WEB_DEV_PRODUCT_UI_HINT =
  '## Product UI look (short): avoid Inter + purple/indigo AI-default chrome; one accent, clear hierarchy; no marketing-card spam on tool screens.';

export function shouldIncludeDesignFirst(userMessage: string): boolean {
  return DESIGN_FIRST_RE.test(userMessage);
}

export function shouldIncludeMotionHint(userMessage: string): boolean {
  return MOTION_RE.test(userMessage);
}

export function augmentWebLandingSystemPrompt(base: string, userMessage: string): string {
  const lines = [
    '## MY Agent web_landing verify lock',
    'After writing HTML: MUST `browser_navigate` + `browser_screenshot` when Playwright is available.',
    'If browser tools are unavailable, say explicitly: `미검증(브라우저 도구 없음)` — do not claim layout 완료.',
    'Done = file on disk + screenshot or explicit 미검증. One primary CTA.',
    WEB_LANDING_ANTI_SLOP,
  ];
  if (shouldIncludeMotionHint(userMessage)) {
    lines.push(
      '## Motion (on-demand)',
      'User asked for motion — add 2–3 purposeful cues (entrance/scroll/hover). Prefer CSS; pull GSAP only if complexity warrants.',
    );
  }
  if (shouldIncludeDesignFirst(userMessage)) {
    lines.push(
      'User asked for design/spec first — use the design-first skeleton (GOAL/FORMAT/LAYOUT/TYPE/COLOR/COPY/CONSTRAINTS) before code.',
    );
  } else {
    lines.push('Skip long design-prompt scaffolding; ship HTML sections unless user asks for a spec-only plan.');
  }
  return `${base}\n\n---\n\n${lines.join('\n')}`;
}
