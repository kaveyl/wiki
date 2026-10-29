// Password policy (AD-030, changed by AD-048 to NIST SP 800-63B-4): one definition for the server check and
// the live checklist in the UI. Length plus a check against well-known and easily guessed passwords – no
// composition rules; an upper limit only against abuse (NIST allows one of at least 64). Only applied when a
// password is set, never at login.

export const PASSWORD_MIN = 15;
/** Generous for passphrases; longer input is refused before any other work. */
export const PASSWORD_MAX = 256;

/** What a password must not be built from: the own e-mail address, user name, display name … */
export type PasswordContext = readonly (string | null | undefined)[];

export interface PasswordRule {
  id: 'length' | 'maxLength' | 'guessable';
  label: string;
  ok: (pw: string, context?: PasswordContext) => boolean;
  /** Listed in the checklist only while it is not met. */
  onlyWhenMissed?: boolean;
}

/**
 * Built-in list (no network): base words of passwords that top the published lists of common and leaked
 * passwords, German ones included. Own compilation (no third-party file). Compared after folding case,
 * dropping digits/symbols around the word, undoing look-alikes (p@ssw0rt) and repetitions – so
 * „Passwort2026!!!!“ or „iloveyouiloveyou“ count as well.
 */
const COMMON = new Set(
  `password passwort passwörter kennwort geheim geheimnis secret topsecret meinpasswort mypassword admin administrator
  root user benutzer login welcome willkommen hallo hello letmein iloveyou ichliebedich liebe love lovely qwerty qwertz
  azerty asdf test tester testing master dragon monkey shadow sunshine princess prinzessin football fussball fußball
  baseball soccer superman batman spiderman starwars pokemon charlie michael jennifer jordan hunter killer trustno
  freedom whatever computer internet schatz schatzi hase hasi mausi maus baby sommer winter frühling fruehling herbst
  summer flower blume bayern schalke borussia dortmund deutschland germany berlin hamburg münchen muenchen kaveyl kaveylwiki wiki
  changeme default guest gast access zugang sicher sicherheit privat private abc`.split(/\s+/),
);

/** Runs along the alphabet and the keyboard (German and English layout); also read backwards. */
const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertzuiopü', 'asdfghjklöä', 'yxcvbnm', 'qwertyuiop', 'asdfghjkl',
  'zxcvbnm', 'qaywsxedcrfvtgbzhnujmikolp', 'qazwsxedcrfvtgbyhnujmikolp', '1q2w3e4r5t6z7u8i9o0p', '1q2w3e4r5t6y7u8i9o0p',
  '!"§$%&/()=?', '!@#$%^&*()_+',
].flatMap((s) => [[...s], [...s].reverse()]);

const LOOK_ALIKE: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '€': 'e' };

/** Longer passwords skip the run analysis (cost grows with the length; 128 characters are never „guessable“ by runs). */
const RUN_LIMIT = 128;

const fold = (s: string) => s.normalize('NFKC').toLowerCase();
const lettersOf = (s: string) => s.replace(/[^\p{L}]/gu, '');
const coreOf = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
const isLetter = (ch: string) => /\p{L}/u.test(ch);

/** Without the non-letters at both ends – a loop, as the regex for it backtracks quadratically on long input. */
function trimNonLetters(s: string): string {
  const c = [...s];
  let a = 0;
  let b = c.length;
  while (a < b && !isLetter(c[a]!)) a++;
  while (b > a && !isLetter(c[b - 1]!)) b--;
  return c.slice(a, b).join('');
}

/** Counted in characters; cheap for huge input (a character is at most two UTF-16 units). */
export const passwordTooLong = (pw: string) => pw.length > PASSWORD_MAX && (pw.length > 2 * PASSWORD_MAX || [...pw].length > PASSWORD_MAX);

/** „abcabcabc“ → „abc“: the shortest unit the text repeats (prefix function, linear). */
function unrepeat(s: string): string {
  const c = [...s];
  const pi = new Array<number>(c.length).fill(0);
  for (let i = 1; i < c.length; i++) {
    let k = pi[i - 1]!;
    while (k > 0 && c[i] !== c[k]) k = pi[k - 1]!;
    if (c[i] === c[k]) k++;
    pi[i] = k;
  }
  const period = c.length - (pi[c.length - 1] ?? 0);
  return period > 0 && c.length % period === 0 ? c.slice(0, period).join('') : s;
}

