/** Inject attachment / workspace context into the user turn so models actually use it. */
export function wrapUserMessageWithContext(userMessage: string, context: string | undefined): string {
  const ctx = context?.trim();
  if (!ctx) return userMessage;
  const mediaHint = /영상 첨부|이미지 첨부|키프레임|vision으로 전달/i.test(ctx)
    ? [
        '첨부로 이미 영상/이미지(또는 키프레임)가 전달되었습니다.',
        '파일·URL을 다시 요청하지 말고, 아래 첨부 메모와 vision 이미지를 근거로 바로 분석하세요.',
        '',
      ]
    : [];
  return [
    '--- 제공된 프로젝트·첨부 정보 (이미 전달됨) ---',
    '아래 작업 폴더 구조·파일 내용과 첨부 내용을 바로 사용하세요.',
    'tree 명령 실행, README/파일 수동 붙여넣기, "폴더에 접근할 수 없다"는 안내는 하지 마세요.',
    '',
    ...mediaHint,
    ctx,
    '',
    '--- 질문 ---',
    userMessage,
  ].join('\n');
}

export function workspaceSystemInstruction(): string {
  return [
    '사용자가 MY Agent에서 작업 폴더를 지정했습니다. 작업 폴더는 채팅·리포 맥락 루트이며, 그 안 파일만 다루라는 뜻이 아닙니다.',
    '질문에 답할 때 제공된 디렉터리 구조와 파일 내용을 근거로 설명·수정하세요.',
    '절대경로·UNC(\\\\nas\\...)는 직접 list_directory/read_file로 열람하세요. NAS에 쓰려면 사용자 consent가 필요합니다.',
    '이미 제공된 파일 내용을 바로 사용하고, 없는 정보만 짧게 확인하세요.',
    '"폴더에 접근할 수 없다"거나 NAS 파일을 작업 폴더로 복사·업로드하라고 요구하지 마세요.',
    '파일 수정이 필요하면 도구(write_file, edit_file)로 반영하세요 (상대경로=맥락 루트, 절대/UNC=직접).',
  ].join('\n');
}

/** 일반 채팅 기본 응답 언어 */
export function defaultChatSystemInstruction(): string {
  return [
    '기본적으로 한국어로 답변하세요.',
    '사용자가 영어로만 질문한 경우에만 영어로 답할 수 있습니다.',
    '사용자가 한국어로 질문했는데 중국어(简体/繁體) 설명·리뷰·제안을 쓰지 마세요.',
    '코드 식별자·원문 주석·도메인 글자(예: 麻雀 패 이름 萬筒索)는 파일 그대로 두고, 해설은 한국어로 하세요.',
  ].join(' ');
}
