import { Power } from '@phosphor-icons/react';
import { useState } from 'react';
import {
  loadMinimizeToTrayOnClose,
  saveMinimizeToTrayOnClose,
} from '../lib/appPreferences';
import { SettingsApplicationsSection } from './SettingsApplicationsSection';

export function SettingsProgramSection({ readOnly }: { readOnly: boolean }) {
  const [minimizeToTray, setMinimizeToTray] = useState(loadMinimizeToTrayOnClose);

  const updateMinimizeToTray = (enabled: boolean) => {
    setMinimizeToTray(enabled);
    saveMinimizeToTrayOnClose(enabled);
  };

  return (
    <section className="space-y-4 border-t border-border pt-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <Power size={18} className="text-accent" />
          <h3 className="text-sm font-semibold text-text">프로그램</h3>
        </div>
        <p className="text-xs text-muted">창 닫기 동작과 파일을 여는 기본 연결 앱을 관리합니다.</p>
      </div>

      <label className="flex cursor-pointer items-start justify-between gap-5 rounded-xl border border-border bg-panel/50 px-4 py-3">
        <span>
          <span className="block text-sm font-medium text-text">종료 시 트레이에서 계속 실행</span>
          <span className="mt-1 block text-xs leading-5 text-muted">
            닫기 버튼을 누르면 프로그램을 종료하지 않고 알림 영역으로 최소화합니다. 완전히 종료하려면 트레이 메뉴의 종료를 사용하세요.
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

      <SettingsApplicationsSection readOnly={readOnly} />
    </section>
  );
}
