const PATH_TRAILING_PROSE_RE =
  /\s+(?:먼저|이\s|그\s|저\s|봐|확인|레거시|양식|주소|파일들?|폴더|루트|쪽|관련|엑셀|시트|컬럼)/;

function trimPathProse(raw: string): string {
  let value = raw.trim();
  const cut = value.search(PATH_TRAILING_PROSE_RE);
  if (cut > 0) value = value.slice(0, cut);
  return value.replace(/[.,;:!?。]+$/u, '').trim();
}

/** Extract explicit UNC and Windows drive paths without inferring task intent. */
export function extractUncOrDrivePaths(message: string): string[] {
  const text = String(message || '');
  const found: string[] = [];
  const uncRe = /\\\\[^\\/:*?"<>|\r\n]+(?:\\[^\\/:*?"<>|\r\n]+)+/g;
  const driveRe = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g;
  for (const expression of [uncRe, driveRe]) {
    for (const match of text.matchAll(expression)) {
      const value = trimPathProse(match[0]);
      if (value && !found.includes(value)) found.push(value);
    }
  }
  return found;
}
