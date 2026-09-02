import { SettingsApplicationsSection } from './SettingsApplicationsSection';
import { SettingsInstallRootSection } from './SettingsInstallRootSection';
import { SettingsLifecycleSection } from './SettingsLifecycleSection';

export function SettingsGeneralPage({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">일반</h2>
        <p className="mt-1 text-sm text-muted">설치 경로, 앱 동작, 파일 연결을 관리합니다.</p>
      </header>
      <SettingsInstallRootSection />
      <SettingsLifecycleSection readOnly={readOnly} />
      <SettingsApplicationsSection readOnly={readOnly} />
    </div>
  );
}
