import { ChatText } from '@phosphor-icons/react';
import {
  setConversationDisplayPreference,
  useConversationDisplayPreferences,
} from '../lib/conversationDisplayPreferences';

export function SettingsConversationPage({ readOnly }: { readOnly: boolean }) {
  const prefs = useConversationDisplayPreferences();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink px-8 py-7">
      <header className="mb-6 pr-12">
        <h2 className="text-xl font-semibold">대화</h2>
        <p className="mt-1 text-sm text-muted">대화 화면에 표시할 추가 정보를 관리합니다.</p>
      </header>

      <section className="mb-6 max-w-3xl rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="mb-4">
          <div className="mb-1 flex items-center gap-2">
            <ChatText size={18} className="text-accent" />
            <h3 className="text-sm font-semibold text-text">대화 표시</h3>
          </div>
          <p className="text-xs text-muted">
            요청·응답별 토큰 사용량과 시간 정보를 표시합니다. 두 항목 모두 기본값은 꺼짐이며 이 PC에만 저장됩니다.
          </p>
        </div>

        <div className="space-y-4">
          <label className="flex cursor-pointer items-start justify-between gap-5 rounded-xl border border-border bg-panel/50 px-4 py-3">
            <span>
              <span className="block text-sm font-medium text-text">사용 토큰 표시</span>
              <span className="mt-1 block text-xs leading-5 text-muted">
                프로바이더가 사용량을 제공한 요청·응답에 입력/출력 토큰 수를 표시합니다.
              </span>
            </span>
            <input
              type="checkbox"
              checked={prefs.showTokens}
              disabled={readOnly}
              onChange={(event) => setConversationDisplayPreference('showTokens', event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-accent"
              aria-label="사용 토큰 표시"
            />
          </label>

          <label className="flex cursor-pointer items-start justify-between gap-5 rounded-xl border border-border bg-panel/50 px-4 py-3">
            <span>
              <span className="block text-sm font-medium text-text">시간 정보 표시</span>
              <span className="mt-1 block text-xs leading-5 text-muted">
                요청·응답 시각과 응답 소요시간(mm:ss)을 표시합니다.
              </span>
            </span>
            <input
              type="checkbox"
              checked={prefs.showTime}
              disabled={readOnly}
              onChange={(event) => setConversationDisplayPreference('showTime', event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-accent"
              aria-label="시간 정보 표시"
            />
          </label>
        </div>
      </section>
    </div>
  );
}
