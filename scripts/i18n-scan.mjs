// Finds German texts in the web interface that are not passed through t()/tn() yet (AD-046) – a working aid,
// heuristic: string literals and JSX text with umlauts or common German words.
// Usage: node scripts/i18n-scan.mjs [path …]   (default: apps/web/src) — prints file:line and a count per file.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP = [/\/i18n\//, /\.test\.tsx?$/, /editor\/Emoji\.tsx$/, /editor\/lucide-all\.ts$/];
const GERMAN =
  /[äöüÄÖÜß„“]|\b(der|die|das|den|dem|und|oder|nicht|ist|sind|wird|werden|mit|für|von|zum|zur|ein|eine|einen|kein|keine|noch|schon|bitte|Notiz|Notizen|Quelle|Quellen|Ordner|Datei|Dateien|Einstellungen|Speichern|Abbrechen|Schließen|Öffnen|Neu|Neue|Neuer|Hinzufügen|Entfernen|Bearbeiten|Umbenennen|Verschieben|Kopieren|Einfügen|Suchen|Fehler|Wiederherstellen|Anmelden|Abmelden|Benutzer|Gruppe|Rechte|Verbindung|Sicherung|Prüfen|Jetzt|Alle|Keine|Weiter|Zurück|Fertig|Hilfe|Seite|Ansicht|Vorlage|Papierkorb|Version|Versionen)\b/;
const STR = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

function files(p) {
  if (statSync(p).isDirectory()) return readdirSync(p).flatMap((n) => files(join(p, n)));
  return /\.tsx?$/.test(p) && !SKIP.some((r) => r.test(p)) ? [p] : [];
}

/** Blanks comments and the texts already inside t()/tn(), keeping line numbers. */
function prepare(src) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, (m, p) => p + blank(m.slice(p.length)))
    .replace(/(^|[^:'"`])\/\/.*$/gm, (m, p) => p + blank(m.slice(p.length)))
    .replace(/\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, (m) => blank(m))
    .replace(/\btn\([^,]+,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, (m) => blank(m));
}

const lineOf = (src, i) => src.slice(0, i).split('\n').length;
let total = 0;
const perFile = [];
for (const f of (process.argv.slice(2).length ? process.argv.slice(2) : ['apps/web/src']).flatMap((p) => files(resolve(ROOT, p)))) {
  const src = prepare(readFileSync(f, 'utf8'));
  const hits = [];
  for (const m of src.matchAll(STR)) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    // Import paths, class names, test ids and keys are no interface texts.
    if (!GERMAN.test(text) || /^[@./]/.test(text) || /^[\w-]+(\s[\w:/[\]().%#-]+)*$/.test(text) && !/[äöüÄÖÜß]/.test(text) && !/\s/.test(text)) continue;
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    if (/(import|from|className=|data-[\w-]+=|key=)\s*\(?\s*$/.test(before)) continue;
    hits.push([lineOf(src, m.index), text]);
  }
  for (const m of src.matchAll(/>([^<>{}]*[A-Za-zÄÖÜäöüß][^<>{}]*)</g)) {
    const text = m[1].trim();
    if (text && GERMAN.test(text) && !/=>|[;=]\s*$/.test(text)) hits.push([lineOf(src, m.index), text]);
  }
  if (!hits.length) continue;
  total += hits.length;
  perFile.push([relative(ROOT, f), hits.length]);
  for (const [line, text] of hits.sort((a, b) => a[0] - b[0])) console.log(`${relative(ROOT, f)}:${line}: ${text.slice(0, 100)}`);
}
console.log(`\n${total} Funde in ${perFile.length} Dateien`);
for (const [f, n] of perFile.sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(n).padStart(4)}  ${f}`);
