import { FolderOpen, IdentificationCard } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activateLicense,
  fetchLicense,
  fetchSetupStatus,
  importLicenseFile,
  importLicensePath,
  type LicenseStatusPayload,
  type SetupStatusPayload,
} from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';

type ShellWebViewMessage = {
  type?: string;
  requestId?: string;
  purpose?: string;
  canceled?: boolean;
  path?: string | null;
};

type ShellWebViewHost = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
};

function getShellWebView(): ShellWebViewHost | null {
  const chrome = (window as unknown as { chrome?: { webview?: ShellWebViewHost } }).chrome;
  return chrome?.webview ?? null;
}

function reasonLabel(reason?: string): string | null {
  if (!reason) return null;
  if (reason === 'LICENSE_MISSING') return '사내 서버에서 라이선스를 받지 못했습니다. 다시 시도하거나 네트워크를 확인하세요.';
  if (reason === 'LICENSE_EXPIRED') return '라이선스가 만료되었습니다. 새 파일을 선택하세요.';
  if (reason === 'LICENSE_USER_MISMATCH') return '이 라이선스는 다른 Windows 계정용입니다.';
  if (reason === 'LICENSE_MACHINE_MISMATCH') return '이 라이선스는 다른 PC용입니다.';
  if (reason === 'LICENSE_INVALID' || reason === 'LICENSE_SIGNATURE_INVALID') {
    return '라이선스 파일이 올바르지 않습니다.';
  }
  return '라이선스를 다시 등록하세요.';
}

export function LicenseImportPanel({
  variant,
  onImported,
}: {
  variant: 'gate' | 'settings';
  onImported?: () => void;
}) {
  const setLicenseMode = useWorkspaceStore((state) => state.setLicenseMode);
  const [status, setStatus] = useState<LicenseStatusPayload | null>(null);
  const [setup, setSetup] = useState<SetupStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const pickerRequestRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    const [nextLicense, nextSetup] = await Promise.all([fetchLicense(), fetchSetupStatus()]);
    setStatus(nextLicense);
    setSetup(nextSetup);
    setLicenseMode(nextLicense.mode ?? null);
    return nextLicense;
  }, [setLicenseMode]);

  useEffect(() => {
    void refresh().catch((error) => {
      setMessage(error instanceof Error ? error.message : '라이선스 상태를 확인하지 못했습니다.');
    });
  }, [refresh]);

  const finishImport = useCallback(
    async (orgId?: string) => {
      const next = await refresh();
      setMessage(orgId ? `라이선스를 등록했습니다${next.org_id ? ` · ${next.org_id}` : ''}.` : '라이선스를 등록했습니다.');
      onImported?.();
    },
    [onImported, refresh],
  );

  const importFromPath = useCallback(
    async (selectedPath: string) => {
      setBusy(true);
      setMessage('');
      try {
        const result = await importLicensePath(selectedPath);
        await finishImport(result.org_id);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '라이선스 등록 실패');
      } finally {
        setBusy(false);
      }
    },
    [finishImport],
  );

  const importFromFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setMessage('');
      try {
        const result = await importLicenseFile(file);
        await finishImport(result.org_id);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : '라이선스 등록 실패');
      } finally {
        setBusy(false);
      }
    },
    [finishImport],
  );

  useEffect(() => {
    const webview = getShellWebView();
    if (!webview) return;
    const onMessage = (event: { data: unknown }) => {
      const data = event.data as ShellWebViewMessage | null;
      const pending = pickerRequestRef.current;
      if (
        !data
        || !pending
        || data.type !== 'filePicker.result'
        || data.purpose !== 'licenseFile'
        || data.requestId !== pending
      ) return;
      pickerRequestRef.current = null;
      if (!data.canceled && typeof data.path === 'string' && data.path.trim()) {
        void importFromPath(data.path);
      }
    };
    webview.addEventListener('message', onMessage);
    return () => webview.removeEventListener('message', onMessage);
  }, [importFromPath]);

  const openPicker = () => {
    if (busy) return;
    const webview = getShellWebView();
    if (!webview) {
      fileInputRef.current?.click();
      return;
    }
    const requestId = `license-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pickerRequestRef.current = requestId;
    setMessage('라이선스 파일을 선택하세요.');
    webview.postMessage({ type: 'filePicker.open', requestId, purpose: 'licenseFile' });
  };

  const activateFromServer = async () => {
    setBusy(true);
    setMessage('');
    try {
      await activateLicense();
      await finishImport();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '서버 활성화 실패');
    } finally {
      setBusy(false);
    }
  };

  const licensed = status?.mode === 'full';
  const hint = licensed
    ? `등록됨${status?.org_id ? ` · ${status.org_id}` : ''}${status?.expires_at ? ` · ${status.expires_at.slice(0, 10)}까지` : ''}`
    : reasonLabel(status?.reason ?? setup?.license_reason) ?? '받은 라이선스 파일을 선택하세요.';
  const showActivate = Boolean(setup?.activation_server_url) && !licensed;

  return (
    <section
      className={`rounded-2xl border bg-panel p-5 shadow-sm ${
        dragOver ? 'border-accent' : 'border-line'
      } ${variant === 'gate' ? 'max-w-xl' : 'max-w-xl'}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer.files[0];
        if (file) void importFromFile(file);
      }}
    >
      <div className="mb-4 flex items-start gap-3">
        <IdentificationCard size={22} className="mt-0.5 text-accent" />
        <div className="min-w-0">
          <h3 className="font-semibold">{licensed ? '라이선스' : '라이선스 등록'}</h3>
          <p className="mt-1 text-sm leading-6 text-muted">{hint}</p>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".ocx,.lic,.json"
        className="hidden"
        data-testid="license-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFromFile(file);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="license-file-browse"
          disabled={busy}
          onClick={openPicker}
          className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <FolderOpen size={17} />
          {licensed ? '다른 파일로 교체' : '파일 선택'}
        </button>
        {showActivate ? (
          <button
            type="button"
            data-testid="license-activate-server"
            disabled={busy}
            onClick={() => void activateFromServer()}
            className="rounded-xl border border-line bg-[#fafbf8] px-4 py-2.5 text-sm font-semibold text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
          >
            사내 서버에서 활성화
          </button>
        ) : null}
      </div>
      <p className="mt-3 text-xs leading-5 text-muted">
        파일을 이 칸에 끌어다 놓아도 됩니다. 설치 폴더를 열 필요는 없습니다.
      </p>
      {message ? <p className="mt-3 text-sm text-muted">{message}</p> : null}
    </section>
  );
}
