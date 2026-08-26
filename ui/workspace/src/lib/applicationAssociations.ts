import { runWorkspaceTerminal } from '../api/myAgentClient';

const STORAGE_KEY = 'my-agent.file-associations.v1';
const LEGACY_STORAGE_KEY = 'cqr.file-associations.v1';

export interface FileAssociationSettings {
  textEditor: string;
  imageEditor: string;
}

export const DEFAULT_FILE_ASSOCIATIONS: FileAssociationSettings = {
  textEditor: '',
  imageEditor: '',
};

export function loadFileAssociations(): FileAssociationSettings {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    const legacy = current === null ? localStorage.getItem(LEGACY_STORAGE_KEY) : null;
    if (legacy !== null) localStorage.setItem(STORAGE_KEY, legacy);
    const saved = JSON.parse(current ?? legacy ?? '{}') as Partial<FileAssociationSettings>;
    return {
      textEditor: typeof saved.textEditor === 'string' ? saved.textEditor : DEFAULT_FILE_ASSOCIATIONS.textEditor,
      imageEditor: typeof saved.imageEditor === 'string' ? saved.imageEditor : DEFAULT_FILE_ASSOCIATIONS.imageEditor,
    };
  } catch {
    return { ...DEFAULT_FILE_ASSOCIATIONS };
  }
}

export function saveFileAssociations(settings: FileAssociationSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent('my-agent:file-associations-changed'));
}

function psQuote(value: string): string {
  if (/\r|\n/.test(value)) throw new Error('경로에는 줄바꿈을 사용할 수 없습니다.');
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 추천 앱처럼 실행 파일명만 저장된 경우 PATH뿐 아니라 Windows App Paths도 조회한다.
 * Notepad++ 등은 일반 설치 시 PATH에 등록되지 않는 경우가 많다.
 */
function resolveConfiguredAppCommand(configuredApp: string): string {
  const quotedApp = psQuote(configuredApp);
  return [
    `$configuredApp = ${quotedApp}`,
    '$resolvedApp = $null',
    "if ([IO.Path]::IsPathRooted($configuredApp) -or $configuredApp.Contains('\\') -or $configuredApp.Contains('/')) {",
    "  if (Test-Path -LiteralPath $configuredApp -PathType Leaf) { $resolvedApp = (Resolve-Path -LiteralPath $configuredApp).Path }",
    '} else {',
    '  $appCommand = Get-Command -Name $configuredApp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
    '  if ($appCommand) { $resolvedApp = $appCommand.Source }',
    '  if (-not $resolvedApp) {',
    '    $appPathRoots = @(',
    "      'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',",
    "      'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',",
    "      'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths'",
    '    )',
    '    foreach ($root in $appPathRoots) {',
    '      $key = Join-Path $root $configuredApp',
    '      if (Test-Path -LiteralPath $key) {',
    "        $candidate = (Get-Item -LiteralPath $key).GetValue('')",
    '        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $resolvedApp = $candidate; break }',
    '      }',
    '    }',
    '  }',
    '  if (-not $resolvedApp) {',
    "    $configuredLeaf = [IO.Path]::GetFileName($configuredApp)",
    '    $startApp = Get-StartApps -ErrorAction SilentlyContinue | Where-Object {',
    "      $_.AppID -and ([IO.Path]::GetFileName([string]$_.AppID) -ieq $configuredLeaf)",
    '    } | Select-Object -First 1',
    '    if ($startApp -and (Test-Path -LiteralPath $startApp.AppID -PathType Leaf)) {',
    '      $resolvedApp = $startApp.AppID',
    '    }',
    '  }',
    '}',
    "if (-not $resolvedApp) { throw (\"설정된 연결 프로그램을 찾을 수 없습니다: {0}. 설정에서 찾아보기로 실행 파일을 지정하세요.\" -f $configuredApp) }",
  ].join('; ');
}

export async function resolveApplicationExecutable(configuredApp: string): Promise<string> {
  const value = configuredApp.trim();
  if (!value) return '';

  const command = `${resolveConfiguredAppCommand(value)}; Write-Output $resolvedApp`;
  const result = await runWorkspaceTerminal(command, { async: false, timeoutMs: 15_000 });
  if (!result.ok || result.exit_code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || '연결 프로그램을 찾지 못했습니다.');
  }

  const resolved = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!resolved || !/^[a-z]:[\\/]/i.test(resolved)) {
    throw new Error('연결 프로그램의 절대 경로를 확인하지 못했습니다.');
  }
  return resolved;
}

function isImagePath(path: string): boolean {
  return /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i.test(path);
}

function isTextPath(path: string): boolean {
  return /\.(?:bat|c|cc|cfg|conf|cpp|cs|css|csv|cts|env|gitattributes|gitignore|go|h|hpp|htm|html|ini|java|js|json|jsonc|jsx|log|lua|md|mdx|mjs|mts|php|properties|ps1|py|rb|rs|scss|sh|sql|svelte|toml|ts|tsx|txt|vue|xml|ya?ml)$/i.test(path);
}

/** 파일 형식에 맞는 사용자 설정 앱을 반환한다. 미분류 형식은 Windows 기본 연결을 사용한다. */
function configuredAppForPath(path: string, settings: FileAssociationSettings): string {
  if (isImagePath(path)) return settings.imageEditor.trim();
  if (isTextPath(path)) return settings.textEditor.trim();
  return '';
}

/** 워크스페이스 경계를 유지하면서 선택 파일을 설정된 Windows 앱으로 연다. */
export async function openWorkspaceFileWithConfiguredApp(
  relPath: string,
  fallbackRelPath?: string,
): Promise<void> {
  const settings = loadFileAssociations();
  const configuredApp = configuredAppForPath(relPath, settings);
  const candidates = [relPath, fallbackRelPath].filter((path): path is string => Boolean(path));
  const candidateList = candidates.map(psQuote).join(', ');
  const resolvedFile = `@(${candidateList}) | ForEach-Object { Resolve-Path -LiteralPath $_ -ErrorAction SilentlyContinue } | Select-Object -First 1 -ExpandProperty Path`;
  const command = configuredApp
    ? `$file = ${resolvedFile}; if (-not $file) { throw '작업 파일을 찾을 수 없습니다.' }; $resolvedApp = ${psQuote(configuredApp)}; if (-not ([IO.Path]::IsPathRooted($resolvedApp)) -or -not (Test-Path -LiteralPath $resolvedApp -PathType Leaf)) { throw '저장된 연결 프로그램 경로가 유효하지 않습니다. 설정에서 다시 지정하세요.' }; Start-Process -FilePath $resolvedApp -ArgumentList @(('"' + $file + '"')) -ErrorAction Stop`
    : `$file = ${resolvedFile}; if (-not $file) { throw '작업 파일을 찾을 수 없습니다.' }; Start-Process -FilePath 'explorer.exe' -ArgumentList @(('"' + $file + '"')) -ErrorAction Stop`;
  const result = await runWorkspaceTerminal(command, { async: false, timeoutMs: 15_000 });
  if (!result.ok || result.exit_code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || '연결 프로그램을 실행하지 못했습니다.');
  }
}
