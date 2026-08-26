import { closeSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const OFFICE_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.pptx', '.ppt', '.pptm']);

export interface WorkspaceCapabilities {
  root: string;
  mode: 'read_write' | 'read_only' | 'restricted';
  readable: boolean;
  create_delete: boolean;
  tools: { powershell: boolean; pwsh: boolean; git: boolean };
  office: {
    files_present: number;
    lock_files: string[];
    mutation_mode: 'versioned_copy' | 'read_only';
  };
  issues: Array<{ code: string; message: string }>;
}

export function isOfficeBinaryPath(value: string): boolean {
  return OFFICE_EXTENSIONS.has(path.extname(String(value || '').trim()).toLowerCase());
}

export function normalizeWindowsPermissionError(error: unknown): { code: string; message: string } | null {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
  if (/sharing violation|used by another process|being used by another process|file.*locked/i.test(raw)) {
    return { code: 'OFFICE_FILE_LOCKED', message: '파일이 Excel 또는 PowerPoint에서 열려 있어 잠겨 있습니다. 원본을 닫거나 새 버전 파일로 저장하세요.' };
  }
  if (/controlled folder access/i.test(raw)) {
    return { code: 'CONTROLLED_FOLDER_ACCESS', message: 'Windows 제어된 폴더 액세스가 쓰기를 차단했습니다. 허용된 작업 폴더를 선택하세요.' };
  }
  if (/\b(?:EACCES|EPERM)\b|access is denied|unauthorizedaccess|permission denied/i.test(raw)) {
    return { code: 'PERMISSION_DENIED', message: '현재 Windows 사용자에게 이 경로의 쓰기 권한이 없습니다. 사용자 소유 작업 폴더를 선택하세요.' };
  }
  return null;
}

function commandAvailable(name: string): boolean {
  if (process.platform !== 'win32') return spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
  return spawnSync('where.exe', [name], { stdio: 'ignore', windowsHide: true }).status === 0;
}

export function probeWorkspaceCapabilities(root: string): WorkspaceCapabilities {
  const absolute = path.resolve(root);
  const issues: WorkspaceCapabilities['issues'] = [];
  let names: string[] = [];
  let readable = false;
  try {
    names = readdirSync(absolute);
    readable = true;
  } catch (error) {
    const normalized = normalizeWindowsPermissionError(error);
    issues.push(normalized ?? { code: 'WORKSPACE_UNREADABLE', message: error instanceof Error ? error.message : String(error) });
  }

  let createDelete = false;
  if (readable) {
    const probe = path.join(absolute, `.cqr-pa-permission-probe-${process.pid}-${Date.now()}.tmp`);
    try {
      const fd = openSync(probe, 'wx');
      closeSync(fd);
      unlinkSync(probe);
      createDelete = true;
    } catch (error) {
      try { unlinkSync(probe); } catch { /* best effort cleanup */ }
      const normalized = normalizeWindowsPermissionError(error);
      issues.push(normalized ?? { code: 'WORKSPACE_READ_ONLY', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const officeFiles = names.filter(isOfficeBinaryPath);
  const lockFiles = names.filter((name) => name.startsWith('~$') && isOfficeBinaryPath(name)).slice(0, 10);
  if (lockFiles.length) {
    issues.push({ code: 'OFFICE_FILE_LOCKED', message: `${lockFiles.length}개의 Office 잠금 파일이 감지되었습니다.` });
  }
  return {
    root: absolute,
    mode: !readable ? 'restricted' : createDelete ? 'read_write' : 'read_only',
    readable,
    create_delete: createDelete,
    tools: {
      powershell: commandAvailable('powershell.exe'),
      pwsh: commandAvailable('pwsh.exe'),
      git: commandAvailable('git.exe'),
    },
    office: {
      files_present: officeFiles.length,
      lock_files: lockFiles,
      mutation_mode: createDelete ? 'versioned_copy' : 'read_only',
    },
    issues,
  };
}
