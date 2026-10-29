// One-time code for the first-run setup (AD-043): without it, whoever opens a fresh instance
// first would become administrator. The code goes to stdout (docker logs) and to
// <config>/setup-code (600); it never reaches the event log. A new one on every start
// without accounts; the file is removed once the administrator exists.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// No 0/O, 1/I/L: the code is read from a log and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const setupCodeFile = (configPath: string) => join(configPath, 'setup-code');

export function createSetupCode(configPath: string): string {
  const groups = Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''));
  const code = groups.join('-');
  const file = setupCodeFile(configPath);
  rmSync(file, { force: true });
  writeFileSync(file, `${code}\n`, { mode: 0o600 });
  return code;
}

export function removeSetupCode(configPath: string) {
  rmSync(setupCodeFile(configPath), { force: true });
}

/** Case, spaces and dashes do not matter; compared in constant time. */
export function setupCodeMatches(expected: string, given: unknown): boolean {
  const norm = (s: string) => createHash('sha256').update(s.toUpperCase().replace(/[\s-]/g, '')).digest();
  return typeof given === 'string' && timingSafeEqual(norm(expected), norm(given));
}

/** Plain lines instead of a JSON log entry, so the code stands out in `docker logs`. */
export function announceSetupCode(code: string) {
  process.stdout.write(
    [
      '',
      '==================================================================',
      `  Kaveyl Wiki: Einrichtungscode  ${code}`,
      '  Auf der Einrichtungsseite eingeben – gilt bis zur Ersteinrichtung.',
      '==================================================================',
      '',
    ].join('\n') + '\n',
  );
}
