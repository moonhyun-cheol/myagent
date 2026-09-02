import { useEffect } from 'react';
import { MainWorkspaceContainer } from './components/MainWorkspaceContainer';
import { NotificationCenter } from './components/NotificationCenter';

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

  return (
    <>
      <MainWorkspaceContainer />
      <NotificationCenter />
    </>
  );
}
