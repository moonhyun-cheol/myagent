import { X } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import type { AgentProfileApplied, WorkKitCatalogGroup, WorkKitShelf } from '../api/myAgentClient';

interface ProfilePickerModalProps {
  open: boolean;
  readOnly: boolean;
  groups: WorkKitCatalogGroup[];
  applied: AgentProfileApplied | null;
  onClose: () => void;
  onApply: (group: string, id: string) => void | Promise<void>;
}

export function ProfilePickerModal({
  open,
  readOnly,
  groups,
  applied,
  onClose,
  onApply,
}: ProfilePickerModalProps) {
  const firstId = groups[0]?.id ?? '';
  const [selectedGroup, setSelectedGroup] = useState(firstId);
  const activeGroupId = groups.some((g) => g.id === selectedGroup)
    ? selectedGroup
    : firstId;
  const active = useMemo(
    () => groups.find((g) => g.id === activeGroupId) ?? null,
    [groups, activeGroupId],
  );

  if (!open) return null;

  return (
    <div
      data-testid="profile-picker-modal"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="작업 환경 선택"
    >
      <div className="flex max-h-[min(640px,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-text">작업 환경 선택</h2>
            <p className="text-xs text-muted">브랜드를 고른 뒤, 오늘 할 일에 맞는 키트를 고르세요.</p>
          </div>
          <button
            type="button"
            data-testid="profile-picker-close"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-ink hover:text-text"
            aria-label="닫기"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="w-40 shrink-0 overflow-y-auto border-r border-line bg-ink/40 p-2">
            {groups.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted">등록된 브랜드가 없습니다.</p>
            ) : (
              groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  data-testid={`profile-picker-brand-${g.id}`}
                  onClick={() => setSelectedGroup(g.id)}
                  className={`mb-1 w-full rounded-xl px-3 py-2.5 text-left text-sm font-semibold ${
                    activeGroupId === g.id
                      ? 'bg-accent/15 text-accent'
                      : 'text-text hover:bg-ink'
                  }`}
                >
                  {g.label}
                  <span className="mt-0.5 block text-[10px] font-normal text-muted">
                    {g.shelves.length}개 키트
                  </span>
                </button>
              ))
            )}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!active ? (
              <p className="text-sm text-muted">브랜드를 선택하세요.</p>
            ) : active.shelves.length === 0 ? (
              <p className="text-sm text-muted">이 브랜드에 키트가 없습니다.</p>
            ) : (
              <ul className="space-y-2">
                {active.shelves.map((shelf) => (
                  <KitCard
                    key={`${shelf.group}/${shelf.id}`}
                    shelf={shelf}
                    applied={applied}
                    readOnly={readOnly}
                    onApply={() => void onApply(shelf.group, shelf.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function KitCard({
  shelf,
  applied,
  readOnly,
  onApply,
}: {
  shelf: WorkKitShelf;
  applied: AgentProfileApplied | null;
  readOnly: boolean;
  onApply: () => void;
}) {
  const isApplied =
    applied?.group === shelf.group && applied?.kit_id === shelf.id;
  return (
    <li
      data-testid={`profile-picker-kit-${shelf.group}-${shelf.id}`}
      className="flex items-start justify-between gap-3 rounded-xl border border-line bg-[#fafbf8] px-4 py-3"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text">{shelf.label}</span>
          {isApplied ? (
            <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              적용 중
            </span>
          ) : null}
        </div>
        {shelf.description ? (
          <p className="mt-1 text-xs text-muted">{shelf.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        data-testid={`profile-picker-apply-${shelf.group}-${shelf.id}`}
        disabled={readOnly}
        onClick={onApply}
        className="shrink-0 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
      >
        적용
      </button>
    </li>
  );
}
