import { ProfileLibrary } from './components/ProfileLibrary';
import { ConfirmModal } from './components/ConfirmModal';

function postToHost(message: unknown) {
  const webview = (window as unknown as { chrome?: { webview?: { postMessage: (m: unknown) => void } } })
    .chrome?.webview;
  webview?.postMessage(message);
}

export default function App() {
  const launchMyAgent = () => {
    postToHost({ type: 'launcher.launchMyAgent' });
  };

  return (
    <>
      <div className="min-h-screen bg-ink px-4 py-6 sm:px-8">
        <ProfileLibrary onLaunchMyAgent={launchMyAgent} />
      </div>
      <ConfirmModal />
    </>
  );
}
