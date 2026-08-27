import { useEffect, useState } from 'react';
import { activateLicense, fetchLicense, fetchSetupStatus } from '../api/myAgentClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import { LicenseImportPanel } from './LicenseImportPanel';

export function LicenseGate() {
  const licenseMode = useWorkspaceStore((state) => state.licenseMode);
  const setLicenseMode = useWorkspaceStore((state) => state.setLicenseMode);
  const [activating, setActivating] = useState(true);
  const [activationError, setActivationError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const setup = await fetchSetupStatus();
        if (cancelled) return;
        if (setup.needs_license && setup.activation_server_url) {
          try {
            await activateLicense();
          } catch (error) {
            if (!cancelled) {
              setActivationError(error instanceof Error ? error.message : '사내 활성화 서버에 연결하지 못했습니다.');
            }
          }
        }
        const license = await fetchLicense();
        if (!cancelled) setLicenseMode(license.mode ?? null);
      } catch {
        if (!cancelled) setLicenseMode(null);
      } finally {
        if (!cancelled) setActivating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setLicenseMode]);

  if (activating && (licenseMode === null || licenseMode === 'read_only')) {
    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/50 p-5 backdrop-blur-sm" data-testid="license-gate">
        <div className="w-full max-w-xl rounded-2xl border border-line bg-ink p-6 shadow-[0_28px_90px_rgba(0,0,0,0.28)]">
          <h2 className="mb-2 text-xl font-semibold">활성화 중</h2>
          <p className="text-sm leading-6 text-muted">사내 서버에서 라이선스와 키를 받는 중입니다.</p>
        </div>
      </div>
    );
  }

  if (licenseMode !== 'read_only') return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/50 p-5 backdrop-blur-sm"
      data-testid="license-gate"
    >
      <div className="w-full max-w-xl rounded-2xl border border-line bg-ink p-6 shadow-[0_28px_90px_rgba(0,0,0,0.28)]">
        <h2 className="mb-2 text-xl font-semibold">라이선스가 필요합니다</h2>
        <p className="mb-5 text-sm leading-6 text-muted">
          {activationError || '사내 활성화 서버에서 라이선스를 받지 못했습니다. 네트워크를 확인하거나 다시 시도하세요.'}
        </p>
        <LicenseImportPanel variant="gate" />
      </div>
    </div>
  );
}
