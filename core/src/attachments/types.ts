export interface AttachmentRecord {
  id: string;
  session_id: string;
  original_name: string;
  stored_path: string;
  mime: string;
  size_bytes: number;
  created_at: string;
}

const EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.msg': 'application/vnd.ms-outlook',
  '.eml': 'message/rfc822',
  '.epub': 'application/epub+zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.php': 'application/x-php',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.cc': 'text/x-c',
  '.cpp': 'text/x-c',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c',
  '.cs': 'text/x-csharp',
  '.sql': 'application/sql',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.zsh': 'application/x-sh',
  '.ps1': 'text/plain',
  '.bat': 'application/x-bat',
  '.cmd': 'application/x-bat',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.log': 'text/plain',
  '.vue': 'text/plain',
  '.svelte': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

/** @deprecated All extensions are allowed; kept for compatibility. */
export const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_MIME));

export function mimeFromFilename(name: string): string {
  const base = name.trim().toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return 'text/plain';

  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';

  const ext = name.slice(dot).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 180);
}
