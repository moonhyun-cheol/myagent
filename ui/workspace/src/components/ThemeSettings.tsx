import { useState } from 'react';
import { setThemePreference, useTheme, type ThemePreference } from '../lib/theme';

export function ThemeSettings() {
  const { preference } = useTheme();
  const [saved, setSaved] = useState(true);
  return <section className="mb-6 rounded-xl border border-line bg-panel p-4" aria-label="화면 테마">
    <label className="flex flex-wrap items-center justify-between gap-3 text-sm font-medium">
      화면 테마
      <select aria-label="화면 테마" value={preference} className="min-h-9 rounded-lg border border-line bg-panel px-3 text-sm"
        onChange={event => setSaved(setThemePreference(event.target.value as ThemePreference))}>
        <option value="system">시스템 설정 따름</option><option value="light">라이트</option><option value="dark">다크</option>
      </select>
    </label>
    <p className="mt-2 text-xs leading-5 text-muted">앱 내부 화면에 적용됩니다. 외부 웹페이지와 Windows 제목 표시줄은 별도입니다.</p>
    {!saved && <p role="status" className="mt-2 text-xs text-warning">현재 창에 적용했지만 설정을 보관하지 못했습니다.</p>}
  </section>;
}