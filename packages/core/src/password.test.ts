import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX, PASSWORD_MIN, guessablePassword, passwordError, passwordProblems } from './password.js';

const ids = (pw: string, context?: string[]) => passwordProblems(pw, context).map((r) => r.id);

describe('password policy (NIST SP 800-63B-4, AD-048)', () => {
  it('needs 15 characters (Unicode characters count), no composition rules', () => {
    expect(PASSWORD_MIN).toBe(15);
    expect(ids('Sehr-geheim-Passwort-123')).toEqual([]);
    expect(ids('heftklammer pferd')).toEqual([]);
    expect(ids('ärger über öl im')).toEqual([]);
    expect(ids('hornissenkaffee')).toEqual([]);
    expect(ids('hornissenkaffe')).toEqual(['length']);
    // 15 characters, but more UTF-16 units: counted as characters.
    expect(ids('🐝🐝-Bienenhaus-1')).toEqual([]);
    expect(ids('Bär-Fuchs-Öl-1')).toEqual(['length']);
    expect(ids(`${'Wörter und Sätze '.repeat(15)}`)).toEqual([]);
  });

  it('test passwords used across the suites stay valid', () => {
    for (const pw of ['Start-Passwort-0001', 'E2E-Passwort-12345', 'Neues-Passwort-0002', 'Maria-Start-0001!', 'Ärger-über-Öl-2026']) expect(ids(pw), pw).toEqual([]);
    expect(ids('Maria-Passwort-0001', ['maria@example.test', 'maria', 'Maria M.'])).toEqual([]);
    expect(ids('Noras-Passwort-2026', ['nora@example.test', 'nora', 'Nora Neu'])).toEqual([]);
  });

  it('refuses well-known passwords, also with digits, symbols or look-alike characters around them', () => {
    for (const pw of ['passwortpasswort', 'Passwort12345678', 'P@ssw0rt-2026!!!', 'iloveyou12345678', 'Willkommen2026!!', 'kaveyl-wiki-kaveyl-wiki-1', 'Fußball2026Fußball']) {
      expect(guessablePassword(pw), pw).toBe(true);
      expect(ids(pw), pw).toEqual(['guessable']);
    }
  });

  it('refuses repetitions and sequences along the alphabet or keyboard', () => {
    for (const pw of ['aaaaaaaaaaaaaaa', 'ababababababababab', '123456789012345', '987654321098765', 'qwertzuiopasdfg', 'abcdefghijklmnop', 'asdf-ghjk-lqwe-rtz', '!@#$%^&*()_+!@#', 'aaaaa11111bbbbb']) {
      expect(guessablePassword(pw), pw).toBe(true);
    }
    // Short runs inside an otherwise free choice are fine.
    expect(guessablePassword('abc-Hornisse-Kaffee')).toBe(false);
  });

  it('refuses the own e-mail address and passwords built only from the own name', () => {
    const me = ['maria.muster@example.test', 'maria.muster', 'Maria Muster'];
    expect(guessablePassword('maria.muster@example.test', me)).toBe(true);
    expect(guessablePassword('xx-maria.muster@example.test', me)).toBe(true);
    expect(guessablePassword('MariaMuster2026!!', me)).toBe(true);
    expect(guessablePassword('Muster-1234-Muster', me)).toBe(true);
    // Without that context the same text is not on any list.
    expect(guessablePassword('MariaMuster2026!!')).toBe(false);
    // The name inside a longer, free passphrase is fine.
    expect(guessablePassword('Maria liest gern Krimis', me)).toBe(false);
  });

  it('allows up to 256 characters and refuses longer ones quickly', () => {
    expect(PASSWORD_MAX).toBe(256);
    expect(ids(`Lange-Passphrase ${'x'.repeat(PASSWORD_MAX - 17)}`)).toEqual([]);
    expect(ids(`${'🐝'.repeat(PASSWORD_MAX - 1)}-a`)).toEqual(['maxLength']);
    // Long runs of non-letters around a letter must not take quadratic time.
    for (const pw of [`abc${'1234567890'.repeat(10_000)}d`, `${'1'.repeat(100_000)}a${'2'.repeat(100_000)}`]) {
      const start = performance.now();
      expect(passwordError(pw, ['user@example.test', 'user', 'User'])).toBe('Passwort zu lang – höchstens 256 Zeichen');
      guessablePassword(pw, ['user@example.test', 'user', 'User']);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  it('an empty password is not acceptable', () => {
    expect(ids('')).toEqual(['length', 'guessable']);
  });

  it('explains what is not met in one sentence', () => {
    expect(passwordError('Sehr-geheim-Passwort-123')).toBeNull();
    expect(passwordError('kurz')).toBe('Passwort zu schwach – nicht erfüllt: mindestens 15 Zeichen');
    expect(passwordError('Passwort12345678')).toMatch(/^Passwort zu schwach – nicht erfüllt: nicht leicht zu erraten/);
    expect(passwordError('aaaa')).toMatch(/^Passwort zu schwach – nicht erfüllt: mindestens 15 Zeichen, nicht leicht zu erraten/);
  });
});
