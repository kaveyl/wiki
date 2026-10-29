// First-run setup with the one-time code (AD-043): only with the code from the log/file,
// throttled after wrong tries, file gone afterwards; never in the event log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../app.js';
import { loadConfig } from '../config.js';
import { setupCodeFile, setupCodeMatches } from './setupCode.js';

let root: string;
let app: App;
let printed = '';

const setup = (code?: string) =>
  app.server.inject({ method: 'POST', url: '/api/setup', payload: { email: 'admin@example.test', password: 'Sehr-geheim-Passwort-123', code } });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kaveyl-wiki-setupcode-'));
  printed = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((printed += String(chunk)), true));
  const config = { ...loadConfig({}), dataPath: join(root, 'data'), configPath: join(root, 'config'), localRoots: [], syncIntervalSec: 0, webRoot: join(root, 'no-web') };
  app = await buildApp(config, { logger: false, nightlyFsck: false, requireSetupCode: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('setup code', () => {
  it('is printed, stored with 600 and required by /api/setup', async () => {
    const file = setupCodeFile(join(root, 'config'));
    const code = readFileSync(file, 'utf8').trim();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(printed).toContain(code);
    expect((await app.server.inject({ method: 'GET', url: '/api/session' })).json()).toMatchObject({ setupRequired: true, setupCode: true });

    expect((await setup()).statusCode).toBe(403);
    expect((await setup('AAAA-BBBB-CCCC')).statusCode).toBe(403);
    const ok = await setup(code.toLowerCase().replace(/-/g, ' '));
    expect(ok.statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect((await app.server.inject({ method: 'GET', url: '/api/session' })).json()).toMatchObject({ setupRequired: false, setupCode: false });

    const cookie = `kw_session=${ok.cookies.find((c) => c.name === 'kw_session')!.value}`;
    const log = (await app.server.inject({ method: 'GET', url: '/api/activity?limit=50', headers: { cookie } })).body;
    expect(log).toContain('falscher Einrichtungscode');
    expect(log).not.toContain(code);
  });

  it('stops guessing after five wrong codes a minute', async () => {
    for (let i = 0; i < 5; i++) expect((await setup('XXXX-XXXX-XXXX')).statusCode).toBe(403);
    const code = readFileSync(setupCodeFile(join(root, 'config')), 'utf8').trim();
    expect((await setup(code)).statusCode).toBe(429);
  });

  it('compares case- and dash-insensitive, rejects non-strings', () => {
    expect(setupCodeMatches('ABCD-EFGH-JKMN', 'abcd efgh jkmn')).toBe(true);
    expect(setupCodeMatches('ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMP')).toBe(false);
    expect(setupCodeMatches('ABCD-EFGH-JKMN', undefined)).toBe(false);
  });
});
