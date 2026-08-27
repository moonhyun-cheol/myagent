import { LicenseImportPanel } from './LicenseImportPanel';

export function SettingsLicensePage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">라이선스</h2>
        <p className="mt-1 text-sm text-muted">받은 파일을 선택하면 이 PC에 등록됩니다.</p>
      </header>
      <LicenseImportPanel variant="settings" />
    </div>
  );
}
