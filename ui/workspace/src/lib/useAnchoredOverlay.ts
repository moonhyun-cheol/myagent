import { useLayoutEffect, useState, type RefObject } from 'react';

export interface OverlayViewport {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function overlayViewport(): OverlayViewport {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? document.documentElement.clientWidth;
  const height = viewport?.height ?? document.documentElement.clientHeight;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

export function clampOverlayPoint(
  x: number,
  y: number,
  overlay: HTMLElement,
  padding = 8,
): { left: number; top: number } {
  const viewport = overlayViewport();
  return {
    left: Math.max(viewport.left + padding, Math.min(x, viewport.right - overlay.offsetWidth - padding)),
    top: Math.max(viewport.top + padding, Math.min(y, viewport.bottom - overlay.offsetHeight - padding)),
  };
}

/** Re-clamps a pointer-positioned overlay while a native WebView2 window settles. */
export function usePointOverlay(
  open: boolean,
  x: number,
  y: number,
  overlayRef: RefObject<HTMLElement | null>,
): { left: number; top: number } | null {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !overlayRef.current) {
      setPosition(null);
      return;
    }
    const overlay = overlayRef.current;
    let frame = 0;
    let remainingFrames = 0;
    const measure = () => {
      if (overlay.isConnected) setPosition(clampOverlayPoint(x, y, overlay));
    };
    const tick = () => {
      measure();
      remainingFrames -= 1;
      if (remainingFrames > 0) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      remainingFrames = 4;
      frame = requestAnimationFrame(tick);
    };

    setPosition(null);
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    observer.observe(overlay);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [open, overlayRef, x, y]);

  return position;
}

interface AnchoredOverlayOptions {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  overlayRef: RefObject<HTMLElement | null>;
  align?: 'start' | 'end';
  gap?: number;
  padding?: number;
  maxHeight?: number;
}

/**
 * Keeps a fixed, portalled overlay attached while WebView2 settles after a native
 * window resize. Several frames are intentionally sampled because WPF bounds and
 * the CSS/visual viewports are not updated atomically during maximize/restore.
 */
export function useAnchoredOverlay({
  open,
  anchorRef,
  overlayRef,
  align = 'start',
  gap = 6,
  padding = 8,
  maxHeight,
}: AnchoredOverlayOptions): void {
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const overlay = overlayRef.current;
    if (!anchor || !overlay) return;

    let frame = 0;
    let remainingFrames = 0;

    const position = () => {
      if (!anchor.isConnected || !overlay.isConnected) return;
      const viewport = overlayViewport();
      const rect = anchor.getBoundingClientRect();
      if (viewport.width <= 0 || viewport.height <= 0 || rect.width <= 0 || rect.height <= 0) {
        overlay.style.visibility = 'hidden';
        return;
      }

      // A native resize can briefly expose an old anchor rect with a new viewport.
      // Do not clamp that transient value to the far edge; wait for a later frame.
      if (rect.right < viewport.left || rect.left > viewport.right || rect.bottom < viewport.top || rect.top > viewport.bottom) {
        overlay.style.visibility = 'hidden';
        return;
      }

      const below = Math.max(0, viewport.bottom - rect.bottom - gap - padding);
      const above = Math.max(0, rect.top - viewport.top - gap - padding);
      const naturalHeight = overlay.scrollHeight;
      const upward = below < Math.min(naturalHeight, maxHeight ?? naturalHeight) && above > below;
      const availableHeight = upward ? above : below;
      overlay.style.maxHeight = `${Math.max(1, Math.min(maxHeight ?? availableHeight, availableHeight))}px`;

      const desiredLeft = align === 'end' ? rect.right - overlay.offsetWidth : rect.left;
      const left = Math.max(
        viewport.left + padding,
        Math.min(desiredLeft, viewport.right - overlay.offsetWidth - padding),
      );
      const top = upward
        ? Math.max(viewport.top + padding, rect.top - overlay.offsetHeight - gap)
        : Math.min(rect.bottom + gap, viewport.bottom - overlay.offsetHeight - padding);

      overlay.style.left = `${Math.round(left)}px`;
      overlay.style.top = `${Math.round(Math.max(viewport.top + padding, top))}px`;
      overlay.style.visibility = 'visible';
    };

    const tick = () => {
      position();
      remainingFrames -= 1;
      if (remainingFrames > 0) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      remainingFrames = 4;
      frame = requestAnimationFrame(tick);
    };

    overlay.style.visibility = 'hidden';
    schedule();

    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    observer.observe(anchor);
    observer.observe(overlay);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [align, anchorRef, gap, maxHeight, open, overlayRef, padding]);
}
