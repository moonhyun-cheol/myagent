/**
 * Thin web_dev UI extras — the legacy web_landing mode was removed.
 * Landing-style work runs inside web_dev; the design-first guide is
 * appended conditionally by chat-skill-flow when the request asks for it.
 */

const DESIGN_FIRST_RE =
  /(?:디자인\s*스펙|프롬프트\s*골격|와이어프레임|design[- ]?first|스펙\s*먼저|레이아웃\s*설계|기획만|계획만)/iu;

/** One-liner for web_dev — do not expand into always-on Taste dumps. */
export const WEB_DEV_PRODUCT_UI_HINT =
  '## Product UI look (short): avoid Inter + purple/indigo AI-default chrome; one accent, clear hierarchy; no marketing-card spam on tool screens.';

export function shouldIncludeDesignFirst(userMessage: string): boolean {
  return DESIGN_FIRST_RE.test(userMessage);
}
