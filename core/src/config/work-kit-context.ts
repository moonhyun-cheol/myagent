/**
 * Applied work-kit context note for agent/chat harness.
 * Layer: config-store read — never mutates on inject.
 */
import { getAppliedProfileStates } from './agent-profile-store.js';
import { findWorkKitShelf, listWorkKitCatalog } from './profile-locker.js';
import { listAllSkills } from '../skills/skill-registry.js';
import { getOrganizationSkillDef, parseOrgSkillId } from '../skills/organization-skill-store.js';

function skillLabelForPin(cqrRoot: string, pin: string): string {
  const skills = listAllSkills(cqrRoot);
  const bare = pin.startsWith('org:') ? pin.slice(4) : pin;
  const byMode = skills.find((s) => s.mode === pin || s.id === bare);
  if (byMode) return `${byMode.label} (${byMode.mode})`;
  const orgId = parseOrgSkillId(pin);
  if (orgId) {
    const def = getOrganizationSkillDef(orgId, cqrRoot);
    if (def) return `${def.label} (${pin})`;
  }
  return pin;
}

function buildKitSection(
  cqrRoot: string,
  group: string,
  kitId: string,
  ui: { pinned_skill_ids?: string[]; default_skill_mode?: string },
): string[] {
  const shelf = findWorkKitShelf(cqrRoot, group, kitId);
  const label = shelf?.label ?? kitId;
  const description = shelf?.description?.trim();
  const pins = ui.pinned_skill_ids ?? [];
  const pinLines = pins.length
    ? pins.map((p) => `- ${skillLabelForPin(cqrRoot, p)}`).join('\n')
    : '- (핀된 스킬 없음 — 일반 Agent 모드로 진행)';
  const orgHint = shelf?.hints?.needs_organization_module
    ? '- 조직 모듈 스킬이 필요할 수 있습니다. 미설치 시 사용자에게 설정 → 스킬 → 모듈을 안내하세요.'
    : '';
  return [
    `### ${label} (\`${group}/${kitId}\`)`,
    description ? `Summary: ${description}` : '',
    'Relevant skills for this work scene (pick per turn when the task matches; explicit user skill/mode choice wins):',
    pinLines,
    orgHint,
  ].filter(Boolean);
}

export function buildWorkKitContextNote(cqrRoot: string): string | null {
  const entries = getAppliedProfileStates(cqrRoot);
  if (entries.length === 0) return null;

  const kitEntries = entries.filter((entry) => entry.group && entry.kit_id);
  if (kitEntries.length > 0) {
    const sections = kitEntries.flatMap((entry) =>
      buildKitSection(cqrRoot, entry.group!, entry.kit_id!, entry.ui),
    );
    return [
      '## Work context (applied work kits)',
      'The following kits are active together. Use skills/plugins from any kit when the task matches.',
      '',
      ...sections,
      '',
      'Do not toggle skills/plugins automatically. Use the catalog above to choose skill context when helpful.',
    ].join('\n');
  }

  const overlay = entries.find((entry) => entry.profile_id && entry.origin === 'overlay');
  if (overlay) {
    const pins = overlay.ui.pinned_skill_ids ?? [];
    if (pins.length === 0 && !overlay.ui.default_skill_mode) return null;
    const pinLines = pins.length
      ? pins.map((p) => `- ${skillLabelForPin(cqrRoot, p)}`).join('\n')
      : '';
    return [
      '## Work context (applied profile preset)',
      `Preset: **${overlay.profile_id}**`,
      overlay.ui.default_skill_mode ? `Preferred mode hint: ${overlay.ui.default_skill_mode}` : '',
      pinLines ? `Pinned skills:\n${pinLines}` : '',
    ].filter(Boolean).join('\n');
  }

  return null;
}

/** Single entry for harness — returns null when no applied work context. */
export function loadWorkKitContextNote(cqrRoot: string): string | null {
  return buildWorkKitContextNote(cqrRoot);
}

export function describeAppliedWorkKitLabel(cqrRoot: string): string | null {
  const entries = getAppliedProfileStates(cqrRoot);
  if (entries.length === 0) return null;
  const labels = entries.map((entry) => {
    if (entry.group && entry.kit_id) {
      const shelf = findWorkKitShelf(cqrRoot, entry.group, entry.kit_id);
      return shelf?.label ?? `${entry.group}/${entry.kit_id}`;
    }
    return entry.profile_id || null;
  }).filter((label): label is string => Boolean(label));
  return labels.length ? labels.join(', ') : null;
}

/** For API: applied kit + catalog install status snapshot. */
export function summarizeAppliedWorkKit(cqrRoot: string): {
  label: string | null;
  group: string | null;
  kit_id: string | null;
  install_status: string | null;
  kits: Array<{
    label: string;
    group: string;
    kit_id: string;
    install_status: string | null;
  }>;
} {
  const entries = getAppliedProfileStates(cqrRoot).filter(
    (entry) => entry.group && entry.kit_id,
  );
  if (entries.length === 0) {
    const fallback = getAppliedProfileStates(cqrRoot)[0];
    return {
      label: fallback?.profile_id ?? null,
      group: fallback?.group ?? null,
      kit_id: fallback?.kit_id ?? null,
      install_status: null,
      kits: [],
    };
  }
  const { groups } = listWorkKitCatalog(cqrRoot);
  const kits = entries.map((entry) => {
    const g = groups.find((x) => x.id === entry.group);
    const shelf = g?.shelves.find((s) => s.id === entry.kit_id);
    return {
      label: shelf?.label ?? `${entry.group}/${entry.kit_id}`,
      group: entry.group!,
      kit_id: entry.kit_id!,
      install_status: shelf?.install_status ?? null,
    };
  });
  const last = kits[kits.length - 1];
  return {
    label: kits.map((kit) => kit.label).join(', '),
    group: last.group,
    kit_id: last.kit_id,
    install_status: last.install_status,
    kits,
  };
}
