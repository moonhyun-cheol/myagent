export type ToolFailureClass =
  | 'validation'
  | 'not_found'
  | 'unknown_tool'
  | 'permission'
  | 'tool_error';

/** Consecutive recoverable-failure LLM corrections before forcing a user-facing answer. */
export const MAX_SELF_CORRECTION_STREAK = 3;

/** True when tool output already carries structured correction instructions. */
export function toolOutputAlreadyHasCorrection(output: string): boolean {
  return (
    output.includes('ERROR: tool_call_failed')
    || output.includes('Instructions for the model')
  );
}

export function classifyToolOutputFailure(output: string): ToolFailureClass | null {
  const text = output.trim();
  if (!text) return null;

  if (text.includes('Unknown tool:')) return 'unknown_tool';
  if (text.startsWith('ERROR: invalid tool arguments')) return 'validation';
  if (text.includes('BARE_MODULE_READ')) return 'validation';
  if (
    text.includes('missing required')
    || text.includes('requires non-empty')
    || text.includes('check required fields')
  ) {
    return 'validation';
  }
  if (
    text.includes('not found')
    || text.includes('ENOENT')
    || text.includes('no such file')
  ) {
    return 'not_found';
  }
  if (
    text.includes('permission denied')
    || text.includes('EACCES')
    || text.includes('EPERM')
    || /access is denied|unauthorizedaccess|sharing violation|OFFICE_FILE_LOCKED/i.test(text)
    || text.includes('forbidden')
  ) {
    return 'permission';
  }
  if (text.startsWith('ERROR:')) return 'tool_error';
  if (/"ok"\s*:\s*false/i.test(text) || /old_text not found/i.test(text)) return 'tool_error';
  return null;
}

function hintForClass(errorClass: ToolFailureClass, toolRequested: string, writeFailStreak: number, detail = ''): string {
  if (detail.includes('BARE_MODULE_READ')) {
    return 'Do NOT retry read_file on npm package ids. Read package.json or a real src/** path once, then mutate.';
  }
  if (toolRequested === 'edit_file') {
    return 'edit_file old_text did not match. Do NOT retry edit_file on this path. Call write_file with the complete file body (or apply_patch with fresh exact context).';
  }
  if (
    (toolRequested === 'write_file' || toolRequested === 'apply_patch')
    && writeFailStreak >= 2
  ) {
    return 'write_file/apply_patch failed repeatedly — switch to edit_file with small unique hunks; do not resubmit one giant write.';
  }
  switch (errorClass) {
    case 'unknown_tool':
      return 'Pick the closest name from allowed_tools only (read → read_file, write → write_file).';
    case 'validation':
      return 'Re-call with all required parameters filled.';
    case 'not_found':
      return 'Verify path with list_directory or search_files first, then retry with a corrected path.';
    case 'permission':
      return 'Use an absolute/UNC path if the user pointed outside the workspace, or ask for NAS write consent when writing to NAS.';
    case 'tool_error':
      return 'Read the detail, fix arguments or tool choice, then retry; change strategy if the same error repeats.';
    default:
      return 'Fix the tool call and retry; change strategy if the same error repeats.';
  }
}

/** Structured tool failure for model self-correction (prompt D). */
export function formatToolSelfCorrection(
  toolRequested: string,
  detail: string,
  allowedTools: string[],
  opts?: { writeFailStreak?: number },
): string {
  const errorClass = classifyToolOutputFailure(detail) ?? 'tool_error';
  const writeFailStreak = opts?.writeFailStreak ?? 0;
  return [
    'ERROR: tool_call_failed',
    `tool_requested: ${toolRequested}`,
    `error_class: ${errorClass}`,
    `detail: ${detail.replace(/\n/g, ' ').trim()}`,
    `allowed_tools: ${allowedTools.join(', ')}`,
    '',
    'Instructions for the model (do not show to user):',
    `- The previous tool call failed. Diagnose using error_class and detail.`,
    `- ${hintForClass(errorClass, toolRequested, writeFailStreak, detail)}`,
    '- Do not repeat the exact same args. After a few failed corrections, explain to the user in Korean.',
    '- User-facing status should stay 「해결 중…」 — do not dump raw tool errors to the user while retrying.',
  ].join('\n');
}

export function isRecoverableToolFailure(output: string): boolean {
  // Soft exploration re-hit: run continues with mutate instructions — not a failure streak.
  if (/TOOL_LOOP_GUARD/i.test(output) && /,\s*success\)/i.test(output)) return false;
  if (/ALREADY_SEARCHED/i.test(output)) return false;
  // Bare npm package reads: one correction is enough; don't burn the full streak.
  if (/BARE_MODULE_READ/i.test(output)) return false;
  return classifyToolOutputFailure(output) !== null;
}

/** Soft guidance when retrieval returned zero hits (not a hard ERROR). */
export function formatEmptyRetrievalHint(
  toolName: string,
  query: string,
  pathHints: string[] = [],
): string {
  const paths = pathHints.filter(Boolean).slice(0, 4);
  const readLines = paths.length
    ? paths.map((p) => `- Call read_file on "${p}" before concluding.`)
    : [
        '- Extract file paths from the user message (e.g. tools.ts) and call read_file.',
        '- Or retry query_repo_map with a shorter token (filename / symbol only).',
      ];
  return [
    'Instructions for the model (do not show to user):',
    `- ${toolName} returned 0 hits for query=${JSON.stringify(query)}.`,
    '- Do NOT tell the user the check failed solely because the map was empty.',
    '- Empty retrieval ≠ file missing. Fall back:',
    ...readLines,
    '- Prefer search_files with a short filename token if the path is still unknown.',
  ].join('\n');
}
