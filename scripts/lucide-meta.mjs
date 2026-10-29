// Generates apps/web/src/editor/lucide-meta.json (categories + search tags of all Lucide icons)
// from the Lucide source repository — npm packages do not ship the categories.
// Usage, matching the installed lucide-react version:
//   curl -sSfL -o lucide.tgz https://codeload.github.com/lucide-icons/lucide/tar.gz/refs/tags/<version>
//   tar xzf lucide.tgz && node scripts/lucide-meta.mjs lucide-<version>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { icons } from 'lucide-react';

const src = process.argv[2];
if (!src) throw new Error('Pfad zum entpackten Lucide-Repository angeben');

// German titles, in this order in the picker.
const TITLES = {
  files: 'Dateien', text: 'Text', development: 'Entwicklung', layout: 'Layout', design: 'Design', communication: 'Kommunikation', mail: 'Mail',
  notifications: 'Hinweise', time: 'Zeit & Kalender', account: 'Konten & Zugang', security: 'Sicherheit', people: 'Personen', social: 'Soziales',
  finance: 'Finanzen', shopping: 'Einkaufen', charts: 'Diagramme', math: 'Mathematik', science: 'Wissenschaft', medical: 'Medizin', devices: 'Geräte',
  connectivity: 'Verbindung', multimedia: 'Multimedia', photography: 'Fotografie', tools: 'Werkzeuge', home: 'Zuhause', buildings: 'Gebäude',
  navigation: 'Orte & Navigation', travel: 'Reisen', transportation: 'Verkehr', nature: 'Natur', animals: 'Tiere', weather: 'Wetter', seasons: 'Jahreszeiten',
  sustainability: 'Nachhaltigkeit', 'food-beverage': 'Essen & Trinken', sports: 'Sport', gaming: 'Spiele', emoji: 'Gesichter', shapes: 'Formen',
  arrows: 'Pfeile', cursors: 'Zeiger', accessibility: 'Barrierefreiheit',
};

const pascal = (name) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const categories = readdirSync(join(src, 'categories')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const missing = categories.filter((c) => !TITLES[c]);
if (missing.length) throw new Error(`Titel fehlen für: ${missing.join(', ')}`);
const order = Object.keys(TITLES).filter((c) => categories.includes(c));

const out = { categories: order.map((id) => ({ id, title: TITLES[id] })), icons: {} };
let skipped = 0;
for (const f of readdirSync(join(src, 'icons')).filter((f) => f.endsWith('.json')).sort()) {
  const name = f.slice(0, -5);
  // Only icons the installed lucide-react actually has.
  if (!icons[pascal(name)]) {
    skipped++;
    continue;
  }
  const meta = JSON.parse(readFileSync(join(src, 'icons', f), 'utf8'));
  const cats = (meta.categories ?? []).map((c) => order.indexOf(c)).filter((i) => i >= 0);
  // A few tags are enough for the search; keeps the file small.
  out.icons[name] = [cats, (meta.tags ?? []).slice(0, 6).join(' ')];
}
const target = resolve(import.meta.dirname, '../apps/web/src/editor/lucide-meta.json');
writeFileSync(target, JSON.stringify(out) + '\n');
console.log(`${Object.keys(out.icons).length} Icons, ${order.length} Kategorien → ${target}${skipped ? ` (${skipped} nicht in lucide-react)` : ''}`);
