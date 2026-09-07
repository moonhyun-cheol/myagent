import { useEffect } from 'react';
import { MainWorkspaceContainer } from './components/MainWorkspaceContainer';
import { NotificationCenter } from './components/NotificationCenter';
import { useWorkspaceStore } from './store/workspaceStore';

function reportWorkspaceBusy(busy: boolean): void {
  void fetch('/system/ui-busy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_busy: busy }),
  }).catch(() => {});
}

export default function App() {
  useEffect(() => {
    const blockNativeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    // Keep application-defined context-menu handlers working while suppressing
    // the browser/WebView menu everywhere else.
    document.addEventListener('contextmenu', blockNativeContextMenu, true);
    return () => document.removeEventListener('contextmenu', blockNativeContextMenu, true);
  }, []);

  useEffect(() => {
    reportWorkspaceBusy(useWorkspaceStore.getState().busy);
    const unsub = useWorkspaceStore.subscribe((state, prev) => {
      if (state.busy === prev.busy) return;
      reportWorkspaceBusy(state.busy);
    });
    const clearBusy = () => reportWorkspaceBusy(false);
    window.addEventListener('pagehide', clearBusy);
    return () => {
      unsub();
      window.removeEventListener('pagehide', clearBusy);
      reportWorkspaceBusy(false);
    };
  }, []);

  return (
    <>
      <MainWorkspaceContainer />
      <NotificationCenter />
    </>
  );
}
