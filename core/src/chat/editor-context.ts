import type { EditorContext } from '../router/types.js';

function isSyntheticBuffer(p: string): boolean {
  return /^buffer\.(tsx|ts|jsx|js)$/i.test(p);
}

/** UI active file / selection / error / @ chips → 프롬프트 조각 */
export function buildEditorContextSnippet(editor?: EditorContext | null): string {
  if (!editor) return '';
  const path = editor.path?.trim() || '';
  const extraPaths = (Array.isArray(editor.paths) ? editor.paths : [])
    .map((p) => String(p || '').replace(/\\/g, '/').trim())
    .filter((p) => p && !isSyntheticBuffer(p));
  // Synthetic buffer name from UI — not a real workspace file; omit to avoid invented edit tasks.
  const primaryOk = path && !isSyntheticBuffer(path);
  if (!primaryOk && !extraPaths.length) return '';

  const lines = [
    '[에디터 참고 — 선택 사항]',
  ];
  if (primaryOk) {
    lines.push(`사용자가 에디터에서 열어 둔 파일: ${path}`);
  }
  if (extraPaths.length) {
    const uniq = [...new Set(extraPaths)].slice(0, 24);
    lines.push(`@ 컨텍스트 경로 (${uniq.length}):`);
    for (const p of uniq) lines.push(`- ${p}`);
  }
  lines.push(
    '이 스니펫은 참고용이다. 사용자 메시지가 설명·보고·개요를 요청하면 파일 수정을 발명하지 말고 질문에 답한다.',
    '수정 요청이 명시된 경우에만 열어 둔/@ 파일을 편집 대상으로 삼는다.',
  );

  const selection = editor.selection?.trim();
  if (selection && primaryOk) {
    const clipped =
      selection.length > 2_000 ? `${selection.slice(0, 2_000)}\n… (selection truncated)` : selection;
    lines.push(`[선택/미리보기 영역]:`, '```', clipped, '```');
  }

  const err = editor.error_snippet?.trim();
  if (err) lines.push(`[발생한 에러/로그]: ${err}`);

  return lines.join('\n');
}
