/**
 * Lightweight xterm.js host for HITL / sidecar stdout (ADR-009 Wave 3 / OSS-G02).
 * Not mounted in the main chrome by default — import where a live log pane is needed.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function SidecarTerminal({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      theme: {
        background: '#cdd4d0',
        foreground: '#17211d',
        cursor: '#0f8f83',
        selectionBackground: '#a8d8d2',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.write(text.replace(/\n/g, '\r\n'));
  }, [text]);

  return (
    <div
      ref={hostRef}
      className={className}
      data-testid="sidecar-terminal"
      style={{ minHeight: 160, width: '100%' }}
    />
  );
}
