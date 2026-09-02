import { SettingsProgramSection } from './SettingsProgramSection';
import { SettingsInstallRootSection } from './SettingsInstallRootSection';

export function SettingsGeneralPage({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">일반</h2>
        <p className="mt-1 text-sm text-muted">프로그램 동작과 파일 연결 설정을 관리합니다.</p>
      </header>
      <SettingsInstallRootSection />
      <div className="max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <SettingsProgramSection readOnly={readOnly} />
      </div>
    </div>
  );
}
