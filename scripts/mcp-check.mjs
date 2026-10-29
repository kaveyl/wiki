// MCP check against a running instance (AD-023), as a client sees it: protocol, all tools, rights, errors, clean-up.
// Creates three temporary tokens through the admin's session (never printed, revoked at the end) and writes only into a
// folder „mcp-check-<time>“ of ONE source, which it deletes again (trash) and syncs. A second writable source, if there
// is one, only receives a note for a moment (moved there and back).
//
// Usage:  set -a; source <env file with KAVEYL_WIKI_ADMIN_MAIL and KAVEYL_WIKI_PASSWORD>; set +a
//         MCP_CHECK_CONFIRM="<exact source name>" node scripts/mcp-check.mjs
// Env:    KAVEYL_WIKI_URL, KAVEYL_WIKI_ADMIN_MAIL, KAVEYL_WIKI_PASSWORD; MCP_CHECK_CONFIRM = name of the source to write into.
// Exit code 1 when a check fails.

const BASE = (process.env.KAVEYL_WIKI_URL ?? '').replace(/\/$/, '');
const CONFIRM = process.env.MCP_CHECK_CONFIRM;
if (!BASE || !process.env.KAVEYL_WIKI_ADMIN_MAIL || !process.env.KAVEYL_WIKI_PASSWORD || !CONFIRM) {
  console.error('KAVEYL_WIKI_URL, KAVEYL_WIKI_ADMIN_MAIL, KAVEYL_WIKI_PASSWORD und MCP_CHECK_CONFIRM="<Name der Quelle>" setzen.');
  process.exit(2);
}

