/** Strict patch / tool output format constraints — lean for every-turn base prompt. */
export function formatPatchFormatConstraints(): string {
  return [
    '## Format constraints (patch / tools)',
    '- Mutate via tools only. Prefer apply_patch (multi) / edit_file (single). old_text unique (≥2 context lines).',
    '- apply_patch atomic: all succeed or none. Fix hunks then resubmit full patch.',
    '- Patch text: *** Begin Patch / *** Update File: path / @@ / -old / +new / *** End Patch',
    '- Or files:[{path, edits:[{old_text,new_text}]}]. No fences in tool args.',
  ].join('\n');
}
