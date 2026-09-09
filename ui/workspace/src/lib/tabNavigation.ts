import type { KeyboardEvent } from 'react';

/** Roving focus for horizontal tab lists; activation remains the button's normal click. */
export function navigateTabs(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[index].focus();
  tabs[index].click();
}