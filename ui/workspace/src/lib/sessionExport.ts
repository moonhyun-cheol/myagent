import { fetchSession } from '../api/myAgentClient';

/** Download one conversation as a portable `.cqr-session.json` file (re-importable from the sidebar). */
export async function exportPortableSession(sessionId: string): Promise<void> {
  const session = await fetchSession(sessionId);
  const payload = {
    format: 'cqr-pa-conversation-session',
    version: 1,
    exported_at: new Date().toISOString(),
    conversation: {
      id: session.id,
      title: session.title,
      created_at: session.created_at,
      updated_at: session.updated_at,
      // Sidebar ids are local to this PC; import places the chat where the user picks.
      messages: session.messages.map((message) => ({
        role: message.role,
        content: message.content,
        at: message.at,
        ...(message.model ? { model: message.model } : {}),
        ...(message.mode ? { mode: message.mode } : {}),
        ...(message.image_urls?.length ? { image_urls: message.image_urls } : {}),
        ...(message.reasoning?.content?.trim() ? { reasoning: message.reasoning } : {}),
        // 작업기록: tool rows + interleaved order. Local cancel bindings are PC-specific.
        ...(message.tool_activity?.length
          ? {
              tool_activity: message.tool_activity.map((row) => {
                const { cancelSessionId: _cancel, cancelRequested: _requested, ...rest } = row;
                return rest;
              }),
            }
          : {}),
        ...(message.work_timeline?.length ? { work_timeline: message.work_timeline } : {}),
      })),
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${(session.title || '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'conversation'}.cqr-session.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
