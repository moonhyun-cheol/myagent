import { ArrowClockwise, Power } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import {
  loadMinimizeToTrayOnClose,
  loadUpdateAutoCheckEnabled,
  loadUpdatePollIntervalMs,
  saveMinimizeToTrayOnClose,
  saveUpdateAutoCheckEnabled,
  saveUpdatePollIntervalMs,
  syncMinimizeToTrayOnClose,
  syncUpdateSettings,
  triggerUpdateCheckNow,
  UPDATE_POLL_INTERVAL_OPTIONS,
} from '../lib/appPreferences';

export function SettingsLifecycleSection({ readOnly }: { readOnly: boolean }) {
  const [minimizeToTray, setMinimizeToTray] = useState(loadMinimizeToTrayOnClose);
  const [updateAutoCheck, setUpdateAutoCheck] = useState(loadUpdateAutoCheckEnabled);
  const [pollIntervalMs, setPollIntervalMs] = useState(loadUpdatePollIntervalMs);

  useEffect(() => {
    syncMinimizeToTrayOnClose();
    syncUpdateSettings();
  }, []);

  const updateMinimizeToTray = (enabled: boolean) => {
    setMinimizeToTray(enabled);
    saveMinimizeToTrayOnClose(enabled);
  };

  const updateAutoCheckSetting = (enabled: boolean) => {
    setUpdateAutoCheck(enabled);
    saveUpdateAutoCheckEnabled(enabled);
  };

  const updatePollInterval = (ms: number) => {
    setPollIntervalMs(ms);
    saveUpdatePollIntervalMs(ms);
  };

  return (
    <section className="mb-6 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
      <div className="mb-4">
        <div className="mb-1 flex items-center gap-2">
          <Power size={18} className="text-accent" />
          <h3 className="text-sm font-semibold text-text">앱 및 업데이트</h3>
        </div>
        <p className="text-xs text-muted">창 닫기 동작과 백그라운드 업데이트 확인을 관리합니다.</p>
      </div>

      <div className="space-y-4">
        <label className="flex cursor-pointer items-start justify-between gap-5 rounded-xl border border-border bg-panel/50 px-4 py-3">
          <span>
            <span className="block text-sm font-medium text-text">종료 시 트레이에서 계속 실행</span>
            <span className="mt-1 block text-xs leading-5 text-muted">
              닫기 버튼을 누르면 프로그램을 종료하지 않고 알림 영역으로 최소화합니다. 완전히 종료하려면 트레이 메뉴의 종료를 사용하세요.
              트레이에 있어도 업데이트 확인은 계속됩니다.
            </span>
          </span>
          <input
            type="checkbox"
            checked={minimizeToTray}
            disabled={readOnly}
            onChange={(event) => updateMinimizeToTray(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-accent"
            aria-label="종료 시 트레이에서 계속 실행"
          />
        </label>

        <div className="rounded-xl border border-border bg-panel/50 px-4 py-3">
          <label className="flex cursor-pointer items-start justify-between gap-5">
            <span>
              <span className="block text-sm font-medium text-text">업데이트 자동 확인</span>
              <span className="mt-1 block text-xs leading-5 text-muted">
                GitHub 릴리즈를 주기적으로 확인합니다. 에이전트 작업과 자동화가 모두 끝난 뒤에만 알림 후 설치할 수 있습니다.
                「아니오」를 누르면 확인 주기(15분·30분·1시간)가 지난 뒤, 다시 한가할 때 물어봅니다.
              </span>
            </span>
            <input
              type="checkbox"
              checked={updateAutoCheck}
              disabled={readOnly}
              onChange={(event) => updateAutoCheckSetting(event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-accent"
              aria-label="업데이트 자동 확인"
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="text-xs text-muted" htmlFor="update-poll-interval">
              확인 주기
            </label>
            <select
              id="update-poll-interval"
              value={pollIntervalMs}
              disabled={readOnly || !updateAutoCheck}
              onChange={(event) => updatePollInterval(Number(event.target.value))}
              className="rounded-lg border border-border bg-panel px-3 py-1.5 text-sm text-text"
            >
              {UPDATE_POLL_INTERVAL_OPTIONS.map((option) => (
                <option key={option.ms} value={option.ms}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => triggerUpdateCheckNow()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-panel px-3 py-1.5 text-sm font-medium text-text hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ArrowClockwise size={14} />
              지금 업데이트 확인
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
