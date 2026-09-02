import { Check, Copy, Folder } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { fetchAgentHealth } from '../api/myAgentClient';

export function SettingsInstallRootSection() {
  const [installRoot, setInstallRoot] = useState('');
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError('');
      try {
        const health = await fetchAgentHealth();
        if (cancelled) return;
        setInstallRoot(health.cqr_root);
        setVersion(health.version);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '설치 폴더를 불러오지 못했습니다.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copyInstallRoot = async () => {
    if (!installRoot) return;
    try {
      await navigator.clipboard.writeText(installRoot);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('클립보드에 복사하지 못했습니다.');
    }
  };

  return (
    <section className="mb-6 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Folder size={18} className="text-accent" />
        <h3 className="text-sm font-semibold text-text">설치 폴더</h3>
      </div>
      <p className="text-xs leading-5 text-muted">
        MY Agent와 MY Agent 관리자가 공유하는 설치 루트입니다.
        관리자 설치가 경로를 찾지 못할 때 여기서 복사해{' '}
        <code className="rounded bg-ink/40 px-1 py-0.5 text-[11px]">install-launcher.bat</code>
        {' '}실행 시 붙여넣거나, 환경 변수{' '}
        <code className="rounded bg-ink/40 px-1 py-0.5 text-[11px]">MY_AGENT_ROOT</code>
        {' '}에 설정하세요.
      </p>
      {version ? (
        <p className="mt-2 text-[11px] text-muted">제품 버전 {version}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-start gap-3">
        <code
          data-testid="settings-install-root"
          className="min-w-0 flex-1 break-all rounded-xl border border-border bg-ink/30 px-3 py-2.5 text-xs text-text"
        >
          {loading ? '불러오는 중…' : error || installRoot || '(없음)'}
        </code>
        <button
          type="button"
          data-testid="settings-install-root-copy"
          disabled={!installRoot || loading}
          onClick={() => void copyInstallRoot()}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-panel px-3 py-2 text-sm font-medium text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? '복사됨' : '복사'}
        </button>
      </div>
    </section>
  );
}
