export interface HistoryAnchor {
  id: string;
  role: string;
  top: number;
}

export interface HistoryCursor {
  id: string;
  scrollTop: number;
}

const keys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']);
const interactive = '[data-chat-bubble],a,button,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[tabindex],[role="button"],[role="menu"],[role="dialog"]';

/** Only blank conversation space claims focus; message text and controls keep theirs. */
export function focusHistoryBackground(container: HTMLElement, target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const control = target.closest(interactive);
  if (target !== container && control && control !== container) return;
  container.focus({ preventScroll: true });
}

export function historyTarget(
  anchors: HistoryAnchor[], key: string, scrollTop: number, cursor: HistoryCursor | null,
): HistoryAnchor | undefined {
  if (!anchors.length) return undefined;
  let current = cursor && Math.abs(cursor.scrollTop - scrollTop) <= 1
    ? anchors.findIndex((anchor) => anchor.id === cursor.id) : -1;
  if (current < 0) {
    current = 0;
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i].top <= scrollTop + 13) current = i;
    }
  }
  const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    return anchors[Math.max(0, Math.min(anchors.length - 1, current + direction))];
  }
  const requests = anchors.filter((anchor) => anchor.role === 'user');
  if (!requests.length) return undefined;
  let turn = -1;
  for (let i = 0; i <= current; i++) {
    if (anchors[i].role === 'user') turn = requests.findIndex((anchor) => anchor.id === anchors[i].id);
  }
  return requests[Math.max(0, Math.min(requests.length - 1, turn + direction))];
}

/**
 * Tab (no modifiers) while the history region itself holds focus moves focus to the
 * request composer. Individual interactive elements inside messages keep native tabbing.
 */
export function tabToComposer(
  event: KeyboardEvent, container: HTMLElement, composer: HTMLElement | null,
): boolean {
  if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
  if (event.target !== container || container.ownerDocument.activeElement !== container || !composer) return false;
  event.preventDefault();
  event.stopPropagation();
  composer.focus();
  return true;
}

/** Returns a logical cursor as short final messages may be clamped to the same scroll offset. */
export function navigateHistory(
  event: KeyboardEvent, container: HTMLElement, anchors: HistoryAnchor[], cursor: HistoryCursor | null,
  blocked = false,
): HistoryCursor | null {
  if (blocked || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.target !== container || container.ownerDocument.activeElement !== container || !keys.has(event.key)) return cursor;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'PageUp' || event.key === 'PageDown') {
    container.scrollTo({ top: Math.max(0, container.scrollTop + (event.key === 'PageUp' ? -1 : 1) * container.clientHeight * 0.9), behavior: 'instant' });
    return null;
  }
  const target = historyTarget(anchors, event.key, container.scrollTop, cursor);
  if (!target) return null;
  container.scrollTo({ top: Math.max(0, target.top - 12), behavior: 'instant' });
  return { id: target.id, scrollTop: container.scrollTop };
}
