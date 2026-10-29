import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { loadLanguage, t } from './i18n';
import { reloadingOnce } from './loading';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

// The app's modules translate texts as they load: the dictionary first, then the app (seo-003). Nothing imported
// above may translate while loading (i18n/moduleLevel.test.ts).
const root = createRoot(document.getElementById('root')!);
void reloadingOnce('kaveyl-wiki-app-reload', loadLanguage().then(() => import('./App'))).then(
  ({ App, PartBoundary }) =>
    root.render(
      <StrictMode>
        <PartBoundary>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </PartBoundary>
      </StrictMode>,
    ),
  // Not even the app loads (twice in a row): a plain message, the app's own parts are not there.
  () =>
    root.render(
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-sm text-fg-muted">
        <p>{t('Dieser Teil der App konnte nicht geladen werden. Bitte die Seite neu laden.')}</p>
        <button type="button" className="h-7 rounded-md bg-accent px-2 text-xs font-medium text-accent-fg hover:opacity-90" onClick={() => location.reload()}>
          {t('Neu laden')}
        </button>
      </div>
    ),
);

// Installable app with an offline shell (Phase 7). Browsers allow service workers only on
// https:// or localhost — over plain http in the LAN Kaveyl Wiki simply runs without one.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}

