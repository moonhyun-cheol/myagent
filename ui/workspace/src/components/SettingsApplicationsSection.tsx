import { ArrowCounterClockwise, Check, FolderOpen, NotePencil } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_FILE_ASSOCIATIONS,
  loadFileAssociations,
  resolveApplicationExecutable,
  saveFileAssociations,
  type FileAssociationSettings,
} from '../lib/applicationAssociations';

type AssociationKey = keyof FileAssociationSettings;

type ShellWebViewMessage = {
  type?: string;
  requestId?: string;
  canceled?: boolean;
  path?: string | null;
};

type ShellWebViewHost = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
};

const RECOMMENDED_APPS: Record<AssociationKey, Array<{ label: string; value: string }>> = {
  textEditor: [
    { label: 'Windows 기본 앱', value: '' },
    { label: '메모장', value: 'notepad.exe' },
    { label: 'VS Code', value: 'code.cmd' },
    { label: 'Notepad++', value: 'notepad++.exe' },
  ],
  imageEditor: [
    { label: 'Windows 기본 앱', value: '' },
    { label: '그림판', value: 'mspaint.exe' },
    { label: 'IrfanView', value: 'i_view64.exe' },
  ],
};

function getShellWebView(): ShellWebViewHost | null {
  const chrome = (window as unknown as { chrome?: { webview?: ShellWebViewHost } }).chrome;
  return chrome?.webview ?? null;
}

export function SettingsApplicationsSection({ readOnly }: { readOnly: boolean }) {
  const [draft, setDraft] = useState<FileAssociationSettings>(() => loadFileAssociations());
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState('');
  const [resolving, setResolving] = useState<AssociationKey | null>(null);
  const pickerRequestRef = useRef<{ id: string; key: AssociationKey } | null>(null);

  useEffect(() => {
    const webview = getShellWebView();
    if (!webview) return;
    const onMessage = (event: { data: unknown }) => {
      const data = event.data as ShellWebViewMessage;
      const pending = pickerRequestRef.current;
      if (!pending || data.type !== 'filePicker.result' || data.requestId !== pending.id) return;
      pickerRequestRef.current = null;
      if (data.canceled) {
        setMessage('실행 파일 선택을 취소했습니다.');
        return;
      }
      if (typeof data.path === 'string' && data.path.trim()) {
        update(pending.key, data.path.trim());
        setMessage('선택한 실행 파일을 적용했습니다. 저장 버튼을 눌러 확정하세요.');
      }
    };
    webview.addEventListener('message', onMessage);
    return () => webview.removeEventListener('message', onMessage);
  }, []);

  const update = (key: keyof FileAssociationSettings, value: string) => {
    setMessage('');
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const selectRecommendedApp = async (key: AssociationKey, value: string, label: string) => {
    if (!value) {
      update(key, '');
      setMessage(`${label}을 사용하도록 선택했습니다. 저장 버튼을 눌러 적용하세요.`);
      return;
    }

    setResolving(key);
    setMessage(`${label} 설치 경로를 확인하고 있습니다.`);
    try {
      const absolutePath = await resolveApplicationExecutable(value);
      update(key, absolutePath);
      setMessage(`${label} 실행 파일을 확인했습니다. 저장 버튼을 눌러 적용하세요.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${label} 실행 파일을 찾지 못했습니다.`);
    } finally {
      setResolving(null);
    }
  };

  const browseExecutable = (key: AssociationKey) => {
    const webview = getShellWebView();
    if (!webview) {
      setMessage('실행 파일 탐색은 데스크톱 앱에서 사용할 수 있습니다.');
      return;
    }
    const requestId = crypto.randomUUID();
    pickerRequestRef.current = { id: requestId, key };
    setMessage('Windows 탐색기에서 실행 파일을 선택하세요.');
    webview.postMessage({
      type: 'filePicker.open',
      requestId,
      purpose: 'applicationExecutable',
      extensions: ['.exe', '.com', '.bat', '.cmd'],
    });
  };

  const save = async () => {
    setMessage('연결 프로그램 경로를 확인하고 있습니다.');
    setResolving('textEditor');
    try {
      const textEditor = await resolveApplicationExecutable(draft.textEditor);
      setResolving('imageEditor');
      const imageEditor = await resolveApplicationExecutable(draft.imageEditor);
      saveFileAssociations({ textEditor, imageEditor });
      setDraft(loadFileAssociations());
      setSaved(true);
      setMessage('확인된 실행 파일 절대 경로를 저장했습니다.');
    } catch (error) {
      setSaved(false);
      setMessage(error instanceof Error ? error.message : '연결 프로그램 경로를 확인하지 못했습니다.');
    } finally {
      setResolving(null);
    }
  };

  const reset = () => {
    setDraft({ ...DEFAULT_FILE_ASSOCIATIONS });
    setSaved(false);
  };

  return (
    <section className="mt-5 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
      <div className="mb-4 flex items-start gap-3">
        <NotePencil size={21} className="mt-0.5 shrink-0 text-accent" />
        <div>
          <h3 className="font-semibold">연결 프로그램</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            파일 탐색기의 ‘연결 프로그램으로 열기’가 사용할 Windows 실행 파일을 지정합니다.
          </p>
        </div>
      </div>

      <div className="space-y-5">
        {([
          { key: 'textEditor', label: '기본 텍스트 에디터', placeholder: 'notepad.exe 또는 C:\\경로\\Editor.exe' },
          { key: 'imageEditor', label: '이미지 편집기/뷰어', placeholder: '비워 두면 Windows 기본 앱 사용' },
        ] as const).map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="block">
              <span className="text-xs font-medium text-text">{label}</span>
              <div className="mt-1.5 flex gap-2">
                <input
                  value={draft[key]}
                  onChange={(event) => update(key, event.target.value)}
                  disabled={readOnly}
                  placeholder={placeholder}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => browseExecutable(key)}
                  disabled={readOnly}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-text hover:border-accent disabled:opacity-45"
                >
                  <FolderOpen size={15} />찾아보기
                </button>
              </div>
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] text-muted">추천</span>
              {RECOMMENDED_APPS[key].map((app) => (
                <button
                  key={app.label}
                  type="button"
                  onClick={() => void selectRecommendedApp(key, app.value, app.label)}
                  disabled={readOnly || resolving !== null}
                  title={app.value || '파일 형식에 연결된 Windows 기본 앱 사용'}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-45 ${
                    (app.value === '' ? draft[key] === '' : draft[key].toLowerCase().endsWith(`\\${app.value.toLowerCase()}`))
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-line text-muted hover:text-text'
                  }`}
                >
                  {app.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {message ? <p className="mt-3 text-xs text-muted" role="status">{message}</p> : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        {saved ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-accent"><Check size={14} />저장됨</span> : null}
        <button type="button" onClick={reset} disabled={readOnly} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs text-muted hover:text-text disabled:opacity-45">
          <ArrowCounterClockwise size={14} />기본값
        </button>
        <button type="button" onClick={() => void save()} disabled={readOnly || resolving !== null} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-ink disabled:opacity-45">
          연결 프로그램 저장
        </button>
      </div>
    </section>
  );
}
