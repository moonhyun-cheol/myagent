/**
 * Applied work-kit context note for agent/chat harness.
 * Layer: config-store read — never mutates on inject.
 */
import { getAppliedProfileState } from './agent-profile-store.js';
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

export function buildWorkKitContextNote(cqrRoot: string): string | null {
  const applied = getAppliedProfileState(cqrRoot);
  if (!applied) return null;

  if (applied.group && applied.kit_id) {
    const shelf = findWorkKitShelf(cqrRoot, applied.group, applied.kit_id);
    const label = shelf?.label ?? applied.kit_id;
    const description = shelf?.description?.trim();
    const pins = applied.ui.pinned_skill_ids ?? [];
    const pinLines = pins.length
      ? pins.map((p) => `- ${skillLabelForPin(cqrRoot, p)}`).join('\n')
      : '- (핀된 스킬 없음 — 일반 Agent 모드로 진행)';
    const orgHint = shelf?.hints?.needs_organization_module
      ? '\n- 조직 모듈 스킬이 필요할 수 있습니다. 미설치 시 사용자에게 설정 → 스킬 → 모듈을 안내하세요.'
      : '';

    return [
      '## Work context (applied work kit)',
      `Active kit: **${label}** (\`${applied.group}/${applied.kit_id}\`)`,
      description ? `Summary: ${description}` : '',
      '',
      'Relevant skills for this work scene (pick per turn when the task matches; explicit user skill/mode choice wins):',
      pinLines,
      '',
      'Do not toggle skills/plugins automatically. Use the catalog above to choose skill context when helpful.',
      orgHint,
    ].filter(Boolean).join('\n');
  }

  if (applied.profile_id && applied.origin === 'overlay') {
    const pins = applied.ui.pinned_skill_ids ?? [];
    if (pins.length === 0 && !applied.ui.default_skill_mode) return null;
    const pinLines = pins.length
      ? pins.map((p) => `- ${skillLabelForPin(cqrRoot, p)}`).join('\n')
      : '';
    return [
      '## Work context (applied profile preset)',
      `Preset: **${applied.profile_id}**`,
      applied.ui.default_skill_mode ? `Preferred mode hint: ${applied.ui.default_skill_mode}` : '',
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
  const applied = getAppliedProfileState(cqrRoot);
  if (!applied) return null;
  if (applied.group && applied.kit_id) {
    const shelf = findWorkKitShelf(cqrRoot, applied.group, applied.kit_id);
    return shelf?.label ?? `${applied.group}/${applied.kit_id}`;
  }
  return applied.profile_id || null;
}

/** For API: applied kit + catalog install status snapshot. */
export function summarizeAppliedWorkKit(cqrRoot: string): {
  label: string | null;
  group: string | null;
  kit_id: string | null;
  install_status: string | null;
} {
  const applied = getAppliedProfileState(cqrRoot);
  if (!applied?.group || !applied.kit_id) {
    return {
      label: applied?.profile_id ?? null,
      group: applied?.group ?? null,
      kit_id: applied?.kit_id ?? null,
      install_status: null,
    };
  }
  const { groups } = listWorkKitCatalog(cqrRoot);
  const g = groups.find((x) => x.id === applied.group);
  const shelf = g?.shelves.find((s) => s.id === applied.kit_id);
  return {
    label: shelf?.label ?? `${applied.group}/${applied.kit_id}`,
    group: applied.group,
    kit_id: applied.kit_id,
    install_status: shelf?.install_status ?? null,
  };
}
