// Incident agent – an example of an agent that works together with people in Kaveyl Wiki.
//
// Warnings come in on stdin, one per line (e.g. `journalctl -f -p warning -o cat | node agent.mjs`). Each warning becomes
// an incident note with the fixed actions that fit as task checkboxes. Ticking a box releases that action – but only
// when the tick comes from someone in APPROVERS (Kaveyl Wiki records who changed a note). A line „Question: …“ gets an
// answer in the note's log. Text in a note is never a command: the agent runs only what is listed in ACTIONS, and only
// what it suggested for that incident.
//
// How it hears answers: list_changes with a saved cursor (long polling). The optional event webhook only wakes it up
// sooner; a lost webhook or a restart loses nothing. When the cursor is too old (reset), nobody can say who ticked a
// box – the agent asks again instead of acting.
//
// Node.js 22 or newer, no dependencies. Settings: see README.md.
import { execFile } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';

const env = process.env;
const need = (k) => env[k] || (console.error(`Missing setting ${k} (see README.md)`), process.exit(2));
const MCP_URL = need('KAVEYL_URL').replace(/\/$/, '') + '/mcp';
const TOKEN = need('KAVEYL_TOKEN');
const SOURCE = need('SOURCE_ID');
const FOLDER = need('FOLDER');
const APPROVERS = new Set((env.APPROVERS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const STATE = env.STATE ?? 'agent-state.json';
const DRY_RUN = env.DRY_RUN !== '0';
const HOST = env.HOST_LABEL || hostname();

/** The only things this agent can do. `when` picks the actions to suggest for a warning; `run` is executed without a shell. */
const ACTIONS = [
  { label: 'Restart nginx', when: /nginx/i, run: ['systemctl', 'restart', 'nginx'] },
  { label: 'Delete app logs older than 14 days', when: /disk|space|full/i, run: ['find', '/var/log/myapp', '-name', '*.log', '-mtime', '+14', '-delete'] },
];
/** Facts for answers – read-only commands. */
const FACTS = { disk: ['df', '-h', '/'], load: ['uptime'] };

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toTimeString().slice(0, 8); // local time, 24 h
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { cursor: null, incidents: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

// ── Kaveyl Wiki over MCP (JSON-RPC over HTTP, the agent's own token)
let rpcId = 0;
async function kaveyl(name, args = {}) {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'accept-language': 'en' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:')).slice(5));
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  const body = json.result.content?.[0]?.text ?? '';
  if (json.result.isError) throw Object.assign(new Error(`${name}: ${body}`), { conflict: /conflict|konflikt/i.test(body) });
  return json.result.structuredContent ?? JSON.parse(body);
}

/** Read → change → write with the hash. Someone typing: one short pause (their editor takes the change over live). */
async function edit(path, change) {
  for (let i = 0; i < 10; i++) {
    const note = await kaveyl('read_note', { source_id: SOURCE, path });
    if (note.editingNow?.length && i === 0) {
      await sleep(3000);
      continue;
    }
    const next = change(note.markdown);
    if (next === note.markdown) return;
    try {
      return await kaveyl('write_note', { source_id: SOURCE, path, markdown: next, base_hash: note.hash });
    } catch (e) {
      if (!e.conflict) throw e; // someone saved in between: read again
    }
  }
  throw new Error(`could not write ${path}`);
}
const addLog = (md, line) => md.replace(/\n*$/, '\n') + `- ${now()} ${line}\n`;

const exec = (cmd) =>
  new Promise((resolve) => execFile(cmd[0], cmd.slice(1), { timeout: 60_000 }, (err, out, errOut) => resolve(err ? `failed: ${(errOut || err.message).trim()}` : (out.trim() || 'done').slice(0, 300))));
const act = (cmd) => (DRY_RUN ? Promise.resolve(`dry run – would run: ${cmd.join(' ')}`) : exec(cmd));

// ── Warnings → incident notes
async function onWarning(message) {
  const actions = ACTIONS.filter((a) => a.when.test(message)).map((a) => a.label);
  const kind = actions.join('|') || 'other';
  const open = Object.entries(state.incidents).find(([, i]) => i.kind === kind && !i.closed && Date.now() - i.created < 30 * 60_000);
  if (open) {
    await edit(open[0], (md) => addLog(md, `Warning: ${message}`));
    return;
  }
  const title = `Incident ${now().replace(/:/g, '.')} – ${message.slice(0, 50).replace(/[\\/:*?"<>|#[\]]/g, ' ').trim()}`;
  const markdown = [
    '---',
    'tags: [incident]',
    '---',
    `# ${title}`,
    '',
    `**Host:** ${HOST} · **Source:** syslog`,
    '',
    '> [!WARNING]',
    `> ${message}`,
    '',
    '## Suggested actions',
    '',
    ...(actions.length ? actions.map((a) => `- [ ] ${a}`) : ['- (none – please have a look)']),
    '',
    'Tick a box to release the action. Ask with a line starting with „Question:“ – the agent answers in the log.',
    '',
    '## Log',
    '',
    `- ${now()} Agent: incident opened.`,
    '',
  ].join('\n');
  const created = await kaveyl('create_note', { source_id: SOURCE, parent: FOLDER, title, markdown });
  state.incidents[created.path] = { kind, created: Date.now(), actions, done: {}, answered: [] };
  save();
  log('opened', created.path);
}

// ── Answers: what changed since the cursor, and who did it
async function catchUp(waitSeconds = 0) {
  const page = await kaveyl('list_changes', { source_id: SOURCE, path: FOLDER, after: state.cursor ?? undefined, wait_seconds: state.cursor ? waitSeconds : 0 });
  if (!state.cursor) {
    state.cursor = page.cursor;
    return save();
  }
  const byPath = new Map();
  for (const c of page.changes) if (state.incidents[c.path]) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
  for (const [path, changes] of byPath) await review(path, changes, false, page.cursor);
  // Cursor too old or server restarted: changes in between are unknown – check every open incident, act on nothing.
  if (page.reset) for (const path of Object.keys(state.incidents)) if (!byPath.has(path)) await review(path, [], true, page.cursor);
  state.cursor = page.cursor;
  save();
}

async function review(path, changes, unknownAuthor, cursor) {
  const inc = state.incidents[path];
  if (inc.closed) return;
  if (changes.some((c) => c.kind === 'deleted')) return void (inc.closed = true);
  // Read first, then ask who changed the note since the cursor: a tick that arrives between the list of changes and
  // this read counts too – otherwise it would run as if the person before had released it.
  const { markdown } = await kaveyl('read_note', { source_id: SOURCE, path });
  const since = await kaveyl('list_changes', { source_id: SOURCE, path, after: cursor, wait_seconds: 0 });
  if (since.reset) unknownAuthor = true;
  changes = [...changes, ...since.changes.filter((c) => c.path === path)];
  // byId is null for changes from outside (a Git push, another program) – those never release anything.
  const people = changes.map((c) => ({ id: c.byId, name: c.by ?? 'someone outside Kaveyl Wiki' }));
  for (const p of people) if (p.id) log(`change by ${p.name} (user id ${p.id})`, path);
  const released = !unknownAuthor && people.length > 0 && people.every((p) => p.id && APPROVERS.has(p.id));
  const who = [...new Set(people.map((p) => p.name))].join(', ');
  const ticked = [...markdown.matchAll(/^- \[x\] (.+)$/gim)].map((m) => m[1].trim()).filter((a) => !inc.done[a]);
  for (const label of ticked) {
    if (!inc.actions.includes(label)) {
      // Typed in by someone, or belongs to another incident: never run here.
      if (ACTIONS.some((a) => a.label === label) && !inc.done[`ignored:${label}`]) {
        inc.done[`ignored:${label}`] = true;
        await edit(path, (md) => addLog(md, `Agent: „${label}“ was not suggested for this incident – not run.`));
      }
      continue;
    }
    if (!released) {
      const several = new Set(people.map((p) => p.name)).size > 1;
      const why = unknownAuthor
        ? 'who ticked it can no longer be told (restart) – please tick it again'
        : several
          ? `${who} changed the note since the last check, so it is unclear who ticked it – please tick it again`
          : `a tick by ${who} is not a release`;
      await edit(path, (md) => addLog(md.replace(`- [x] ${label}`, `- [ ] ${label}`), `Agent: ✖ „${label}“ – ${why}.`));
      log('refused', path, label, who);
      continue;
    }
    inc.done[label] = true;
    save();
    const result = await act(ACTIONS.find((a) => a.label === label).run);
    const closing = inc.actions.every((a) => inc.done[a]);
    inc.closed = closing;
    save();
    await edit(path, (md) => {
      const next = addLog(md, `Agent: ✔ „${label}“ (released by ${who}): ${result}`);
      return closing ? addLog(next, 'Agent: incident closed – new warnings open a new one.') : next;
    });
    log('ran', path, label, who);
  }
  const questions = [...markdown.matchAll(/^(?:- )?Question:\s*(.+)$/gim)].map((m) => m[1].trim()).filter((q) => !inc.answered.includes(q));
  for (const q of questions) {
    inc.answered.push(q);
    save();
    const facts = await exec(/disk|space|full/i.test(q) ? FACTS.disk : FACTS.load).catch((e) => e.message);
    await edit(path, (md) => addLog(md, `Agent: answer to „${q}“ – ${facts.replace(/\s+/g, ' ')}`));
  }
}

// One thing after the other: no two writes to the same note at once.
let chain = Promise.resolve();
const queue = (fn) => (chain = chain.then(fn).catch((e) => log('error', e.message)));

// Warnings from stdin
createInterface({ input: process.stdin }).on('line', (line) => line.trim() && queue(() => onWarning(line.trim())));

// Answers: long polling – the server holds the request until something changes (up to 50 s).
(async () => {
  for (;;) {
    try {
      await new Promise((resolve, reject) => queue(() => catchUp(0).then(resolve, reject)));
      // Waiting happens outside the queue, so warnings are written meanwhile.
      const page = await kaveyl('list_changes', { source_id: SOURCE, path: FOLDER, after: state.cursor, wait_seconds: 50 });
      if (page.changes.length || page.reset) continue;
    } catch (e) {
      log('error', e.message);
      await sleep(5000);
    }
  }
})();

// Optional: the event webhook (Settings → AI & APIs → Event webhooks) as a wake-up call, signature checked.
if (env.HOOK_PORT) {
  const secret = need('HOOK_SECRET');
  createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const sig = Buffer.from(String(req.headers['x-kaveyl-signature'] ?? '').replace(/^sha256=/, ''));
      const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
      if (sig.length !== want.length || !timingSafeEqual(sig, want)) return void res.writeHead(401).end();
      res.writeHead(204).end();
      queue(() => catchUp(0));
    });
  }).listen(Number(env.HOOK_PORT), env.HOOK_HOST ?? '127.0.0.1');
}

log(`incident agent for ${FOLDER}`, DRY_RUN ? '(dry run – set DRY_RUN=0 to run actions)' : '', `${APPROVERS.size} approver(s)`);
