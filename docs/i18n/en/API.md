# Kaveyl Wiki – REST API and MCP server

> **As of:** 2026-10-15 · API version 1.
> For users without a programming background, the chapter “API and MCP” in the
> [user manual](BENUTZERHANDBUCH.md#api-und-mcp-claude-hermes-skripte) is enough.

Kaveyl Wiki can be read and changed from outside in two ways:

| Way | Address | For |
|---|---|---|
| **REST API v1** | `http://<host>:8093/api/v1/…` | scripts, automations (n8n, Bash, Python), your own apps |
| **MCP server** | `http://<host>:8093/mcp` | AI clients with MCP support (Claude, Cursor, VS Code, LM Studio, Hermes …) |

Both use **the same layer** in the server: the same permissions (as in the app), the same checks;
changes are committed to Git with the token owner as author and recorded in the log
(`API: …` or `MCP: …`).

## Contents {#inhalt}

1. [Authentication: API tokens](#anmeldung-api-tokens)
2. [Permissions and limits](#rechte-und-grenzen)
3. [REST API v1](#rest-api-v1)
4. [MCP server](#mcp-server)
5. [Events for agents](#ereignisse-für-agenten)
6. [Setting up MCP clients](#mcp-clients-einrichten)
7. [Errors and troubleshooting](#fehler-und-fehlersuche)

---

## Authentication: API tokens {#anmeldung-api-tokens}

Settings → AI & APIs → **API tokens** → choose name, permissions and validity → “Create token”. The token
(`kw_…`) is shown **only once**; only a fingerprint is stored. Pass it in every
request as a header:

```
Authorization: Bearer kw_…
```

| Permission (scope) | allows |
|---|---|
| `read` (read) | all reading REST calls and the reading MCP tools (`write` and `admin` include reading; a token with only `mcp` reads nothing) |
| `write` (write) | in addition changing, creating, moving, copying, deleting; with MCP the writing tools |
| `mcp` | the MCP endpoint `/mcp` at all (without `mcp` it answers with 403) |
| `admin` (manage, admins only) | like `write`; sources the owner may manage then appear in the list with `access: "admin"`. Version 1 currently has no administration routes of its own |

A token acts **on behalf of its owner** and has at most their permissions. Tokens apply **only**
to the REST API (`/api/v1/…`), the MCP endpoint (`/mcp`) and fetching files
(`GET /api/files/…`, e.g. images of a note) – settings, sources, users and tokens are only available
when signed in in the browser (otherwise 403). Disabled users and a password newly set by the administrator:
all of the person’s tokens become invalid immediately.

Tip: one token per tool (e.g. “Claude Code Laptop”, “n8n Backup”) – that way
each can be deleted or renewed (new value, same permissions) individually. For an agent's account an administrator
makes the token under Settings → AI & APIs → All tokens, without signing in as the agent.

## Permissions and limits {#rechte-und-grenzen}

- **Permissions** (Settings → Users & permissions → Permissions, right-click → Permissions …) apply exactly
  as in the app: what is invisible does not exist (404, missing from search and tree), read access only means 403
  when writing.
- **Encrypted notes** only return name and title, never content (`markdown: null`). The server refuses
  writing plain text into an encrypted note.
- **Conflicts:** writing requires the `hash` from reading (`baseHash`). If the file has changed
  in the meantime (app, VS Code, Git), you get **409** with the current state – nothing is
  overwritten. Whoever has the note open in the app sees a written change at once; if that person
  is typing themselves, they get the conflict notice (with “Merge”). Whether someone is typing is in
  `editingNow` when reading.
- **Deleting** (REST and MCP) moves to the source’s trash; restore in the app.
  For a folder, only the notes are deleted; other files (images, code) stay.
- **Versions come bundled:** as in the app, changes are committed and synced after a pause (default 2 minutes, at most
  10 minutes after the first change). Until then, the history does not show the
  change yet; `POST /api/v1/sync/{source}` or `sync_source` does it straight away.
- **Links between notes** are normal Markdown links with a path relative to the linking note,
  spaces as `%20`: `[Roadmap](../Projekte/Roadmap.md)`. Kaveyl Wiki does not recognise `[[Wiki-Links]]`.
  Moving and renaming repair links to the note.
- **Adding/detaching sources** and settings are deliberately only available in the app.
- **Symbolic links** within a source are never followed – neither when reading nor when writing
  (as in the tree, which hides them). A path through a link results in 400.
- Terms: a **source** (`source`) is an added repository or a folder; a
  **path** is relative to the source, e.g. `plan/roadmap.md`.

## REST API v1 {#rest-api-v1}

Machine-readable description (OpenAPI 3.1, available without authentication):
`GET /api/v1/openapi.json` – can be imported into Postman, Bruno, Insomnia or Swagger UI.

| Method and path | Purpose | Permission |
|---|---|---|
| `GET /api/v1/sources` | sources (id, name, type, own level) | read |
| `GET /api/v1/changes?after=&wait=&source=&path=&own=` | changes since a point, with person and way; waits on request ([Events for agents](#ereignisse-für-agenten)) | read |
| `GET /api/v1/tree/{source}?path=&depth=` | folders and notes, optionally below a folder / limited depth | read |
| `GET /api/v1/search?q=&limit=&source=` | full-text search, with `source` only in one source; operators `"phrase"`, `-word`, `tag:x`, `in:"Name"`, `path:folder/`, `since:7d`; matches in `«…»` | read |
| `GET /api/v1/notes/{source}/{path}` | note as Markdown (whole file incl. frontmatter) + `hash`; `editingNow`: who is editing it in the app right now | read |
| `PUT /api/v1/notes/{source}/{path}` | replace the whole file: `{"markdown", "baseHash"}` | write |
| `POST /api/v1/notes/{source}` | create: `{"parent", "title", "markdown"?}` – file name from the title | write |
| `DELETE /api/v1/notes/{source}/{path}` | delete note or folder (into the trash) | write |
| `POST /api/v1/folders/{source}` | create folder: `{"parent", "name"}` – with folder note (`index.md`), Git knows no empty folders | write |
| `POST /api/v1/move/{source}` | rename/move: `{"from", "to", "toSourceId"?}` – links are repaired | write |
| `POST /api/v1/copy/{source}` | copy: `{"from", "toParent", "toSourceId"?}` – “(Kopie)” if needed | write |
| `GET /api/v1/backlinks/{source}/{path}` | notes that link here | read |
| `GET /api/v1/history/{source}/{path}` | versions from Git (commit, date, author, subject, path at the time) | read |
| `GET /api/v1/version/{source}/{path}?commit=` | content of an older version | read |
| `POST /api/v1/attachments/{source}` | upload a file: `{"note", "name", "contentBase64" \| "contentText"}` – into `assets/` next to the note, at most 10 MB, response with a ready-made `markdown` link | write |
| `GET /api/v1/attachments/{source}/{path}` | files the note links to (size, `null` = missing) | read |
| `GET /api/v1/status?source=` | sync status: last sync and result, pending changes, state relative to the remote, `canSync` | read |
| `POST /api/v1/sync/{source}` | commit and sync now (like “Sync now”) | write |

Paths with spaces or umlauts: URL-encode each segment, the slashes stay
(`/api/v1/notes/<id>/Projekte/M%C3%A4rz%20Plan.md`).

### Examples (Bash) {#beispiele-bash}

Read the token from a file or environment variable, do not write it into the command line
(otherwise it ends up in the shell history and is visible via `ps`):

```bash
# ~/.kaveyl-wiki.env (chmod 600) contains: KAVEYL_WIKI_TOKEN=kw_…
set -a; source ~/.kaveyl-wiki.env; set +a
BASE=https://wiki.example.org/api/v1
HDR=$(mktemp); chmod 600 "$HDR"; trap 'rm -f "$HDR"' EXIT
printf 'Authorization: Bearer %s\n' "$KAVEYL_WIKI_TOKEN" > "$HDR"   # printf is a builtin: no process argument

# Sources
curl -s -H @"$HDR" "$BASE/sources"

# Search
curl -s -H @"$HDR" "$BASE/search?q=docker%20tag:howto"

# Read, change, write back (with jq)
SRC=<source-id>
NOTE=$(curl -s -H @"$HDR" "$BASE/notes/$SRC/plan/roadmap.md")
jq '{markdown: (.markdown + "- New item from the script\n"), baseHash: .hash}' <<<"$NOTE" |
  curl -s -X PUT -H @"$HDR" -H 'content-type: application/json' --data @- "$BASE/notes/$SRC/plan/roadmap.md"
```

### Example (Python) {#beispiel-python}

```python
import os, requests

BASE = "https://wiki.example.org/api/v1"
s = requests.Session()
s.headers["Authorization"] = f"Bearer {os.environ['KAVEYL_WIKI_TOKEN']}"

src = s.get(f"{BASE}/sources").json()[0]["id"]
note = s.get(f"{BASE}/notes/{src}/plan/roadmap.md").json()
r = s.put(f"{BASE}/notes/{src}/plan/roadmap.md",
          json={"markdown": note["markdown"] + "\n- From Python\n", "baseHash": note["hash"]})
if r.status_code == 409:
    print("Changed in the meantime – read again and merge:", r.json()["currentHash"])
```

### Responses and errors {#antworten-und-fehler}

Errors always come as `{"error": "…"}`, readable for humans – in the language of the request (`Accept-Language`, e.g. `en`), otherwise German:

| Status | Meaning |
|---|---|
| 400 | request incomplete/invalid (e.g. `baseHash missing`, missing body, body is not a JSON object, path outside the source) |
| 401 | no token, or an invalid/expired one |
| 403 | permission missing (scope of the token or read access in Kaveyl Wiki) |
| 404 | does not exist – or you are not allowed to see it |
| 409 | conflict: file changed in the meantime (`currentHash`, `currentRaw`) or the target already exists |

Versioning: `/api/v1` stays stable; breaking changes only come under `/api/v2`.

## MCP server {#mcp-server}

The **Model Context Protocol** is an open standard – the server is not tied to Claude.
Kaveyl Wiki speaks **Streamable HTTP** in the stateless form: each request is a `POST` to
`/mcp` with a JSON-RPC message, the response is JSON. Supported protocol versions:
2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05. Not offered: Server-Sent Events (`GET /mcp`
→ 405), sessions, resources, prompts, OAuth (authentication only via the token header).

### Tools {#werkzeuge}

| Tool | Purpose | needs `write` |
|---|---|---|
| `list_sources` | sources with ids – starting point | |
| `search` | full-text search with operators, optionally only in one source (`source_id`), matches with excerpt | |
| `list_tree` | folders and notes of a source (optionally from a folder, depth) | |
| `read_note` | note as Markdown + `hash`; `editingNow` names who is typing in it in the app right now | |
| `write_note` | replace the whole note (with `base_hash` from `read_note`) | ✓ |
| `create_note` | new note in a folder (missing folders are created along with it) | ✓ |
| `create_folder` | new folder, with folder note | ✓ |
| `move_note` | rename/move (also into another source), links are repaired | ✓ |
| `copy_note` | copy a note or folder (with its images), also into another source – “(Kopie)” when needed | ✓ |
| `delete_note` | note or folder into the trash | ✓ |
| `upload_file` | image or file (Base64 or text, e.g. SVG) into `assets/` next to the note, returns the ready-made Markdown link | ✓ |
| `list_changes` | changes since a point (with the person), waits on request – for agents that react to people | |
| `list_attachments` | files a note links to (with size; missing ones with `null`) | |
| `get_backlinks` | backlinks | |
| `get_history` | versions from Git | |
| `read_version` | content of an older version | |
| `get_sync_status` | sync status of the sources (last sync, error/conflict, pending changes) | |
| `sync_source` | commit and sync now | ✓ |

Reading tools are marked as `readOnlyHint` – many clients then do not ask
every time for them; `delete_note` is marked as `destructiveHint`, `sync_source` as `openWorldHint`
(talks to the Git server). Errors (no permission, conflict, not found) come as a
normal tool result with `isError`, so that the model can react to them (e.g. read again) –
in the language of the request (`Accept-Language`), otherwise German. The tool descriptions and the
instructions on connecting (`instructions`: paths, link format, commit pause and a short reference of
Kaveyl Wiki Markdown – callouts, collapsible blocks, formulas, Mermaid, frontmatter with tags and icon, images)
are in English because they are addressed to the model.

## Events for agents {#ereignisse-für-agenten}

An agent that should react to people – for example to a ticked checkbox in a note it created itself – has to learn
**what** changed and **who** did it. There are two ways; both deliver only what the agent’s account may read and leave
out its own changes.

**1. Asking (long polling):** `GET /api/v1/changes` or the MCP tool `list_changes`. The first call without `after`
returns only a `cursor` (the starting point). Then ask with `after=<cursor>` and keep the new `cursor` from each answer;
`wait=50` waits up to 50 seconds for the first change instead of answering empty (50 is the most; larger values count
as 50). `source` and `path` narrow it to a source or a note or folder, `own=true` also returns your own changes. In the
MCP tool the parameters are called `after`, `source_id`, `path`, `wait_seconds` and `include_own`.

```json
{
  "cursor": "3f9c1a2b-42",
  "reset": false,
  "changes": [
    { "sourceId": "01J…", "path": "Incidents/Disk full.md", "kind": "changed", "at": "2026-10-23T09:12:03.120Z",
      "by": "Maria Chen", "byId": "01J…", "via": "app" }
  ]
}
```

`kind` is `created`, `changed`, `deleted` or `moved` (then with `from`). `by` is the person as the server knows them –
not what someone wrote into the note; `null` means “from outside” (a Git push, a program in the folder). `via` tells the
way: `app`, `api`, `mcp` or `extern`. `reset: true` means: the cursor was too old or Kaveyl Wiki restarted – read what
you watch once more and go on with the new cursor.

**2. Event webhooks:** An admin adds an address under Settings → AI & APIs → **Event webhooks**. Kaveyl Wiki sends
changes there as they happen (bundled per second):

```http
POST /kaveyl HTTP/1.1
Content-Type: application/json
X-Kaveyl-Event: changes
X-Kaveyl-Delivery: 6f1c…
X-Kaveyl-Signature: sha256=9b2e…

{"event":"changes","hook":"01J…","name":"Server agent","changes":[{"sourceId":"01J…","source":"Server","path":"Incidents/Disk full.md","kind":"changed","at":"…","by":"Maria Chen","byId":"01J…","via":"app"}]}
```

The receiver checks the signature: HMAC-SHA256 of the **unchanged** body with the secret, as hex – in Node for example
`crypto.createHmac('sha256', secret).update(rawBody).digest('hex')`, in Python
`hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()`, compared with `timingSafeEqual` or
`hmac.compare_digest`. “Test” sends `{"event":"ping"}`. If the receiver does not answer with 2xx, Kaveyl Wiki tries
three more times (after 10 seconds, 1 and 5 minutes); when five deliveries in a row do not arrive even so, the webhook
is switched off. The address must be reachable from Kaveyl Wiki – if it runs in Docker, `127.0.0.1` is the container
itself.

**Pattern: report and answer in one note.** The agent creates a note (e.g. in “Incidents”, which the team follows –
manual, “Following”), with the finding and suggestions as checkboxes:

```markdown
# Disk /var almost full (web-01)

Used: 95 % · since 09:10 · source: syslog

- [ ] Delete old logs (older than 14 days)
- [ ] Restart the nginx service

Answer below – the agent is reading along.
```

When this note changes, the agent reads it (`read_note`), looks which checkbox was newly ticked and checks **`by`** in
the event: only if that person may decide it does it act – and only with actions allowed in advance, never with commands
from the note text. It writes the result into the note (`write_note` with the `hash`). If someone is typing in the note
right now (`editingNow` when reading), it had better wait a moment; the open editor then takes the change over by itself.

**Example (Python): waiting for changes.** The cursor belongs in a file, so that a restart loses nothing:

```python
import os, requests

BASE = "https://wiki.example.org/api/v1"
SOURCE, FOLDER = "<source id>", "Incidents"
APPROVERS = {"01J…"}                              # byId of the people who may release
s = requests.Session()
s.headers["Authorization"] = f"Bearer {os.environ['KAVEYL_WIKI_TOKEN']}"

def changes(**extra):
    return s.get(f"{BASE}/changes", params={"source": SOURCE, "path": FOLDER, **extra}, timeout=70).json()

cursor = changes()["cursor"]                      # start: only the cursor
while True:
    page = changes(after=cursor, wait=50)         # waits up to 50 s for the first change
    for c in page["changes"]:
        ok = c["byId"] in APPROVERS               # None = from outside: never a release
        print(c["kind"], c["path"], c["by"], c["via"], "may release" if ok else "no release")
    if page["reset"]:
        print("reset: read everything watched again, run nothing")
    cursor = page["cursor"]                       # keep it (file) – a restart then loses nothing
```

A person’s id (`byId`) is in every event they cause – an agent can write it to its log the first time, and you then
add it to its list.

**What matters** (as the test with several agents and an AI showed):

- **Only this incident’s actions.** If someone ticks a known action the agent did not suggest for this note at all
  (written in by themselves), it does not run it.
- **All changes since last time count.** If Tom changed the note as well as Maria between two queries, nobody can tell
  who set the tick – then do not act but ask for it to be ticked again. The same applies on `reset`.
- **One thing after the other.** If the agent writes into the same note for several reasons (new warning, answer,
  result), then one after the other, each time with a freshly read `hash`; on a conflict, read again.
- **One account per agent,** allowed to write only where it reports. Its own changes do not appear in the events
  (unless `own=true`), so it does not react to itself.
- **An AI via MCP** gets only reading tools for the server. Running things is for a fixed agent after a release by a
  person; a tick by the AI does not count there – not even if it lets itself be talked into it.

A complete example (Node.js, no further packages) comes with Kaveyl Wiki –
[agent.mjs](/hilfe/beispiele/incident-agent/agent.mjs) and [instructions](/hilfe/beispiele/incident-agent/README.md), in
the source code under `examples/incident-agent`: warnings from
the syslog become incident notes, ticks by people allowed to release become fixed actions, lines “Question:” get an
answer; with or without an event webhook, first as a dry run. Setting up the account and the permissions: manual,
[Agents in the team](BENUTZERHANDBUCH.md#agenten-im-team).

## Setting up MCP clients {#mcp-clients-einrichten}

For all of them: create a token with **MCP** (and **write** if the client should make changes). Address
`http://<host>:8093/mcp`, header `Authorization: Bearer kw_…`. After creating a token, the API tokens tab shows
the command for Claude Code and a general JSON configuration to copy.

Caution: the following configuration files contain the token in plain text – only keep them in your own
user profile, do not check them into a Git repository.

**Claude Code** (terminal):

```bash
claude mcp add --transport http kaveyl-wiki https://wiki.example.org/mcp --header "Authorization: Bearer kw_…"
```

So that the token does not end up in the shell history, you can read it in hidden beforehand:
`read -rs KAVEYL_WIKI_TOKEN` (paste the token, Enter) and then `--header "Authorization: Bearer $KAVEYL_WIKI_TOKEN"`.

**Cursor** (`~/.cursor/mcp.json`) and other clients with the common `mcpServers` format that
support HTTP servers with headers (e.g. LM Studio `mcp.json`):

```json
{
  "mcpServers": {
    "kaveyl-wiki": {
      "url": "https://wiki.example.org/mcp",
      "headers": { "Authorization": "Bearer kw_…" }
    }
  }
}
```

**VS Code** (Copilot agent, `.vscode/mcp.json` or user settings):

```json
{
  "servers": {
    "kaveyl-wiki": {
      "type": "http",
      "url": "https://wiki.example.org/mcp",
      "headers": { "Authorization": "Bearer kw_…" }
    }
  }
}
```

**Claude Desktop** and clients that can only start local (stdio) servers: via the bridge
`mcp-remote` (needs Node.js; if Kaveyl Wiki runs on your own network without HTTPS, e.g. at `http://server:8093`,
add `--allow-http`):

```json
{
  "mcpServers": {
    "kaveyl-wiki": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://wiki.example.org/mcp", "--header", "Authorization:${KAVEYL_WIKI_AUTH}"],
      "env": { "KAVEYL_WIKI_AUTH": "Bearer kw_…" }
    }
  }
}
```

**Hermes and other agents:** in their MCP configuration, enter a server of type “HTTP” /
“Streamable HTTP” with the address and header above. Clients that only know the old
HTTP+SSE method (2024) connect via `mcp-remote` as with Claude Desktop.

**Other model providers:** whether Claude, GPT, Gemini, Llama or Qwen is behind it does not matter –
what counts is that the **client** speaks MCP. Plain API calls to a model (without an MCP client)
use the REST API or the built-in AI assistant instead (Settings → AI).

## Errors and troubleshooting {#fehler-und-fehlersuche}

| Symptom | Cause / remedy |
|---|---|
| 401 “MCP only with an API token” | header missing or a cookie used instead of a token – MCP only works with `Authorization: Bearer` |
| 403 “Token without the “mcp” permission” | token without the MCP scope – create a new token with “MCP” |
| Tool reports “no write permission” | token without “write”, or only read access to the target in Kaveyl Wiki |
| 403 “Origin not allowed” | call from a third-party web page in the browser – only clients outside the browser or the same address |
| Client finds no tools / wants OAuth | client cannot send headers to HTTP servers → connect via `mcp-remote` |
| Conflict when writing | the file has been changed in the meantime – read again, merge, write with the new `hash` |
| Note “not found” although it exists | missing read access (Kaveyl Wiki does not reveal whether it exists) or path encoded incorrectly |

Every access that changes something is listed under Settings → Tools → Log (type “Security”, `api-…` /
`mcp-…`); the token list shows a token’s “last used”.
