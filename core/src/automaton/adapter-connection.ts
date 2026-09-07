import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveOrganizationModuleRoot } from '../skills/organization-module-root.js';
import { resolveFeatureAdapterConnectionPath } from '../features/organization-feature-loader.js';

export interface AdapterConnectionDoc {
  version?: number;
  base_url?: string;
  transport?: {
    request_path?: string;
    status_path_template?: string;
    poll_interval_ms?: number;
    timeout_ms?: number;
  };
  authentication?: {
    mode?: string;
    bootstrap_path?: string;
    bootstrap_key?: string;
    credential_store?: string;
    allow_legacy_vault_token?: boolean;
  };
  progress?: {
    mode?: string;
    states?: string[];
    accepted_text?: string;
    running_text?: string;
    completed_text?: string;
    failed_text?: string;
    edit_existing_message_when_supported?: boolean;
    append_status_when_edit_unsupported?: boolean;
  };
}

const DEFAULT_CONNECTION: Required<Pick<AdapterConnectionDoc, 'transport' | 'authentication' | 'progress'>> = {
  transport: {
    request_path: '/cqr/adapter/request',
    status_path_template: '/cqr/adapter/jobs/{job_id}',
    poll_interval_ms: 2500,
    timeout_ms: 1_800_000,
  },
  authentication: {
    mode: 'install_bootstrap',
    bootstrap_path: '/cqr/adapter/auth/bootstrap',
    credential_store: 'client_vault',
    allow_legacy_vault_token: true,
  },
  progress: {
    mode: 'poll',
    states: ['queued', 'running', 'completed', 'failed'],
    accepted_text: '명령어 접수',
    running_text: '진행 중',
    completed_text: '완료',
    failed_text: '실패',
    edit_existing_message_when_supported: true,
    append_status_when_edit_unsupported: true,
  },
};

function readModuleJson(dir: string): { adapter_connection_file?: string; openclaw_adapter_base_url?: string } {
  const p = path.join(dir, 'module.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as {
      adapter_connection_file?: string;
      openclaw_adapter_base_url?: string;
    };
  } catch {
    return {};
  }
}

function resolveLegacyAdapterConnectionPath(cqrRoot: string): string | null {
  const orgRoot = resolveOrganizationModuleRoot(cqrRoot);
  if (!orgRoot) return null;
  const moduleJson = readModuleJson(orgRoot);
  const fileName = (moduleJson.adapter_connection_file || 'adapter-connection.json').trim()
    || 'adapter-connection.json';
  const candidates = [
    path.join(orgRoot, fileName),
    path.join(orgRoot, 'adapter-connection.json'),
    path.join(orgRoot, 'adapter-connection.template.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveAdapterConnectionPath(cqrRoot: string): string | null {
  return resolveFeatureAdapterConnectionPath(cqrRoot) ?? resolveLegacyAdapterConnectionPath(cqrRoot);
}

export function loadAdapterConnection(cqrRoot?: string): AdapterConnectionDoc | null {
  const root = cqrRoot?.trim() || process.env.MY_AGENT_ROOT?.trim() || '';
  if (!root) return null;
  const filePath = resolveAdapterConnectionPath(root);
  if (!filePath) return null;
  try {
    const doc = JSON.parse(readFileSync(filePath, 'utf8')) as AdapterConnectionDoc;
    const moduleJson = readModuleJson(path.dirname(filePath));
    const baseUrl = (
      doc.base_url?.trim()
      || moduleJson.openclaw_adapter_base_url?.trim()
      || ''
    ).replace(/\/+$/, '');
    return {
      ...doc,
      base_url: baseUrl || undefined,
      transport: { ...DEFAULT_CONNECTION.transport, ...doc.transport },
      authentication: { ...DEFAULT_CONNECTION.authentication, ...doc.authentication },
      progress: { ...DEFAULT_CONNECTION.progress, ...doc.progress },
    };
  } catch {
    return null;
  }
}

export function buildAdapterStatusUrl(
  baseUrl: string,
  jobId: string,
  statusPathTemplate = '/cqr/adapter/jobs/{job_id}',
): string {
  const root = baseUrl.replace(/\/+$/, '');
  const pathPart = statusPathTemplate.split('{job_id}').join(encodeURIComponent(jobId));
  if (pathPart.startsWith('http://') || pathPart.startsWith('https://')) return pathPart;
  return `${root}${pathPart.startsWith('/') ? '' : '/'}${pathPart}`;
}

export function formatAdapterProgressMessage(
  connection: AdapterConnectionDoc | null | undefined,
  opts: {
    commandText: string;
    status: string;
    stageMessage?: string;
    errorMessage?: string;
    resultPath?: string;
    deliveryStatus?: string;
  },
): string {
  const progress = connection?.progress ?? DEFAULT_CONNECTION.progress;
  const status = opts.status.trim().toLowerCase();
  const label =
    status === 'queued' ? (progress.accepted_text || '명령어 접수')
      : status === 'running' ? (progress.running_text || '진행 중')
        : status === 'completed' ? (progress.completed_text || '완료')
          : status === 'failed' || status === 'denied' || status === 'error'
            ? (progress.failed_text || '실패')
            : (progress.running_text || '진행 중');
  const lines = [
    `접수: \`${opts.commandText.trim() || '(명령)'}\``,
    '',
    `상태: **${label}**`,
  ];
  if (opts.stageMessage?.trim() && opts.stageMessage.trim() !== label) {
    lines.push(opts.stageMessage.trim());
  } else if (status === 'queued') {
    lines.push('중앙 허브에서 백그라운드로 실행합니다.');
    lines.push('완료 알림과 결과 파일 경로는 Adapter가 사용 가능한 전달 경로로 보냅니다.');
  } else if (status === 'running') {
    lines.push(opts.stageMessage?.trim() || '중앙 허브에서 실행 중입니다.');
  }
  if (opts.resultPath?.trim()) {
    lines.push(`결과: \`${opts.resultPath.trim()}\``);
  }
  if (opts.deliveryStatus?.trim()) {
    lines.push(`전달: ${opts.deliveryStatus.trim()}`);
  }
  if (opts.errorMessage?.trim()) {
    lines.push(opts.errorMessage.trim());
  }
  return lines.join('\n');
}

export function getDefaultAdapterConnection(): AdapterConnectionDoc {
  return {
    version: 1,
    transport: { ...DEFAULT_CONNECTION.transport },
    authentication: { ...DEFAULT_CONNECTION.authentication },
    progress: { ...DEFAULT_CONNECTION.progress },
  };
}
