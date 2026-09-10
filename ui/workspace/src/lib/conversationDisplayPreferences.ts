import { useSyncExternalStore } from 'react';

/**
 * PC-local conversation display preferences (token usage / time info).
 * Stored in localStorage; both default OFF so the existing chat layout is unchanged.
 */
export interface ConversationDisplayPreferences {
  showTokens: boolean;
  showTime: boolean;
}

const STORAGE_KEY = 'my-agent.conversation-display';
const CHANGE_EVENT = 'my-agent:conversation-display-changed';

const DEFAULT_PREFERENCES: ConversationDisplayPreferences = {
  showTokens: false,
  showTime: false,
};

let cached: ConversationDisplayPreferences | null = null;

function read(): ConversationDisplayPreferences {
  if (cached) return cached;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ConversationDisplayPreferences>;
      cached = {
        showTokens: Boolean(parsed.showTokens),
        showTime: Boolean(parsed.showTime),
      };
      return cached;
    }
  } catch {
    /* ignore malformed local settings */
  }
  cached = { ...DEFAULT_PREFERENCES };
  return cached;
}

export function getConversationDisplayPreferences(): ConversationDisplayPreferences {
  return read();
}

export function setConversationDisplayPreference(
  key: keyof ConversationDisplayPreferences,
  value: boolean,
): void {
  const next = { ...read(), [key]: value };
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — keep in-memory value */
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

function subscribe(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

/** React hook: live conversation display preferences reflected across open views. */
export function useConversationDisplayPreferences(): ConversationDisplayPreferences {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_PREFERENCES);
}