const results = [];
const check = (name, ok, info = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ' — ' + String(info).replace(/\s+/g, ' ').slice(0, 160) : ''}`);
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
  const r = await session('POST', '/api/tokens', { name: `mcp-check ${scopes.join('+')} (temporär)`, scopes, expiresDays: 1 });
  created.push(r.info.id);
  return r.token;
}
const full = await token(['read', 'write', 'mcp']);
const readOnly = await token(['read', 'mcp']);
const noMcp = await token(['read']);
const noRead = await token(['mcp']);

let id = 0;
async function rpc(tok, body, extra = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    // German unless a check asks otherwise: the checks compare German messages; without the header the server answers in English.
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'accept-language': 'de', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
}
const req = (tok, method, params, extra) => rpc(tok, { jsonrpc: '2.0', id: ++id, method, params }, extra);
async function call(tok, name, args, extra) {
  const r = await req(tok, 'tools/call', { name, arguments: args }, extra);
  const res = r.json?.result ?? {};
  const text = res.content?.[0]?.text ?? r.json?.error?.message ?? '';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: !!res.isError || !!r.json?.error, data, text };
}
async function until(fn, ok, tries = 30) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await fn();
    if (ok(v)) return v;
    await sleep(500);
  }
  return v;
}

let S;
let dir;
let other;
const uploaded = [];
try {
  // ── protocol
  check('GET /mcp → 405 (zustandslos, nur POST)', (await fetch(`${BASE}/mcp`)).status === 405);
  const anon = await req(null, 'initialize', {});
  check('ohne Token → 401 mit WWW-Authenticate', anon.status === 401 && /Bearer/.test(anon.headers.get('www-authenticate') ?? ''));
  check('Token ohne Recht „mcp“ → 403', (await req(noMcp, 'initialize', {})).status === 403);
  check('Token ohne „read“ (nur mcp): lesen abgelehnt', (await call(noRead, 'list_sources', {})).isError);
  check('fremder Origin → 403', (await req(full, 'ping', {}, { origin: 'https://evil.example' })).status === 403);
  const init = (await req(full, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-check', version: '1' } })).json.result;
  check('initialize: Version, Tools, Anleitung mit Link-, Commit- und Markdown-Hinweisen', init?.protocolVersion === '2025-06-18' && init?.capabilities?.tools && /relative/.test(init?.instructions) && /sync_source/.test(init?.instructions) && /\[!WARNING\]/.test(init?.instructions), `${init?.serverInfo?.version}`);
  check('unbekannte Protokollversion → neueste', (await req(full, 'initialize', { protocolVersion: '1999-01-01' })).json.result?.protocolVersion === '2025-11-25');
  check('Benachrichtigung → 202', (await rpc(full, { jsonrpc: '2.0', method: 'notifications/initialized' })).status === 202);
  check('ping', !!(await req(full, 'ping', {})).json.result);
  const tools = (await req(full, 'tools/list', {})).json.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check('tools/list: 18 Werkzeuge', names.length === 18, names.join(', '));
  const writing = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort().join();
  check('Schreibwerkzeuge markiert', writing === 'copy_note,create_folder,create_note,delete_note,move_note,sync_source,upload_file,write_note', writing);
  check('delete_note destruktiv, sync_source openWorld', tools.find((t) => t.name === 'delete_note')?.annotations.destructiveHint && tools.find((t) => t.name === 'sync_source')?.annotations.openWorldHint);
  check('unbekannte Methode → -32601', (await req(full, 'resources/list', {})).json.error?.code === -32601);
  const batch = (await rpc(full, [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }])).json;
  check('Batch: zwei Antworten', Array.isArray(batch) && batch.length === 2);
  check('unbekanntes Werkzeug → -32602', (await req(full, 'tools/call', { name: 'rm_rf', arguments: {} })).json.error?.code === -32602);

  // ── sources
  const sources = await call(full, 'list_sources', {});
  const src = (sources.data ?? []).find((s) => s.name === CONFIRM);
  check(`list_sources (Ziel „${CONFIRM}“ gefunden, Schreibrecht)`, src?.access === 'write' || src?.access === 'admin', (sources.data ?? []).map((s) => `${s.name} [${s.type}, ${s.access}]`).join('; '));
  if (!src) throw new Error(`Quelle „${CONFIRM}“ nicht gefunden oder nicht sichtbar`);
  S = src.id;
  other = (sources.data ?? []).find((s) => s.id !== S && (s.access === 'write' || s.access === 'admin') && !s.readonly);

  // ── reading
  const tree = await call(full, 'list_tree', { source_id: S });
  const anyNote = Array.isArray(tree.data) ? tree.data.find((e) => e.kind === 'file' && /\.md$/.test(e.path) && !e.path.startsWith('mcp-check-')) : null;
  check('list_tree', Array.isArray(tree.data) && anyNote, `${tree.data?.length} Einträge`);
  const word = anyNote.name.split(/[\s_-]+/).find((w) => w.length > 3) ?? anyNote.name;
  const sr = await call(full, 'search', { query: word, limit: 10 });
  check('search', Array.isArray(sr.data) && sr.data.length > 0, `„${word}“ → ${sr.data?.length}`);
  const srOne = await call(full, 'search', { query: word, source_id: S });
  check('search mit source_id: nur diese Quelle', Array.isArray(srOne.data) && srOne.data.length > 0 && srOne.data.every((h) => h.sourceId === S));
  const srIn = await call(full, 'search', { query: `${word} in:${S}` });
  check('search mit in:<id>', Array.isArray(srIn.data) && srIn.data.length > 0 && srIn.data.every((h) => h.sourceId === S));
  const rd0 = await call(full, 'read_note', { source_id: S, path: anyNote.path });
  check('read_note', typeof rd0.data?.markdown === 'string' && rd0.data.hash, anyNote.path);
  const before = rd0.data;

  // ── folders and notes
  dir = `mcp-check-${Date.now()}`;
  const f = await call(full, 'create_folder', { source_id: S, parent: '', name: dir });
  check('create_folder', !f.isError && f.data.path === dir && f.data.folderNote.startsWith(`${dir}/`), f.isError ? f.text : f.data.folderNote);
  const f2 = await call(full, 'create_folder', { source_id: S, parent: dir, name: 'Projekte' });
  const f3 = await call(full, 'create_folder', { source_id: S, parent: dir, name: 'Projekte' });
  check('create_folder: Name wird eindeutig', f2.data?.path === `${dir}/Projekte` && f3.data?.path === `${dir}/Projekte 2`, f3.data?.path);
  check('create_folder ohne Namen → Fehler', (await call(full, 'create_folder', { source_id: S, parent: dir, name: ' ' })).isError);
  const a = await call(full, 'create_note', { source_id: S, parent: `${dir}/Projekte/Website`, title: 'Ziel' });
  check('create_note (fehlende Ordner entstehen mit)', a.data?.path === `${dir}/Projekte/Website/Ziel.md`, a.isError ? a.text : a.data.path);
  const b = await call(full, 'create_note', { source_id: S, parent: dir, title: 'Quelle', markdown: `# Quelle\n\nSiehe [Ziel](Projekte/Website/Ziel.md).\n\n- [ ] offen\n- [x] erledigt\n\n| A | B |\n|---|---|\n| 1 | 2 |\n` });
  check('create_note mit Markdown, Link, Aufgaben, Tabelle', !b.isError, b.isError ? b.text : b.data.path);
  const rb = await call(full, 'read_note', { source_id: S, path: b.data.path });
  check('read_note: id ergänzt, Inhalt unverändert', /^---\n[\s\S]*id:/.test(rb.data.markdown) && rb.data.markdown.includes('| 1 | 2 |') && rb.data.markdown.includes('- [x] erledigt'));
  const w = await call(full, 'write_note', { source_id: S, path: b.data.path, markdown: rb.data.markdown + '\nZweite Zeile per MCP.\n', base_hash: rb.data.hash });
  check('write_note', !w.isError && w.data.changed === true, w.isError ? w.text : '');
  const same = await call(full, 'write_note', { source_id: S, path: b.data.path, markdown: rb.data.markdown + '\nZweite Zeile per MCP.\n', base_hash: w.data.hash });
  check('write_note gleicher Inhalt → changed=false', !same.isError && same.data.changed === false);
  const stale = await call(full, 'write_note', { source_id: S, path: b.data.path, markdown: 'weg', base_hash: rb.data.hash });
  check('write_note mit altem hash → Konflikt', stale.isError && /Konflikt/.test(stale.text));
  const bl = await until(() => call(full, 'get_backlinks', { source_id: S, path: a.data.path }), (r) => Array.isArray(r.data) && r.data.length > 0);
  check('get_backlinks', bl.data?.some?.((x) => x.path === b.data.path));
  const sr2 = await until(() => call(full, 'search', { query: '"Zweite Zeile per MCP"', source_id: S }), (r) => Array.isArray(r.data) && r.data.length > 0);
  check('search findet frisch Geschriebenes', sr2.data?.some?.((h) => h.path === b.data.path));

  // ── sync state, sync, history
  const st0 = await call(full, 'get_sync_status', { source_id: S });
  check('get_sync_status: wartende Änderungen sichtbar', Array.isArray(st0.data) && st0.data[0]?.id === S && (st0.data[0].pendingEdits > 0 || !st0.data[0].autoCommit), JSON.stringify({ pending: st0.data?.[0]?.pendingEdits, sync: st0.data?.[0]?.syncStatus }));
  check('get_sync_status mit Lese-Token: canSync=false', (await call(readOnly, 'get_sync_status', { source_id: S })).data?.[0]?.canSync === false);
  check('get_sync_status ohne Quelle: alle', (await call(full, 'get_sync_status', {})).data?.length === sources.data.length);
  check('sync_source mit Lese-Token abgelehnt', (await call(readOnly, 'sync_source', { source_id: S })).isError);
  const sync = await call(full, 'sync_source', { source_id: S });
  const waiting = st0.data?.[0]?.pendingEdits > 0;
  const syncOk = !sync.isError && (src.type !== 'remote' || (waiting ? sync.data.result?.status === 'synced' && sync.data.result.pushed > 0 : ['synced', 'up-to-date'].includes(sync.data.result?.status)));
  check('sync_source', syncOk && sync.data.status.pendingEdits === 0, JSON.stringify(sync.data?.result ?? sync.text));
  if (src.type === 'remote') {
    check('nach dem Abgleich: nichts vor/hinter dem Remote', sync.data.status.git?.ahead === 0 && sync.data.status.git?.behind === 0 && sync.data.status.syncStatus === 'ok', JSON.stringify(sync.data.status.git));
    const hist = await call(full, 'get_history', { source_id: S, path: b.data.path });
    check('get_history direkt nach sync_source', hist.data?.git && hist.data.versions.length >= 1, hist.data?.versions?.map((v) => `${v.commit.slice(0, 7)} ${v.author}`).join(' | '));
    const w2 = await call(full, 'write_note', { source_id: S, path: b.data.path, markdown: rb.data.markdown + '\nDritte Fassung.\n', base_hash: w.data.hash });
    await call(full, 'sync_source', { source_id: S });
    const hist2 = await call(full, 'get_history', { source_id: S, path: b.data.path });
    const first = hist2.data.versions.at(-1);
    const ver = await call(full, 'read_version', { source_id: S, path: first.path, commit: first.commit });
    check('read_version: ältere Fassung', !w2.isError && hist2.data.versions.length >= 2 && ver.data.markdown.includes('Zweite Zeile') && !ver.data.markdown.includes('Dritte Fassung'));
  }

  // ── files
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" rx="8" fill="#f5c542"/><text x="60" y="36" font-size="16" text-anchor="middle">mcp-check</text></svg>';
  const up = await call(full, 'upload_file', { source_id: S, note: b.data.path, name: 'Prüf Bild.svg', content_text: SVG });
  check('upload_file (SVG als Text)', !up.isError && up.data.path === `${dir}/assets/Prüf-Bild.svg` && up.data.markdown === '![Prüf-Bild](assets/Pr%C3%BCf-Bild.svg)', up.isError ? up.text : up.data.markdown);
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up2 = await call(full, 'upload_file', { source_id: S, note: b.data.path, name: 'punkt.png', content_base64: PNG });
  check('upload_file (PNG als Base64)', !up2.isError && up2.data.image === true && up2.data.size === 70, up2.isError ? up2.text : `${up2.data.size} Bytes`);
  const up3 = await call(full, 'upload_file', { source_id: S, note: b.data.path, name: 'punkt.png', content_base64: PNG });
  uploaded.push(...[up, up2, up3].filter((u) => !u.isError).map((u) => u.data.path));
  check('upload_file: gleicher Name → Nummer', up3.data?.name === 'punkt-2.png');
  check('upload_file: .exe abgelehnt', (await call(full, 'upload_file', { source_id: S, note: b.data.path, name: 'x.exe', content_base64: 'TVo=' })).isError);
  check('upload_file: kaputtes Base64 abgelehnt', (await call(full, 'upload_file', { source_id: S, note: b.data.path, name: 'x.png', content_base64: '%%%' })).isError);
  check('upload_file: Lese-Token abgelehnt', (await call(readOnly, 'upload_file', { source_id: S, note: b.data.path, name: 'x.svg', content_text: SVG })).isError);
  const rbf = await call(full, 'read_note', { source_id: S, path: b.data.path });
  const wf = await call(full, 'write_note', { source_id: S, path: b.data.path, markdown: `${rbf.data.markdown}\n${up.data.markdown}\n\n${up2.data.markdown}\n`, base_hash: rbf.data.hash });
  const la = await call(full, 'list_attachments', { source_id: S, path: b.data.path });
  check('list_attachments: beide Bilder mit Größe', !wf.isError && Array.isArray(la.data) && la.data.length === 2 && la.data.every((f) => f.size > 0 && f.kind === 'image'), JSON.stringify(la.data?.map?.((f) => [f.name, f.size])));
  const served = await fetch(`${BASE}/api/files/${S}/${encodeURI(up.data.path)}`, { headers: { cookie } });
  check('hochgeladenes Bild wird ausgeliefert', served.ok && (await served.text()) === SVG, `${served.status} ${served.headers.get('content-type')}`);

  const lc0 = await call(readOnly, 'list_changes', { source_id: S, path: dir });
  check('list_changes: Start liefert nur den Cursor', !lc0.isError && typeof lc0.data.cursor === 'string' && lc0.data.changes.length === 0, lc0.isError ? lc0.text : '');
  // ── moving
  const mv = await call(full, 'move_note', { source_id: S, from: a.data.path, to: `${dir}/Projekte/Ziel neu.md` });
  check('move_note (umbenennen + verschieben)', !mv.isError && mv.data.path === `${dir}/Projekte/Ziel neu.md`, mv.isError ? mv.text : mv.data.path);
  const rb3 = await call(full, 'read_note', { source_id: S, path: b.data.path });
  check('Link nach dem Verschieben repariert', /\]\(Projekte\/Ziel%20neu\.md\)/.test(rb3.data.markdown), rb3.data.markdown.split('\n').find((l) => l.startsWith('Siehe')));
  const cp = await call(full, 'copy_note', { source_id: S, from: b.data.path, to_parent: dir });
  check('copy_note: Kopie daneben mit „(Kopie)“', !cp.isError && / \(Kopie\)\.md$/.test(cp.data.path), cp.isError ? cp.text : cp.data.path);
  const lcOff = await call(readOnly, 'list_changes', { source_id: S, path: dir, after: lc0.data.cursor });
  const lcOn = await call(readOnly, 'list_changes', { source_id: S, path: dir, after: lc0.data.cursor, include_own: true });
  const lcCopy = lcOn.data?.changes?.find((c) => c.path === cp.data?.path);
  check('list_changes: eigene Änderungen nur mit include_own, mit Person und via=mcp', !lcOff.isError && lcOff.data.changes.length === 0 && lcCopy?.kind === 'created' && !!lcCopy.byId && lcCopy.via === 'mcp', JSON.stringify(lcCopy ?? lcOn.text ?? ''));
  const lt0 = Date.now();
  const lcWait = await call(readOnly, 'list_changes', { source_id: S, path: dir, after: lcOn.data?.cursor, wait_seconds: 2 });
  check('list_changes: wait_seconds wartet und antwortet leer', !lcWait.isError && lcWait.data.changes.length === 0 && Date.now() - lt0 >= 1800, `${Date.now() - lt0} ms`);
  const mvf = await call(full, 'move_note', { source_id: S, from: `${dir}/Projekte 2`, to: `${dir}/Archiv` });
  check('move_note: Ordner umbenennen', !mvf.isError && mvf.data.path === `${dir}/Archiv`, mvf.isError ? mvf.text : '');
  if (other) {
    const across = await call(full, 'move_note', { source_id: S, from: `${dir}/Projekte/Ziel neu.md`, to: `${dir}/Ziel neu.md`, to_source_id: other.id });
    check(`move_note in „${other.name}“`, !across.isError, across.isError ? across.text : across.data.path);
    if (!across.isError) {
      const back = await call(full, 'move_note', { source_id: other.id, from: across.data.path, to: `${dir}/Projekte/Ziel neu.md`, to_source_id: S });
      check('… und zurück', !back.isError, back.isError ? back.text : back.data.path);
      const leftover = await call(full, 'delete_note', { source_id: other.id, path: dir });
      check(`leeren Ordner in „${other.name}“ löschen`, !leftover.isError, leftover.text);
    }
  }

  // ── deleting
  const del = await call(full, 'delete_note', { source_id: S, path: `${dir}/Projekte/Ziel neu.md` });
  check('delete_note (Notiz)', !del.isError && del.data.ok === true, del.text);
  check('gelöschte Notiz nicht mehr lesbar', (await call(full, 'read_note', { source_id: S, path: `${dir}/Projekte/Ziel neu.md` })).isError);
  check('delete_note unbekannter Pfad → Fehler', (await call(full, 'delete_note', { source_id: S, path: `${dir}/gibt-es-nicht.md` })).isError);
  check('delete_note Wurzel → abgelehnt', (await call(full, 'delete_note', { source_id: S, path: '' })).isError);
  check('delete_note mit Lese-Token → abgelehnt', (await call(readOnly, 'delete_note', { source_id: S, path: b.data.path })).isError);

  // ── rights and bad input
  const ro = await call(readOnly, 'write_note', { source_id: S, path: b.data.path, markdown: 'x', base_hash: rb3.data.hash });
  check('Lese-Token: write_note abgelehnt', ro.isError && /Schreibrecht/.test(ro.text), ro.text);
  check('Lese-Token: create_note / create_folder / move_note abgelehnt', (await call(readOnly, 'create_note', { source_id: S, parent: dir, title: 'nein' })).isError && (await call(readOnly, 'create_folder', { source_id: S, parent: dir, name: 'nein' })).isError && (await call(readOnly, 'move_note', { source_id: S, from: b.data.path, to: `${dir}/x.md` })).isError);
  check('Lese-Token: lesen geht, access = read', (await call(readOnly, 'read_note', { source_id: S, path: b.data.path })).data?.access === 'read');
  check('fehlender Parameter', /Parameter „path“ fehlt/.test((await call(full, 'read_note', { source_id: S })).text));
  check('Pfad außerhalb der Quelle', /außerhalb/.test((await call(full, 'read_note', { source_id: S, path: '../../etc/passwd' })).text));
  check('unbekannte Quelle', (await call(full, 'list_tree', { source_id: 'gibt-es-nicht' })).isError);
  const en = { 'accept-language': 'en-GB' };
  check('Fehler auf Englisch (Accept-Language)', (await call(full, 'read_note', { source_id: S, path: 'gibt/es/nicht.md' }, en)).text === 'Not found (or no permission).');
  check('Inhalt mit Accept-Language: en unverändert', (await call(full, 'read_note', { source_id: S, path: anyNote.path }, en)).data?.markdown === before.markdown);
  check('ohne Sprachangabe Englisch (Rückfallsprache)', (await call(full, 'read_note', { source_id: S, path: 'gibt/es/nicht.md' }, { 'accept-language': '' })).text === 'Not found (or no permission).');

  // ── clean-up through MCP itself, then sync. Deleting keeps non-note files (AD-025) – the test images go via the app's route.
  for (const f of uploaded) {
    const r = await fetch(`${BASE}/api/attachments/${S}/${encodeURI(f)}`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' } });
    if (!r.ok) check(`Testbild entfernen: ${f}`, false, `${r.status}`);
  }
  const gone = await call(full, 'delete_note', { source_id: S, path: dir });
  check('Aufräumen: Testordner per delete_note in den Papierkorb', !gone.isError, gone.text);
  const trash = await session('GET', `/api/trash/${S}`);
  check('Papierkorb kennt die gelöschten Notizen', JSON.stringify(trash).includes(dir));
  const fin = await call(full, 'sync_source', { source_id: S });
  check('Aufräumen abgeglichen', !fin.isError && fin.data.status.pendingEdits === 0, JSON.stringify(fin.data?.result));
  check('Testordner weg', !(await call(full, 'list_tree', { source_id: S, depth: 1 })).data.some((e) => e.path === dir));
  const files = await fetch(`${BASE}/api/v1/attachments/${S}/${encodeURI(`${dir}/Quelle.md`)}`, { headers: { authorization: `Bearer ${full}` } });
  check('keine Testbilder übrig', files.status === 404 || (await files.json()).every((f) => f.size === null));
  const after = await call(full, 'read_note', { source_id: S, path: anyNote.path });
  check('vorhandene Notiz unverändert', after.data?.hash === before.hash);
  const log = await session('GET', '/api/activity?limit=100');
  check('Protokoll: MCP-Einträge', JSON.stringify(log).includes(`MCP: Ordner angelegt: ${dir}`) && JSON.stringify(log).includes(`MCP: Gelöscht: ${dir}`));
} catch (e) {
  check('Ablauf', false, e.stack);
  // leave nothing behind
  for (const f of uploaded) await fetch(`${BASE}/api/attachments/${S}/${encodeURI(f)}`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' } }).catch(() => undefined);
  if (S && dir) await call(full, 'delete_note', { source_id: S, path: dir }).catch(() => undefined);
  if (other && dir) await call(full, 'delete_note', { source_id: other.id, path: dir }).catch(() => undefined);
  if (S) await call(full, 'sync_source', { source_id: S }).catch(() => undefined);
} finally {
  for (const t of created) await fetch(`${BASE}/api/tokens/${t}`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' } });
  const left = (await session('GET', '/api/tokens')).filter((t) => created.includes(t.id));
  check('temporäre Tokens widerrufen', left.length === 0, `${created.length} widerrufen`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
  process.exitCode = failed.length ? 1 : 0;
}
