import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { initializeTheme, reloadThemePreference } from './lib/theme';
import { hydrateDurableUiState } from './lib/durableUiState';

initializeTheme();
// Restore pins / active chat / preferences from data/ before the first render: the
// localStorage cache is per-origin and is empty when the local API port changed.
void hydrateDurableUiState().finally(() => {
  reloadThemePreference();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
