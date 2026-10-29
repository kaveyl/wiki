// OpenAPI 3.1 description of the REST API v1 (served at /api/v1/openapi.json, shown in the
// app under Einstellungen → API & MCP). Keep in sync with v1.ts.

const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema: object, description = 'OK') => ({ description, ...json(schema) });
const errors = {
  400: { description: 'Ungültige Anfrage', ...json(ref('Error')) },
  401: { description: 'Nicht angemeldet / Token ungültig', ...json(ref('Error')) },
  403: { description: 'Keine Berechtigung (Recht oder Token-Scope fehlt)', ...json(ref('Error')) },
  404: { description: 'Nicht gefunden (oder nicht sichtbar)', ...json(ref('Error')) },
};
const sourceId = { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' }, description: 'ID der Quelle (aus GET /sources)' };
const notePath = { name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'Pfad der Notiz in der Quelle, z. B. `plan/roadmap.md` (Schrägstriche bleiben)' };
const str = { type: 'string' };

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Kaveyl Wiki API',
    version: '1',
    description:
      'Notizen und Ordner aller eingebundenen Quellen lesen und ändern. Es gelten dieselben Rechte wie in der App (AD-020): ' +
      'unsichtbares ergibt 404, nur Leserecht ergibt 403 beim Schreiben. Anmeldung mit `Authorization: Bearer kw_…` ' +
      '(API-Token aus Einstellungen → Konto; Scope `read` zum Lesen, `write` zum Ändern). Änderungen werden mit dem ' +
      'Token-Inhaber als Autor committet. Verschlüsselte Notizen liefern nur Name und Titel (`markdown: null`).',
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearer: [] }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'kw_…' } },
    schemas: {
      Error: { type: 'object', properties: { error: str }, required: ['error'] },
      Source: {
        type: 'object',
        properties: { id: str, name: str, type: { enum: ['remote', 'local'] }, readonly: { type: 'boolean' }, access: { enum: ['read', 'write', 'admin'] }, folderNote: str },
      },
      Entry: {
        type: 'object',
        properties: { path: str, kind: { enum: ['file', 'dir'] }, name: str, title: str, tags: { type: 'array', items: str }, access: str, mtime: { type: 'number' } },
      },
      Hit: {
        type: 'object',
        properties: { sourceId: str, path: str, name: str, title: str, tags: { type: 'array', items: str }, mtime: { type: 'number' }, snippet: { ...str, description: 'Treffer in «…»' } },
      },
      Note: {
        type: 'object',
        properties: {
          sourceId: str,
          path: str,
          name: str,
          title: str,
          hash: { ...str, description: 'Stand der Datei; beim Schreiben als baseHash mitgeben' },
          encrypted: { type: 'boolean' },
          readonly: { type: 'boolean' },
          access: str,
          editingNow: { type: 'array', items: str, description: 'Wer die Notiz gerade in der App bearbeitet (tippt) – vor dem Schreiben besser warten oder nachfragen' },
          markdown: { type: ['string', 'null'], description: 'Ganze Datei inkl. Frontmatter; null bei verschlüsselten Notizen' },
        },
      },
      Moved: { type: 'object', properties: { sourceId: str, path: str, warnings: { type: 'array', items: str } } },
      Changes: {
        type: 'object',
        properties: {
          cursor: { ...str, description: 'beim nächsten Aufruf als `after` mitgeben' },
          reset: { type: 'boolean', description: 'Stand zu alt oder Server neu gestartet – das Beobachtete einmal neu lesen' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourceId: str,
                path: str,
                kind: { type: 'string', enum: ['created', 'changed', 'deleted', 'moved'] },
                from: { ...str, description: 'alter Pfad beim Verschieben' },
                at: str,
                by: { type: ['string', 'null'], description: 'wer es geändert hat (null = von außen)' },
                byId: { type: ['string', 'null'] },
                via: { type: 'string', enum: ['app', 'api', 'mcp', 'extern'] },
              },
            },
          },
        },
      },
      Status: {
        type: 'object',
        properties: {
          id: str,
          name: str,
          type: { enum: ['remote', 'local'] },
          syncStatus: { type: ['string', 'null'], description: 'ok, syncing, error, conflict (nur Git-Quellen)' },
          syncDetail: { type: ['string', 'null'] },
          syncedAt: { type: ['string', 'null'] },
          autoCommit: { type: 'boolean' },
          commitIdleSec: { type: 'integer', description: 'Ruhepause bis zum Commit (höchstens 10 Minuten nach der ersten Änderung)' },
          pendingEdits: { type: 'integer' },
          git: { type: ['object', 'null'], properties: { branch: str, upstream: { type: ['string', 'null'], description: 'null bei einem lokalen Ordner mit eigenem Git (kein Git-Server)' }, ahead: { type: 'integer' }, behind: { type: 'integer' }, uncommitted: { type: 'integer' } } },
          canSync: { type: 'boolean' },
        },
      },
      Version: { type: 'object', properties: { commit: str, path: { ...str, description: 'Pfad in dieser Version (vor einer Umbenennung anders)' }, date: str, author: str, coAuthors: { type: 'array', items: str, description: 'Weitere Personen in diesem Commit (Co-authored-by)' }, subject: str } },
    },
  },
  paths: {
    '/sources': { get: { summary: 'Quellen auflisten', responses: { 200: ok({ type: 'array', items: ref('Source') }), 401: errors[401] } } },
    '/tree/{sourceId}': {
      get: {
        summary: 'Ordner und Notizen einer Quelle',
        parameters: [
          sourceId,
          { name: 'path', in: 'query', schema: str, description: 'nur unterhalb dieses Ordners' },
          { name: 'depth', in: 'query', schema: { type: 'integer', minimum: 1 }, description: 'Anzahl Ebenen (Standard: alle)' },
        ],
        responses: { 200: ok({ type: 'array', items: ref('Entry') }), 404: errors[404] },
      },
    },
    '/search': {
      get: {
        summary: 'Volltextsuche',
        description: 'Operatoren wie auf der Such-Seite: `"Phrase"`, `-wort`, `tag:x`, `in:"Name der Quelle"`, `path:ordner/`, `seit:7d`.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: str },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'source', in: 'query', schema: str, description: 'nur in dieser Quelle (ID)' },
        ],
        responses: { 200: ok({ type: 'array', items: ref('Hit') }) },
      },
    },
    '/notes/{sourceId}': {
      post: {
        summary: 'Notiz anlegen',
        description: 'Dateiname aus dem Titel (eindeutig gemacht). Ohne `markdown` entsteht `# Titel`.',
        parameters: [sourceId],
        requestBody: { required: true, ...json({ type: 'object', required: ['title'], properties: { parent: { ...str, description: 'Ordner, leer = oberste Ebene' }, title: str, markdown: str } }) },
        responses: { 200: ok({ type: 'object', properties: { sourceId: str, path: str, hash: str } }), ...errors },
      },
    },
    '/notes/{sourceId}/{path}': {
      get: { summary: 'Notiz lesen', parameters: [sourceId, notePath], responses: { 200: ok(ref('Note')), 404: errors[404] } },
      put: {
        summary: 'Notiz ersetzen',
        description: 'Ersetzt die ganze Datei. `baseHash` = `hash` aus dem Lesen; hat sich die Datei inzwischen geändert, kommt 409 mit dem aktuellen Stand.',
        parameters: [sourceId, notePath],
        requestBody: { required: true, ...json({ type: 'object', required: ['markdown', 'baseHash'], properties: { markdown: str, baseHash: str } }) },
        responses: {
          200: ok({ type: 'object', properties: { hash: str, changed: { type: 'boolean' } } }),
          409: { description: 'Konflikt: Datei wurde inzwischen geändert', ...json({ type: 'object', properties: { error: str, currentHash: str, currentRaw: str } }) },
          ...errors,
        },
      },
      delete: {
        summary: 'Notiz oder Ordner löschen (in den Papierkorb)',
        description: 'Bei einem Ordner alle Notizen darin; andere Dateien (Bilder, Code) bleiben. Wiederherstellen in der App über den Papierkorb.',
        parameters: [sourceId, notePath],
        responses: { 200: ok({ type: 'object' }), ...errors },
      },
    },
    '/folders/{sourceId}': {
      post: {
        summary: 'Ordner anlegen',
        description: 'Wie in der App: mit Ordner-Notiz (z. B. `index.md`), weil Git keine leeren Ordner kennt. Name wird bei Bedarf eindeutig gemacht.',
        parameters: [sourceId],
        requestBody: { required: true, ...json({ type: 'object', required: ['name'], properties: { parent: { ...str, description: 'Ordner, leer = oberste Ebene' }, name: str } }) },
        responses: { 200: ok({ type: 'object', properties: { sourceId: str, path: str, folderNote: str } }), ...errors },
      },
    },
    '/attachments/{sourceId}': {
      post: {
        summary: 'Datei zu einer Notiz hochladen',
        description:
          'Legt die Datei in `assets/` neben der Notiz ab (wie in der App: Größen-Einstellung, ausführbare Typen gesperrt, in verschlüsselten Notizen/Ordnern abgelehnt, gleicher Name bekommt eine Nummer). Inhalt als `contentBase64` oder bei Textformaten (SVG, CSV …) als `contentText`, höchstens 10 MB. Die Notiz selbst bleibt unverändert – `markdown` ist der fertige Link zum Einfügen.',
        parameters: [sourceId],
        requestBody: {
          required: true,
          ...json({ type: 'object', required: ['note', 'name'], properties: { note: { ...str, description: 'Pfad der Notiz (.md)' }, name: { ...str, description: 'Dateiname mit Endung' }, contentBase64: str, contentText: str } }),
        },
        responses: {
          200: ok({ type: 'object', properties: { sourceId: str, path: str, href: str, name: str, size: { type: 'integer' }, image: { type: 'boolean' }, markdown: str } }),
          ...errors,
        },
      },
    },
    '/attachments/{sourceId}/{path}': {
      get: {
        summary: 'Anhänge einer Notiz',
        description: 'Dateien, auf die die Notiz verlinkt, mit Größe; `size: null` = verlinkte Datei fehlt.',
        parameters: [sourceId, notePath],
        responses: { 200: ok({ type: 'array', items: { type: 'object', properties: { path: str, name: str, size: { type: ['integer', 'null'] }, kind: { enum: ['image', 'pdf', 'file'] } } } }), 404: errors[404] },
      },
    },
    '/changes': {
      get: {
        summary: 'Änderungen seit einem Stand (für Agenten)',
        description:
          'Was sich in lesbaren Notizen geändert hat, mit wem (`by`: Name, wie ihn der Server kennt; `null` = von außen, z. B. Git-Push) und auf welchem Weg (`via`). Ohne `after` nur der aktuelle `cursor` als Startpunkt; danach mit `after=<cursor>` abfragen und den neuen `cursor` merken. `wait` wartet bis zu 50 Sekunden auf die erste Änderung (Long Polling). Eigene Änderungen nur mit `own=true`. `reset: true`: Stand zu alt oder Server neu gestartet – einmal neu lesen.',
        parameters: [
          { name: 'after', in: 'query', schema: str, description: 'Cursor aus der vorigen Antwort' },
          { name: 'source', in: 'query', schema: str, description: 'nur diese Quelle (ID)' },
          { name: 'path', in: 'query', schema: str, description: 'nur diese Notiz bzw. alles unter diesem Ordner' },
          { name: 'wait', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 50 }, description: 'Sekunden auf die erste Änderung warten' },
          { name: 'own', in: 'query', schema: { type: 'boolean' }, description: 'auch eigene Änderungen' },
        ],
        responses: { 200: ok(ref('Changes')), 404: errors[404] },
      },
    },
    '/status': {
      get: {
        summary: 'Abgleich-Status der Quellen',
        description: 'Letzter Abgleich und sein Ergebnis, Änderungen, die noch auf ihren Commit warten (`pendingEdits`), Stand gegenüber dem Remote (`git`), und ob man abgleichen darf.',
        parameters: [{ name: 'source', in: 'query', schema: str, description: 'nur diese Quelle (ID)' }],
        responses: { 200: ok({ type: 'array', items: ref('Status') }), 404: errors[404] },
      },
    },
    '/sync/{sourceId}': {
      post: {
        summary: 'Jetzt abgleichen',
        description: 'Committet wartende Änderungen sofort und gleicht Git-Quellen ab (holen, rebase, pushen). Braucht Schreibrecht. `result` ist bei Ordner-Quellen `null`.',
        parameters: [sourceId],
        responses: {
          200: ok({
            type: 'object',
            properties: {
              sourceId: str,
              result: {
                type: ['object', 'null'],
                properties: { status: { enum: ['up-to-date', 'synced', 'conflict', 'error'] }, incoming: { type: 'integer' }, pushed: { type: 'integer' }, conflictFiles: { type: 'array', items: str } },
              },
              status: ref('Status'),
            },
          }),
          ...errors,
        },
      },
    },
    '/move/{sourceId}': {
      post: {
        summary: 'Umbenennen / verschieben (auch in eine andere Quelle)',
        parameters: [sourceId],
        requestBody: { required: true, ...json({ type: 'object', required: ['from', 'to'], properties: { from: str, to: { ...str, description: 'neuer Pfad inkl. Name' }, toSourceId: str } }) },
        responses: { 200: ok(ref('Moved')), 409: { description: 'Am Ziel gibt es schon einen Eintrag mit diesem Namen', ...json(ref('Error')) }, ...errors },
      },
    },
    '/copy/{sourceId}': {
      post: {
        summary: 'Kopieren (Notiz oder Ordner)',
        description: 'Gleicher Name im Zielordner, bei Bedarf „(Kopie)“. Jede Kopie bekommt eine neue id.',
        parameters: [sourceId],
        requestBody: { required: true, ...json({ type: 'object', required: ['from'], properties: { from: str, toParent: str, toSourceId: str } }) },
        responses: { 200: ok(ref('Moved')), ...errors },
      },
    },
    '/backlinks/{sourceId}/{path}': {
      get: {
        summary: 'Notizen, die auf diese verlinken',
        parameters: [sourceId, notePath],
        responses: { 200: ok({ type: 'array', items: { type: 'object', properties: { path: str, name: str, title: str, count: { type: 'integer' } } } }), 404: errors[404] },
      },
    },
    '/history/{sourceId}/{path}': {
      get: {
        summary: 'Versionen aus der Git-Historie',
        parameters: [sourceId, notePath],
        responses: { 200: ok({ type: 'object', properties: { git: { type: 'boolean' }, versions: { type: 'array', items: ref('Version') } } }), 404: errors[404] },
      },
    },
    '/version/{sourceId}/{path}': {
      get: {
        summary: 'Inhalt einer älteren Version',
        parameters: [sourceId, notePath, { name: 'commit', in: 'query', required: true, schema: str }],
        responses: { 200: ok({ type: 'object', properties: { sourceId: str, path: str, commit: str, markdown: { type: ['string', 'null'] } } }), 404: errors[404] },
      },
    },
  },
} as const;

/** Every operation can fail like any other (bad input, no or wrong token, missing right, not visible): listed everywhere. */
export const openapi = {
  ...spec,
  paths: Object.fromEntries(
    Object.entries(spec.paths).map(([path, ops]) => [
      path,
      Object.fromEntries(Object.entries(ops).map(([method, op]) => [method, { ...op, responses: { ...errors, ...op.responses } }])),
    ]),
  ),
};
