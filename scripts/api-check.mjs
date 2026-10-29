// REST API v1 check against a running instance (AD-023), as a script sees it: every route with good and bad input,
// rights, errors, and every answer compared with the published OpenAPI description (status documented, fields of
// the documented type). Creates temporary tokens through the admin's session (never printed, revoked at the end) and
// writes only into a folder „api-check-<time>“ of ONE source, which it deletes again (trash) and syncs. A second
// writable source, if there is one, only receives a note for a moment (moved there and back).
//
// Usage:  set -a; source <env file with KAVEYL_WIKI_ADMIN_MAIL and KAVEYL_WIKI_PASSWORD>; set +a
//         API_CHECK_CONFIRM="<exact source name>" node scripts/api-check.mjs
// Env:    KAVEYL_WIKI_URL, KAVEYL_WIKI_ADMIN_MAIL, KAVEYL_WIKI_PASSWORD; API_CHECK_CONFIRM = name of the source to write into.
// Exit code 1 when a check fails.

const BASE = (process.env.KAVEYL_WIKI_URL ?? '').replace(/\/$/, '');
const CONFIRM = process.env.API_CHECK_CONFIRM;
if (!BASE || !process.env.KAVEYL_WIKI_ADMIN_MAIL || !process.env.KAVEYL_WIKI_PASSWORD || !CONFIRM) {
  console.error('KAVEYL_WIKI_URL, KAVEYL_WIKI_ADMIN_MAIL, KAVEYL_WIKI_PASSWORD und API_CHECK_CONFIRM="<Name der Quelle>" setzen.');
  process.exit(2);
}

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ' — ' + String(info).replace(/\s+/g, ' ').slice(0, 200) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── session and tokens
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.KAVEYL_WIKI_ADMIN_MAIL, password: process.env.KAVEYL_WIKI_PASSWORD }),
});
if (!login.ok) {
  console.error(`Anmeldung fehlgeschlagen (${login.status})`);
  process.exit(2);
}
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const session = (method, path, body) =>
  fetch(`${BASE}${path}`, { method, headers: { cookie, 'content-type': 'application/json', 'accept-language': 'de' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const created = [];
async function token(scopes) {
  const r = await session('POST', '/api/tokens', { name: `api-check ${scopes.join('+')} (temporär)`, scopes, expiresDays: 1 });
  created.push(r.info.id);
  return r.token;
}

// ── the published description and a small validator for its schemas
const spec = await (await fetch(`${BASE}/api/v1/openapi.json`)).json();
const resolve = (s) => (s?.$ref ? spec.components.schemas[s.$ref.split('/').pop()] : s);
/** Problems of `value` against `schema` (types, enums, items, properties), as short texts. */
function validate(schema, value, at = '') {
  const s = resolve(schema);
  if (!s) return [];
  const types = s.type ? [s.type].flat() : null;
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (s.enum && !s.enum.includes(value)) return [`${at || '.'}: ${JSON.stringify(value)} nicht in ${s.enum.join('|')}`];
  if (types && !types.includes(kind) && !(kind === 'integer' && types.includes('number'))) return [`${at || '.'}: ${kind} statt ${types.join('|')}`];
  const out = [];
  if (kind === 'array' && s.items) value.slice(0, 50).forEach((v, i) => out.push(...validate(s.items, v, `${at}[${i}]`)));
  if (kind === 'object' && s.properties) {
    for (const [k, sub] of Object.entries(s.properties)) if (k in value && value[k] !== undefined) out.push(...validate(sub, value[k], `${at}.${k}`));
    for (const k of s.required ?? []) if (!(k in value)) out.push(`${at}.${k} fehlt`);
  }
  return out;
}
const specPaths = Object.entries(spec.paths).map(([p, ops]) => ({
  re: new RegExp('^' + p.replace(/\{path\}/g, '.*').replace(/\{[^}]+\}/g, '[^/]+') + '$'),
  p,
  ops,
}));
const undocumented = new Set();
/** Status and body follow the description; failures are {"error": "…"}. */
function conforms(method, url, status, body) {
  const path = decodeURI(url.split('?')[0].replace(/^\/api\/v1/, ''));
  const entry = specPaths.find((e) => e.re.test(path) && e.ops[method.toLowerCase()]);
  if (!entry) return [`${method} ${path} nicht beschrieben`];
  const op = entry.ops[method.toLowerCase()];
  const res = op.responses[status] ?? null;
  const problems = [];
  if (!res) undocumented.add(`${method} ${entry.p} → ${status}`);
  if (status >= 400 && (typeof body?.error !== 'string' || !body.error)) problems.push(`Fehler ohne {"error"}: ${JSON.stringify(body).slice(0, 80)}`);
  const schema = res?.content?.['application/json']?.schema;
  if (schema && status < 400) problems.push(...validate(schema, body));
  return problems;
}

/** One API call; every answer is checked against the description on the way. */
const shape = [];
async function api(tok, method, path, body, extra = {}) {
  const url = `/api/v1${path}`;
  const res = await fetch(`${BASE}${url}`, {
    method,
    // German unless a check asks otherwise: the checks compare German messages; without the header the server answers in English.
    headers: { 'accept-language': 'de', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  for (const p of conforms(method, url, res.status, data)) shape.push(`${method} ${path.split('?')[0]} (${res.status}): ${p}`);
  return { status: res.status, data, headers: res.headers };
}
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
async function until(fn, ok, tries = 30) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await fn();
    if (ok(v)) return v;
    await sleep(500);
  }
  return v;
}

const rw = await token(['read', 'write']);
const ro = await token(['read']);
const mcpOnly = await token(['mcp']);

let S;
let dir;
let other;
const uploaded = [];
try {
  // ── description and access
  check('openapi.json öffentlich, OpenAPI 3.1, Version 1', spec.openapi === '3.1.0' && spec.info?.version === '1' && spec.servers?.[0]?.url === '/api/v1');
  check('openapi.json beschreibt alle 16 Pfade, jede Operation mit 400/401/403/404', Object.keys(spec.paths).length === 16 && Object.values(spec.paths).every((ops) => Object.values(ops).every((op) => [400, 401, 403, 404].every((c) => op.responses[c]))), Object.keys(spec.paths).join(' '));
  check('ohne Token → 401 mit {"error"}', (await api(null, 'GET', '/sources')).status === 401);
  check('falscher Token → 401', (await api('kw_' + 'x'.repeat(40), 'GET', '/sources')).status === 401);
  check('kein Kaveyl-Wiki-Token (Basic) → 401', (await api(null, 'GET', '/sources', undefined, { authorization: 'Basic YTpi' })).status === 401);
  check('Token ohne „read“ (nur mcp) → 403', (await api(mcpOnly, 'GET', '/sources')).status === 403);
  const appRoute = await fetch(`${BASE}/api/mounts`, { headers: { authorization: `Bearer ${rw}` } });
  check('Token auf einer App-Route (/api/mounts) → 403, nur Browser-Anmeldung', appRoute.status === 403);

  // ── sources and status
  const sources = await api(rw, 'GET', '/sources');
  const src = (sources.data ?? []).find((s) => s.name === CONFIRM);
  check(`GET /sources (Ziel „${CONFIRM}“, Schreibrecht)`, src && ['write', 'admin'].includes(src.access), (sources.data ?? []).map((s) => `${s.name} [${s.type}, ${s.access}]`).join('; '));
  if (!src) throw new Error(`Quelle „${CONFIRM}“ nicht gefunden oder nicht sichtbar`);
  S = src.id;
  other = (sources.data ?? []).find((s) => s.id !== S && ['write', 'admin'].includes(s.access) && !s.readonly);
  check('Lese-Token: access = read', (await api(ro, 'GET', '/sources')).data.find((s) => s.id === S)?.access === 'read');
  const st = await api(rw, 'GET', '/status');
  check('GET /status: alle Quellen', Array.isArray(st.data) && st.data.length === sources.data.length && st.data.every((x) => typeof x.canSync === 'boolean'));
  check('GET /status?source=', (await api(rw, 'GET', `/status?source=${S}`)).data?.[0]?.id === S);
  check('GET /status unbekannte Quelle → 404', (await api(rw, 'GET', '/status?source=gibt-es-nicht')).status === 404);

  // ── tree and search
  const tree = await api(rw, 'GET', `/tree/${S}`);
  const anyNote = Array.isArray(tree.data) ? tree.data.find((e) => e.kind === 'file' && /\.md$/.test(e.path) && !e.path.startsWith('api-check-') && !e.path.startsWith('mcp-check-')) : null;
  check('GET /tree', Array.isArray(tree.data) && anyNote, `${tree.data?.length} Einträge`);
  const topDir = tree.data.find((e) => e.kind === 'dir');
  if (topDir) {
    const sub = await api(rw, 'GET', `/tree/${S}?path=${encodeURIComponent(topDir.path)}&depth=1`);
    check('GET /tree?path=&depth=1: nur direkt darunter', sub.status === 200 && sub.data.every((e) => e.path.startsWith(topDir.path + '/') && !e.path.slice(topDir.path.length + 1).includes('/')), topDir.path);
  }
  const shallow = await api(rw, 'GET', `/tree/${S}?depth=1`);
  check('GET /tree?depth=1: nur oberste Ebene', shallow.status === 200 && shallow.data.every((e) => !e.path.includes('/')));
  check('GET /tree unbekannte Quelle → 404', (await api(rw, 'GET', '/tree/gibt-es-nicht')).status === 404);
  check('GET /tree Pfad außerhalb → 400', (await api(rw, 'GET', `/tree/${S}?path=../..`)).status === 400);
  const word = anyNote.name.split(/[\s_-]+/).find((w) => w.length > 3) ?? anyNote.name;
  const hits = await api(rw, 'GET', `/search?q=${encodeURIComponent(word)}&limit=5`);
  check('GET /search mit limit', Array.isArray(hits.data) && hits.data.length > 0 && hits.data.length <= 5, `„${word}“ → ${hits.data?.length}`);
  check('GET /search?source=: nur diese Quelle', (await api(rw, 'GET', `/search?q=${encodeURIComponent(word)}&source=${S}`)).data.every((h) => h.sourceId === S));
  check('GET /search ohne q → leere Liste', (await api(rw, 'GET', '/search')).data?.length === 0);
  const before = await api(rw, 'GET', `/notes/${S}/${enc(anyNote.path)}`);
  check('GET /notes (vorhandene Notiz)', typeof before.data?.markdown === 'string' && before.data.hash, anyNote.path);

  // ── folders and notes
  dir = `api-check-${Date.now()}`;
  const f = await api(rw, 'POST', `/folders/${S}`, { parent: '', name: dir });
  check('POST /folders', f.status === 200 && f.data.path === dir && f.data.folderNote?.startsWith(`${dir}/`), JSON.stringify(f.data));
  const f2 = await api(rw, 'POST', `/folders/${S}`, { parent: dir, name: 'Ablage' });
  const f3 = await api(rw, 'POST', `/folders/${S}`, { parent: dir, name: 'Ablage' });
  check('POST /folders: gleicher Name → eindeutig', f2.data?.path === `${dir}/Ablage` && f3.data?.path === `${dir}/Ablage 2`, f3.data?.path);
  check('POST /folders ohne Namen → 400', (await api(rw, 'POST', `/folders/${S}`, { parent: dir, name: '' })).status === 400);
  check('POST /folders ohne Body → 400', (await api(rw, 'POST', `/folders/${S}`)).status === 400);
  check('POST /folders mit Lese-Token → 403', (await api(ro, 'POST', `/folders/${S}`, { parent: dir, name: 'nein' })).status === 403);
  const a = await api(rw, 'POST', `/notes/${S}`, { parent: `${dir}/Projekte`, title: 'Größe & Maß' });
  check('POST /notes (Umlaute, fehlender Ordner entsteht)', a.status === 200 && a.data.path === `${dir}/Projekte/Größe & Maß.md`, JSON.stringify(a.data));
  const a2 = await api(rw, 'POST', `/notes/${S}`, { parent: `${dir}/Projekte`, title: 'Größe & Maß' });
  check('POST /notes: gleicher Titel → eindeutiger Name, nichts überschrieben', a2.status === 200 && a2.data.path !== a.data.path, JSON.stringify(a2.data));
  // Events for agents: the starting point before the writes below.
  const c0 = await api(ro, 'GET', `/changes?source=${S}&path=${encodeURIComponent(dir)}`);
  const b = await api(rw, 'POST', `/notes/${S}`, { parent: dir, title: 'Quelle', markdown: `# Quelle\n\nSiehe [Größe](Projekte/Gr%C3%B6%C3%9Fe%20%26%20Ma%C3%9F.md).\n` });
  check('POST /notes mit Markdown und Link', b.status === 200, JSON.stringify(b.data));
  check('POST /notes ohne Titel → 400', (await api(rw, 'POST', `/notes/${S}`, { parent: dir, title: ' ' })).status === 400);
  check('POST /notes ohne Body → 400', (await api(rw, 'POST', `/notes/${S}`)).status === 400);
  check('POST /notes kaputtes JSON → 400', (await api(rw, 'POST', `/notes/${S}`, '{"title": ')).status === 400);
  check('POST /notes mit Lese-Token → 403', (await api(ro, 'POST', `/notes/${S}`, { parent: dir, title: 'nein' })).status === 403);
  check('POST /notes unbekannte Quelle → 404', (await api(rw, 'POST', '/notes/gibt-es-nicht', { parent: '', title: 'x' })).status === 404);

  // ── read and write
  const rb = await api(rw, 'GET', `/notes/${S}/${enc(b.data.path)}`);
  check('GET /notes: Inhalt, hash, access, name, title', rb.data?.markdown?.includes('Siehe [Größe]') && rb.data.hash && rb.data.access && rb.data.name === 'Quelle' && rb.data.encrypted === false);
  const w = await api(rw, 'PUT', `/notes/${S}/${enc(b.data.path)}`, { markdown: rb.data.markdown + '\nZweite Zeile per API.\n', baseHash: rb.data.hash });
  check('PUT /notes', w.status === 200 && w.data.changed === true && w.data.hash !== rb.data.hash);
  const same = await api(rw, 'PUT', `/notes/${S}/${enc(b.data.path)}`, { markdown: rb.data.markdown + '\nZweite Zeile per API.\n', baseHash: w.data.hash });
  check('PUT gleicher Inhalt → changed=false', same.status === 200 && same.data.changed === false);
  const stale = await api(rw, 'PUT', `/notes/${S}/${enc(b.data.path)}`, { markdown: 'weg', baseHash: rb.data.hash });
  check('PUT mit altem baseHash → 409 mit currentHash/currentRaw', stale.status === 409 && stale.data.currentHash === w.data.hash && stale.data.currentRaw?.includes('Zweite Zeile'));
  check('PUT ohne baseHash → 400', (await api(rw, 'PUT', `/notes/${S}/${enc(b.data.path)}`, { markdown: 'x' })).status === 400);
  check('PUT ohne Body → 400', (await api(rw, 'PUT', `/notes/${S}/${enc(b.data.path)}`)).status === 400);
  check('PUT markdown kein Text → 400', (await api(rw, 'PUT', `/notes/${S}/${enc(b.data.path)}`, { markdown: 42, baseHash: w.data.hash })).status === 400);
  check('PUT mit Lese-Token → 403', (await api(ro, 'PUT', `/notes/${S}/${enc(b.data.path)}`, { markdown: 'x', baseHash: w.data.hash })).status === 403);
  check('PUT auf neue Datei → 404 (Anlegen nur mit POST)', (await api(rw, 'PUT', `/notes/${S}/${dir}/neu.md`, { markdown: '# neu\n', baseHash: 'x' })).status === 404);
  check('GET unbekannte Notiz → 404', (await api(rw, 'GET', `/notes/${S}/${dir}/gibt-es-nicht.md`)).status === 404);
  check('GET Pfad außerhalb → 400', (await api(rw, 'GET', `/notes/${S}/..%2F..%2Fetc%2Fpasswd`)).status === 400);
  check('GET .git → 400', (await api(rw, 'GET', `/notes/${S}/.git/config`)).status === 400);
  const en = await api(rw, 'GET', `/notes/${S}/${dir}/gibt-es-nicht.md`, undefined, { 'accept-language': 'en' });
  check('Fehler auf Englisch (Accept-Language)', en.status === 404 && /^Not found/.test(en.data.error), en.data.error);
  const enOk = await api(rw, 'GET', `/notes/${S}/${enc(anyNote.path)}`, undefined, { 'accept-language': 'en' });
  check('Inhalt mit Accept-Language: en unverändert', enOk.data?.markdown === before.data.markdown);
  const none = await api(rw, 'GET', `/notes/${S}/${dir}/gibt-es-nicht.md`, undefined, { 'accept-language': '' });
  check('ohne Sprachangabe Englisch (Rückfallsprache)', none.status === 404 && /^Not found/.test(none.data.error), none.data.error);
  const sr = await until(() => api(rw, 'GET', `/search?q=${encodeURIComponent('"Zweite Zeile per API"')}&source=${S}`), (r) => r.data?.length > 0);
  check('GET /search findet frisch Geschriebenes (Phrase)', sr.data?.some?.((h) => h.path === b.data.path && h.snippet.includes('«')));
  check('GET /search path:', (await api(rw, 'GET', `/search?q=${encodeURIComponent(`Zeile path:${dir}/`)}`)).data?.every?.((h) => h.path.startsWith(`${dir}/`)));
  const bl = await until(() => api(rw, 'GET', `/backlinks/${S}/${enc(a.data.path)}`), (r) => r.data?.length > 0);
  check('GET /backlinks', bl.data?.some?.((x) => x.path === b.data.path), JSON.stringify(bl.data));
  check('GET /backlinks unbekannte Notiz → 404', (await api(rw, 'GET', `/backlinks/${S}/${dir}/gibt-es-nicht.md`)).status === 404);

  // ── files
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#5b8def"/></svg>';
  const up = await api(rw, 'POST', `/attachments/${S}`, { note: b.data.path, name: 'Plan Skizze.svg', contentText: SVG });
  check('POST /attachments (SVG als Text)', up.status === 200 && up.data.path === `${dir}/assets/Plan-Skizze.svg` && up.data.image === true && up.data.markdown === '![Plan-Skizze](assets/Plan-Skizze.svg)', JSON.stringify(up.data));
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up2 = await api(rw, 'POST', `/attachments/${S}`, { note: b.data.path, name: 'punkt.png', contentBase64: PNG });
  const up3 = await api(rw, 'POST', `/attachments/${S}`, { note: b.data.path, name: 'Werte.csv', contentText: 'a;b\n1;2\n' });
  uploaded.push(...[up, up2, up3].filter((u) => u.status === 200).map((u) => u.data.path));
  check('POST /attachments (PNG Base64, CSV Text)', up2.status === 200 && up2.data.size === 70 && up3.status === 200 && up3.data.image === false && up3.data.markdown === '[Werte.csv](assets/Werte.csv)', `${up3.data?.markdown}`);
  check('POST /attachments .exe → 400', (await api(rw, 'POST', `/attachments/${S}`, { note: b.data.path, name: 'x.exe', contentBase64: 'TVo=' })).status === 400);
  check('POST /attachments ohne Inhalt → 400', (await api(rw, 'POST', `/attachments/${S}`, { note: b.data.path, name: 'x.png' })).status === 400);
  check('POST /attachments unbekannte Notiz → 404', (await api(rw, 'POST', `/attachments/${S}`, { note: `${dir}/gibt-es-nicht.md`, name: 'x.svg', contentText: SVG })).status === 404);
  check('POST /attachments mit Lese-Token → 403', (await api(ro, 'POST', `/attachments/${S}`, { note: b.data.path, name: 'x.svg', contentText: SVG })).status === 403);
  const rbf = await api(rw, 'GET', `/notes/${S}/${enc(b.data.path)}`);
  await api(rw, 'PUT', `/notes/${S}/${enc(b.data.path)}`, { markdown: `${rbf.data.markdown}\n${up.data.markdown}\n\n${up2.data.markdown}\n\n${up3.data.markdown}\n\n![fehlt](assets/fehlt.png)\n`, baseHash: rbf.data.hash });
  const la = await api(rw, 'GET', `/attachments/${S}/${enc(b.data.path)}`);
  const kinds = (la.data ?? []).map?.((x) => `${x.name}:${x.kind}:${x.size === null ? 'null' : 'ok'}`).sort().join(' ');
  check('GET /attachments: Bilder, Datei, fehlende mit size null', kinds === 'Plan-Skizze.svg:image:ok Werte.csv:file:ok fehlt.png:image:null punkt.png:image:ok', kinds);
  const served = await fetch(`${BASE}/api/files/${S}/${enc(up.data.path)}`, { headers: { authorization: `Bearer ${ro}` } });
  check('Datei mit Lese-Token abrufbar, mit CSP sandbox', served.ok && (await served.text()) === SVG && /sandbox/.test(served.headers.get('content-security-policy') ?? ''), `${served.status}`);

  // ── move and copy
  const mv = await api(rw, 'POST', `/move/${S}`, { from: a.data.path, to: `${dir}/Projekte/Maße.md` });
  check('POST /move (umbenennen)', mv.status === 200 && mv.data.path === `${dir}/Projekte/Maße.md`, JSON.stringify(mv.data));
  const rb3 = await api(rw, 'GET', `/notes/${S}/${enc(b.data.path)}`);
  check('Link nach dem Verschieben repariert', /\]\(Projekte\/Ma%C3%9Fe\.md\)/.test(rb3.data.markdown), rb3.data.markdown.split('\n').find((l) => l.startsWith('Siehe')));
  check('POST /move auf vorhandenes Ziel → 409', (await api(rw, 'POST', `/move/${S}`, { from: mv.data.path, to: a2.data.path })).status === 409);
  check('POST /move unbekannte Quelle-Datei → 404', (await api(rw, 'POST', `/move/${S}`, { from: `${dir}/gibt-es-nicht.md`, to: `${dir}/x.md` })).status === 404);
  check('POST /move ohne Body → 400', (await api(rw, 'POST', `/move/${S}`)).status === 400);
  check('POST /move nach außerhalb → 400', (await api(rw, 'POST', `/move/${S}`, { from: mv.data.path, to: '../raus.md' })).status === 400);
  check('POST /move mit Lese-Token → 403', (await api(ro, 'POST', `/move/${S}`, { from: mv.data.path, to: `${dir}/x.md` })).status === 403);
  const mvf = await api(rw, 'POST', `/move/${S}`, { from: `${dir}/Ablage 2`, to: `${dir}/Archiv` });
  check('POST /move (Ordner)', mvf.status === 200 && mvf.data.path === `${dir}/Archiv`, JSON.stringify(mvf.data));
  const cp = await api(rw, 'POST', `/copy/${S}`, { from: mv.data.path, toParent: `${dir}/Projekte` });
  check('POST /copy (gleicher Ordner → „(Kopie)“)', cp.status === 200 && cp.data.path === `${dir}/Projekte/Maße (Kopie).md`, JSON.stringify(cp.data));
  const cp2 = await api(rw, 'POST', `/copy/${S}`, { from: mv.data.path, toParent: `${dir}/Archiv` });
  check('POST /copy (anderer Ordner)', cp2.status === 200 && cp2.data.path === `${dir}/Archiv/Maße.md`, JSON.stringify(cp2.data));
  check('POST /copy unbekannte Datei → 404', (await api(rw, 'POST', `/copy/${S}`, { from: `${dir}/gibt-es-nicht.md`, toParent: dir })).status === 404);
  check('POST /copy ohne Body → 400', (await api(rw, 'POST', `/copy/${S}`)).status === 400);
  check('POST /copy mit Lese-Token → 403', (await api(ro, 'POST', `/copy/${S}`, { from: mv.data.path, toParent: dir })).status === 403);

  // ── changes for agents: who changed what, own changes only on request, long polling
  check('GET /changes: Start liefert nur den Cursor', c0.status === 200 && typeof c0.data.cursor === 'string' && c0.data.changes.length === 0 && c0.data.reset === false, JSON.stringify(c0.data).slice(0, 160));
  const q = `/changes?source=${S}&path=${encodeURIComponent(dir)}&after=${encodeURIComponent(c0.data.cursor)}`;
  const notOwn = await api(ro, 'GET', q);
  const withOwn = await api(ro, 'GET', `${q}&own=true`);
  const copied = withOwn.data?.changes?.find((c) => c.path === cp.data.path);
  check('GET /changes: eigene Änderungen nur mit own=true (gleiches Konto)', notOwn.status === 200 && notOwn.data.changes.length === 0 && !!copied, `${notOwn.data?.changes?.length} / ${withOwn.data?.changes?.length}`);
  check('GET /changes: Kopie mit kind, by, byId, via=api', copied?.kind === 'created' && !!copied.by && !!copied.byId && copied.via === 'api', JSON.stringify(copied));
  const t0 = Date.now();
  const waited = await api(ro, 'GET', `/changes?source=${S}&path=${encodeURIComponent(dir)}&after=${encodeURIComponent(withOwn.data.cursor)}&wait=2`);
  check('GET /changes?wait=2 wartet und antwortet leer', waited.status === 200 && waited.data.changes.length === 0 && Date.now() - t0 >= 1800, `${Date.now() - t0} ms`);
  check('GET /changes unbekannte Quelle → 404', (await api(ro, 'GET', '/changes?source=gibt-es-nicht')).status === 404);
  check('GET /changes mit MCP-Token ohne „lesen“ → 403', (await api(mcpOnly, 'GET', '/changes')).status === 403);
  if (other) {
    const across = await api(rw, 'POST', `/move/${S}`, { from: cp.data.path, to: `${dir}/Maße.md`, toSourceId: other.id });
    check(`POST /move in „${other.name}“`, across.status === 200 && across.data.sourceId === other.id, JSON.stringify(across.data));
    if (across.status === 200) {
      const back = await api(rw, 'POST', `/copy/${other.id}`, { from: across.data.path, toParent: dir, toSourceId: S });
      check('… und als Kopie zurück', back.status === 200 && back.data.sourceId === S, JSON.stringify(back.data));
      const leftover = await api(rw, 'DELETE', `/notes/${other.id}/${enc(dir)}`);
      check(`Testordner in „${other.name}“ löschen`, leftover.status === 200, JSON.stringify(leftover.data));
    }
  }

  // ── sync, history, versions
  check('POST /sync mit Lese-Token → 403', (await api(ro, 'POST', `/sync/${S}`)).status === 403);
  check('POST /sync unbekannte Quelle → 404', (await api(rw, 'POST', '/sync/gibt-es-nicht')).status === 404);
  const sync = await api(rw, 'POST', `/sync/${S}`);
  check('POST /sync', sync.status === 200 && sync.data.status?.pendingEdits === 0, JSON.stringify(sync.data?.result ?? sync.data));
  const hist = await api(rw, 'GET', `/history/${S}/${enc(b.data.path)}`);
  check('GET /history', hist.status === 200 && typeof hist.data.git === 'boolean' && Array.isArray(hist.data.versions), `${hist.data.versions?.length} Versionen`);
  if (src.type === 'remote') {
    check('GET /history nach /sync: Version da', hist.data.git && hist.data.versions.length >= 1, hist.data.versions?.map((v) => `${v.commit.slice(0, 7)} ${v.author}`).join(' | '));
    const cur = await api(rw, 'GET', `/notes/${S}/${enc(b.data.path)}`);
    await api(rw, 'PUT', `/notes/${S}/${enc(b.data.path)}`, { markdown: cur.data.markdown + '\nDritte Fassung.\n', baseHash: cur.data.hash });
    await api(rw, 'POST', `/sync/${S}`);
    const hist2 = await api(rw, 'GET', `/history/${S}/${enc(b.data.path)}`);
    const first = hist2.data.versions.at(-1);
    const ver = await api(rw, 'GET', `/version/${S}/${enc(first.path)}?commit=${first.commit}`);
    check('GET /version: ältere Fassung', hist2.data.versions.length >= 2 && ver.status === 200 && ver.data.markdown.includes('Zweite Zeile') && !ver.data.markdown.includes('Dritte Fassung'));
    check('GET /version ohne commit → 400', (await api(rw, 'GET', `/version/${S}/${enc(b.data.path)}`)).status === 400);
    check('GET /version unbekannter commit → 404', (await api(rw, 'GET', `/version/${S}/${enc(b.data.path)}?commit=${'0'.repeat(40)}`)).status === 404);
    check('GET /version commit mit Optionen → 400', (await api(rw, 'GET', `/version/${S}/${enc(b.data.path)}?commit=--output=/tmp/x`)).status === 400);
  }

  // ── deleting
  const del = await api(rw, 'DELETE', `/notes/${S}/${enc(cp2.data.path)}`);
  check('DELETE /notes (Notiz)', del.status === 200 && del.data.ok === true, JSON.stringify(del.data));
  check('gelöschte Notiz → 404', (await api(rw, 'GET', `/notes/${S}/${enc(cp2.data.path)}`)).status === 404);
  check('DELETE unbekannter Pfad → 404', (await api(rw, 'DELETE', `/notes/${S}/${dir}/gibt-es-nicht.md`)).status === 404);
  check('DELETE Wurzel → abgelehnt', (await api(rw, 'DELETE', `/notes/${S}/`)).status >= 400);
  check('DELETE mit Lese-Token → 403', (await api(ro, 'DELETE', `/notes/${S}/${enc(b.data.path)}`)).status === 403);
} catch (e) {
  check('Ablauf', false, e.stack);
} finally {
  // ── clean-up: test files, folder (trash), sync; the source as it was
  try {
    for (const f of uploaded) await fetch(`${BASE}/api/attachments/${S}/${enc(f)}`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' } });
    if (S && dir) {
      const gone = await api(rw, 'DELETE', `/notes/${S}/${enc(dir)}`);
      check('Aufräumen: Testordner in den Papierkorb', gone.status === 200, JSON.stringify(gone.data));
      if (other) await api(rw, 'DELETE', `/notes/${other.id}/${enc(dir)}`);
      const fin = await api(rw, 'POST', `/sync/${S}`);
      check('Aufräumen abgeglichen', fin.status === 200 && fin.data.status.pendingEdits === 0, JSON.stringify(fin.data?.result));
      check('Testordner weg', !(await api(rw, 'GET', `/tree/${S}?depth=1`)).data.some((e) => e.path === dir));
      const left = await api(rw, 'GET', `/attachments/${S}/${enc(`${dir}/Quelle.md`)}`);
      check('keine Testdateien übrig', left.status === 404 || left.data.every((x) => x.size === null));
      const log = await session('GET', '/api/activity?limit=200');
      check('Protokoll: API-Einträge', JSON.stringify(log).includes(`API: Ordner angelegt: ${dir}`) && JSON.stringify(log).includes(`API: Gelöscht: ${dir}`));
    }
  } catch (e) {
    check('Aufräumen', false, e.stack);
  }
  for (const t of created) await fetch(`${BASE}/api/tokens/${t}`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' } });
  const leftTokens = (await session('GET', '/api/tokens')).filter((t) => created.includes(t.id));
  check('temporäre Tokens widerrufen', leftTokens.length === 0, `${created.length} widerrufen`);
  check('alle Antworten passen zur OpenAPI-Beschreibung', shape.length === 0, shape.slice(0, 6).join(' | '));
  check('jeder Status ist beschrieben (kein 500)', undocumented.size === 0, [...undocumented].join('; '));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
  process.exitCode = failed.length ? 1 : 0;
}