/** Characters left over when `s` is read as runs of at least 3 (one character repeated, or along a sequence). */
function leftover(s: string): number {
  const c = [...s];
  let rest = 0;
  for (let i = 0; i < c.length; ) {
    let best = 1;
    while (i + best < c.length && c[i + best] === c[i]) best++;
    for (const seq of SEQUENCES) {
      for (let p = seq.indexOf(c[i]!); p >= 0; p = seq.indexOf(c[i]!, p + 1)) {
        let n = 1;
        while (i + n < c.length && seq[p + n] === c[i + n]) n++;
        if (n > best) best = n;
      }
    }
    if (best >= 3) i += best;
    else {
      rest++;
      i++;
    }
  }
  return rest;
}

/** Words of the context to compare with: whole values, the part before „@“, and their pieces. */
function contextWords(context: PasswordContext): { emails: string[]; words: Set<string> } {
  const emails: string[] = [];
  const words = new Set<string>();
  for (const raw of context) {
    const v = fold(raw ?? '').trim();
    if (!v) continue;
    if (v.includes('@') && v.length >= 5) emails.push(v);
    const name = v.split('@')[0]!;
    for (const w of [name, ...name.split(/[^\p{L}\p{N}]+/u)]) {
      for (const x of [lettersOf(w), coreOf(w)]) if ([...x].length >= 3) words.add(x);
    }
  }
  return { emails, words };
}

/**
 * True for passwords that are easy to guess despite their length: on the built-in list, made of few
 * different characters, only runs (12345…, qwertz…), the own e-mail address, or only the own name with
 * digits and symbols around it.
 */
export function guessablePassword(pw: string, context: PasswordContext = []): boolean {
  const n = fold(pw);
  const chars = [...n];
  if (new Set(chars).size <= 3) return true;
  const { emails, words } = contextWords(context);
  if (emails.some((e) => n.includes(e))) return true;
  const trimmed = trimNonLetters(n);
  const unleet = lettersOf(trimmed.replace(/[0134578@$!€]/g, (ch) => LOOK_ALIKE[ch] ?? ch));
  for (const cand of [lettersOf(n), unleet, coreOf(n)]) {
    if (!cand) continue;
    const base = unrepeat(cand);
    if (COMMON.has(base) || words.has(base)) return true;
  }
  if (chars.length <= RUN_LIMIT) {
    const symbols = n.replace(/[\p{L}\p{N}\s]/gu, '');
    const symbolsOnlyRuns = [...symbols].length <= 4 || new Set(symbols).size <= 2 || leftover(symbols) <= 2;
    if (leftover(coreOf(n)) <= 2 && symbolsOnlyRuns) return true;
  }
  return false;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { id: 'length', label: `mindestens ${PASSWORD_MIN} Zeichen`, ok: (pw) => [...pw].length >= PASSWORD_MIN },
  { id: 'maxLength', label: `höchstens ${PASSWORD_MAX} Zeichen`, ok: (pw) => !passwordTooLong(pw), onlyWhenMissed: true },
  {
    id: 'guessable',
    label: 'nicht leicht zu erraten (z. B. kein bekanntes Passwort, keine Folge wie 123456 oder qwertz, nicht die eigene E-Mail-Adresse)',
    ok: (pw, context) => !guessablePassword(pw, context),
  },
];

/** The rules a password misses (empty = acceptable). */
export function passwordProblems(pw: string, context?: PasswordContext): PasswordRule[] {
  // Too long says it all; the other checks would only cost time.
  if (passwordTooLong(pw)) return PASSWORD_RULES.filter((r) => r.id === 'maxLength');
  return PASSWORD_RULES.filter((r) => !r.ok(pw, context));
}

/** One sentence for error messages, e.g. „Passwort zu schwach – nicht erfüllt: mindestens 15 Zeichen“. */
export function passwordError(pw: string, context?: PasswordContext): string | null {
  const missing = passwordProblems(pw, context);
  if (!missing.length) return null;
  if (missing[0]!.id === 'maxLength') return `Passwort zu lang – ${missing[0]!.label}`;
  return `Passwort zu schwach – nicht erfüllt: ${missing.map((r) => r.label).join(', ')}`;
}
