/** 작업 → 할 일 → 고정 지침. Sent as `pinned_instructions`; core injects it as context, never as message text. */
export const PINNED_INSTRUCTIONS_KEY = 'my-agent-pinned-instructions-v1';

export function loadPinnedInstructions(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_INSTRUCTIONS_KEY) ?? '[]');
    return Array.isArray(value) ? value.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function savePinnedInstructions(items: string[]): void {
  try {
    localStorage.setItem(PINNED_INSTRUCTIONS_KEY, JSON.stringify(items));
  } catch {
    // Storage may be unavailable; the in-memory list still updates for this view.
  }
}
