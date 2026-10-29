// End-to-end tests against the built app (server bundle + web dist).
// Seeds a fresh workspace under .local/e2e on every run (main process only).
import { defineConfig } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
export const E2E_DIR = resolve(ROOT, '.local/e2e');
const PORT = 18093;

if (!process.env.TEST_WORKER_INDEX) {
  rmSync(E2E_DIR, { recursive: true, force: true });
  const notes: Record<string, string> = {
    'projekte/notizen/index.md': '# Notizen\n\nStartseite des lokalen Ordners.\n',
    'projekte/notizen/trilium.md': '---\ntitle: Trilium Ideen\ntags: pkm, wiki\n---\n\n# Ignoriert\n\n* Stern-Liste bleibt\n* unverändert\n\nErster Absatz über Hierarchien.\n',
    'projekte/notizen/plan/roadmap.md': '# Roadmap\n\nSiehe [Trilium](../trilium.md) und [Wiki.js-Stil](/plan/details).\n',
    'projekte/notizen/plan/details.md': '# Details\n\nDetailseite.\n',
    'projekte/notizen/src/code.ts': 'export {}\n',
    'projekte/archiv/README.md': '# Archiv\n',
    'projekte/archiv/alt/index.md': '# Alt\n',
    'projekte/notizen/handbuch.md': '# Handbuch\n\n## Einleitung\n\n' + 'Text. '.repeat(400) + '\n\n## Installation\n\n' + 'Schritt. '.repeat(400) + '\n\n### Docker\n\nCompose.\n\n## Betrieb\n\nLäuft.\n',
    'projekte/notizen/stand.md': '---\nsession_status: "idle"\n---\n\n# Stand\n\n> Zitat\n> zweite Zeile\n\n- [x] erledigt\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- endet mit Liste\n',
  };
  for (const [p, c] of Object.entries(notes)) {
    mkdirSync(dirname(join(E2E_DIR, p)), { recursive: true });
    writeFileSync(join(E2E_DIR, p), c);
  }
  mkdirSync(join(E2E_DIR, 'backup'));
}

export default defineConfig({
  testDir: '.',
  // The live suite (e2e/live) runs only via `npm run livetest` with explicit confirmation.
  testIgnore: ['live/**'],
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1360, height: 860 },
    // The interface follows the browser language (AD-046); the suite checks German texts. English: e2e/i18n.spec.ts.
    locale: 'de-DE',
    screenshot: 'only-on-failure',
  },
  outputDir: resolve(ROOT, '.local/e2e-results'),
  webServer: {
    command: 'node apps/server/dist/server.mjs',
    cwd: ROOT,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    stdout: 'ignore',
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_PATH: join(E2E_DIR, 'data'),
      CONFIG_PATH: join(E2E_DIR, 'config'),
      LOCAL_ROOTS: join(E2E_DIR, 'projekte'),
      WEB_ROOT: join(ROOT, 'apps/web/dist'),
      COMMIT_IDLE_OVERRIDE_SEC: '1',
      SYNC_INTERVAL_SEC: '0',
      LOG_LEVEL: 'warn',
      // Shown in Einstellungen → Hilfe (manual picture 92): look like a release, not „dev“.
      KAVEYL_WIKI_VERSION: `${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version} (1a2b3c4)`,
      // Notifications (AD-035): Pushover goes to a closed local port, never to the real service.
      PUSHOVER_API_URL: 'http://127.0.0.1:47819/1/messages.json',
      // Update hint (AD-062): a local port instead of GitHub; phase9-help-cleanup answers there with fake releases.
      KAVEYL_WIKI_UPDATE_URL: 'http://127.0.0.1:47820/repos/kaveyl/wiki/releases/latest',
      // Backups (AD-038): local targets below .local/e2e/backup; SMB through the Samba test container.
      BACKUP_ROOT: join(E2E_DIR, 'backup'),
      SMBCLIENT: join(ROOT, 'e2e/smb/smbclient'),
    },
  },
});
