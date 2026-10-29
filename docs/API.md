# Kaveyl Wiki – REST-API und MCP-Server

> **Stand:** 2026-10-15 · API-Version 1.
> Für Benutzer ohne Programmierbezug reicht das Kapitel „API und MCP“ im
> [Benutzerhandbuch](BENUTZERHANDBUCH.md#api-und-mcp-claude-hermes-skripte).

Kaveyl Wiki lässt sich von außen auf zwei Wegen lesen und ändern:

| Weg | Adresse | Für |
|---|---|---|
| **REST-API v1** | `http://<host>:8093/api/v1/…` | Skripte, Automationen (n8n, Bash, Python), eigene Apps |
| **MCP-Server** | `http://<host>:8093/mcp` | KI-Clients mit MCP-Unterstützung (Claude, Cursor, VS Code, LM Studio, Hermes …) |

Beide nutzen **dieselbe Schicht** im Server: gleiche Rechte (wie in der App), gleiche Prüfungen,
Änderungen werden mit dem Token-Inhaber als Autor in Git übertragen und im Protokoll vermerkt
(`API: …` bzw. `MCP: …`).

## Inhalt

1. [Anmeldung: API-Tokens](#anmeldung-api-tokens)
2. [Rechte und Grenzen](#rechte-und-grenzen)
3. [REST-API v1](#rest-api-v1)
4. [MCP-Server](#mcp-server)
5. [Ereignisse für Agenten](#ereignisse-für-agenten)
6. [MCP-Clients einrichten](#mcp-clients-einrichten)
7. [Fehler und Fehlersuche](#fehler-und-fehlersuche)

---

## Anmeldung: API-Tokens

Einstellungen → KI & APIs → **API-Tokens** → Name, Rechte und Gültigkeit wählen → „Token erstellen“. Der Token
(`kw_…`) wird **nur einmal** angezeigt; gespeichert wird nur ein Fingerabdruck. Übergabe in jeder
Anfrage als Kopfzeile:

```
Authorization: Bearer kw_…
```

| Recht (Scope) | erlaubt |
|---|---|
| `read` (lesen) | alle lesenden REST-Aufrufe und die lesenden MCP-Werkzeuge (`write` und `admin` schließen Lesen ein; ein Token nur mit `mcp` liest nichts) |
| `write` (schreiben) | zusätzlich ändern, anlegen, verschieben, kopieren, löschen; bei MCP die schreibenden Werkzeuge |
| `mcp` | den MCP-Endpunkt `/mcp` überhaupt (ohne `mcp` antwortet er mit 403) |
| `admin` (verwalten, nur Admins) | wie `write`; Quellen, die der Inhaber verwalten darf, stehen dann mit `access: "admin"` in der Liste. Eigene Verwaltungs-Routen hat Version 1 derzeit nicht |

Ein Token handelt **im Namen seines Inhabers** und hat höchstens dessen Rechte. Tokens gelten **nur**
für die REST-API (`/api/v1/…`), den MCP-Endpunkt (`/mcp`) und das Abrufen von Dateien
(`GET /api/files/…`, z. B. Bilder einer Notiz) – Einstellungen, Quellen, Benutzer und Tokens gibt es nur
mit Anmeldung im Browser (sonst 403). Gesperrte Benutzer und ein vom Administrator neu gesetztes
Passwort: alle Tokens der Person sofort ungültig.

Tipp: pro Werkzeug einen eigenen Token (z. B. „Claude Code Laptop“, „n8n Backup“) – so lässt sich
einer einzeln löschen oder erneuern (neuer Wert, gleiche Rechte). Für ein Agenten-Konto legt ein Administrator den
Token unter Einstellungen → KI & APIs → Alle Tokens an, ohne sich als Agent anzumelden.

## Rechte und Grenzen

- **Berechtigungen** (Einstellungen → Benutzer & Rechte → Rechte, Rechtsklick → Berechtigungen) gelten genau
  wie in der App: Unsichtbares gibt es nicht (404, fehlt in Suche und Baum), nur Leserecht heißt 403
  beim Schreiben.
- **Verschlüsselte Notizen** liefern nur Name und Titel, nie Inhalt (`markdown: null`). Schreiben
  von Klartext in eine verschlüsselte Notiz lehnt der Server ab.
- **Konflikte:** Schreiben verlangt den `hash` aus dem Lesen (`baseHash`). Hat sich die Datei
  inzwischen geändert (App, VS Code, Git), kommt **409** mit dem aktuellen Stand – nichts wird
  überschrieben. Wer die Notiz gerade in der App offen hat, sieht eine geschriebene Änderung sofort;
  tippt die Person gerade selbst, bekommt sie den Konflikt-Hinweis (mit „Zusammenführen“). Ob jemand
  tippt, steht beim Lesen in `editingNow`.
- **Löschen** (REST und MCP) verschiebt in den Papierkorb der Quelle; zurückholen in der App.
  Bei einem Ordner werden nur die Notizen gelöscht, andere Dateien (Bilder, Code) bleiben.
- **Versionen kommen gebündelt:** Wie in der App wird nach einer Pause (Standard 2 Minuten, höchstens
  10 Minuten nach der ersten Änderung) committet und abgeglichen. Bis dahin zeigt die Historie die
  Änderung noch nicht; `POST /api/v1/sync/{source}` bzw. `sync_source` erledigt das sofort.
- **Links zwischen Notizen** sind normale Markdown-Links mit Pfad relativ zur verlinkenden Notiz,
  Leerzeichen als `%20`: `[Roadmap](../Projekte/Roadmap.md)`. `[[Wiki-Links]]` erkennt Kaveyl Wiki nicht.
  Verschieben und Umbenennen reparieren Links auf die Notiz.
- **Quellen einbinden/aushängen** und Einstellungen gibt es bewusst nur in der App.
- **Symbolische Links** innerhalb einer Quelle werden nie befolgt – weder beim Lesen noch beim Schreiben
  (wie im Baum, der sie ausblendet). Ein Pfad durch einen Link ergibt 400.
- Begriffe: eine **Quelle** (`source`) ist ein eingebundenes Repository oder ein Ordner; ein
  **Pfad** ist relativ zur Quelle, z. B. `plan/roadmap.md`.

## REST-API v1

Maschinenlesbare Beschreibung (OpenAPI 3.1, ohne Anmeldung abrufbar):
`GET /api/v1/openapi.json` – lässt sich in Postman, Bruno, Insomnia oder Swagger UI importieren.

| Methode und Pfad | Zweck | Recht |
|---|---|---|
| `GET /api/v1/sources` | Quellen (id, Name, Typ, eigene Stufe) | read |
| `GET /api/v1/changes?after=&wait=&source=&path=&own=` | Änderungen seit einem Stand, mit Person und Weg; wartet auf Wunsch ([Ereignisse für Agenten](#ereignisse-für-agenten)) | read |
| `GET /api/v1/tree/{source}?path=&depth=` | Ordner und Notizen, optional unterhalb eines Ordners / begrenzte Tiefe | read |
| `GET /api/v1/search?q=&limit=&source=` | Volltextsuche, mit `source` nur in einer Quelle; Operatoren `"Phrase"`, `-wort`, `tag:x`, `in:"Name"`, `path:ordner/`, `seit:7d`; Treffer in `«…»` | read |
| `GET /api/v1/notes/{source}/{pfad}` | Notiz als Markdown (ganze Datei inkl. Frontmatter) + `hash`; `editingNow`: wer sie gerade in der App bearbeitet | read |
| `PUT /api/v1/notes/{source}/{pfad}` | ganze Datei ersetzen: `{"markdown", "baseHash"}` | write |
| `POST /api/v1/notes/{source}` | anlegen: `{"parent", "title", "markdown"?}` – Dateiname aus dem Titel | write |
| `DELETE /api/v1/notes/{source}/{pfad}` | Notiz oder Ordner löschen (in den Papierkorb) | write |
| `POST /api/v1/folders/{source}` | Ordner anlegen: `{"parent", "name"}` – mit Ordner-Notiz (`index.md`), Git kennt keine leeren Ordner | write |
| `POST /api/v1/move/{source}` | umbenennen/verschieben: `{"from", "to", "toSourceId"?}` – Links werden repariert | write |
| `POST /api/v1/copy/{source}` | kopieren: `{"from", "toParent", "toSourceId"?}` – bei Bedarf „(Kopie)“ | write |
| `GET /api/v1/backlinks/{source}/{pfad}` | Notizen, die hierher verlinken | read |
| `GET /api/v1/history/{source}/{pfad}` | Versionen aus Git (commit, Datum, Autor, Betreff, Pfad damals) | read |
| `GET /api/v1/version/{source}/{pfad}?commit=` | Inhalt einer älteren Version | read |
| `POST /api/v1/attachments/{source}` | Datei hochladen: `{"note", "name", "contentBase64" \| "contentText"}` – nach `assets/` neben der Notiz, höchstens 10 MB, Antwort mit fertigem `markdown`-Link | write |
| `GET /api/v1/attachments/{source}/{pfad}` | Dateien, auf die die Notiz verlinkt (Größe, `null` = fehlt) | read |
| `GET /api/v1/status?source=` | Abgleich-Status: letzter Abgleich und Ergebnis, wartende Änderungen, Stand zum Remote, `canSync` | read |
| `POST /api/v1/sync/{source}` | jetzt committen und abgleichen (wie „Jetzt abgleichen“) | write |

Pfade mit Leerzeichen oder Umlauten: pro Segment URL-kodieren, die Schrägstriche bleiben
(`/api/v1/notes/<id>/Projekte/M%C3%A4rz%20Plan.md`).

### Beispiele (Bash)

Den Token aus einer Datei oder Umgebungsvariable lesen, nicht in die Befehlszeile schreiben
(sonst steht er in der Shell-Historie und ist per `ps` sichtbar):

```bash
# ~/.kaveyl-wiki.env (chmod 600) enthält: KAVEYL_WIKI_TOKEN=kw_…
set -a; source ~/.kaveyl-wiki.env; set +a
BASE=https://wiki.example.org/api/v1
HDR=$(mktemp); chmod 600 "$HDR"; trap 'rm -f "$HDR"' EXIT
printf 'Authorization: Bearer %s\n' "$KAVEYL_WIKI_TOKEN" > "$HDR"   # printf ist eingebaut: kein Prozess-Argument

# Quellen
curl -s -H @"$HDR" "$BASE/sources"

# Suchen
curl -s -H @"$HDR" "$BASE/search?q=docker%20tag:howto"

# Lesen, ändern, zurückschreiben (mit jq)
SRC=<source-id>
NOTE=$(curl -s -H @"$HDR" "$BASE/notes/$SRC/plan/roadmap.md")
jq '{markdown: (.markdown + "- Neuer Punkt aus dem Skript\n"), baseHash: .hash}' <<<"$NOTE" |
  curl -s -X PUT -H @"$HDR" -H 'content-type: application/json' --data @- "$BASE/notes/$SRC/plan/roadmap.md"
```

### Beispiel (Python)

```python
import os, requests

BASE = "https://wiki.example.org/api/v1"
s = requests.Session()
s.headers["Authorization"] = f"Bearer {os.environ['KAVEYL_WIKI_TOKEN']}"

src = s.get(f"{BASE}/sources").json()[0]["id"]
note = s.get(f"{BASE}/notes/{src}/plan/roadmap.md").json()
r = s.put(f"{BASE}/notes/{src}/plan/roadmap.md",
          json={"markdown": note["markdown"] + "\n- Aus Python\n", "baseHash": note["hash"]})
if r.status_code == 409:
    print("Inzwischen geändert – neu lesen und zusammenführen:", r.json()["currentHash"])
```

### Antworten und Fehler

Fehler kommen immer als `{"error": "…"}`, für Menschen lesbar – in der Sprache der Anfrage (`Accept-Language`, z. B. `en`), sonst deutsch:

| Status | Bedeutung |
|---|---|
| 400 | Anfrage unvollständig/ungültig (z. B. `baseHash fehlt`, fehlender Body, Body ist kein JSON-Objekt, Pfad außerhalb der Quelle) |
| 401 | kein oder ungültiger/abgelaufener Token |
| 403 | Recht fehlt (Scope des Tokens oder Leserecht in Kaveyl Wiki) |
| 404 | gibt es nicht – oder du darfst es nicht sehen |
| 409 | Konflikt: Datei inzwischen geändert (`currentHash`, `currentRaw`) bzw. Ziel existiert schon |

Versionierung: `/api/v1` bleibt stabil; brechende Änderungen kommen nur unter `/api/v2`.

## MCP-Server

Das **Model Context Protocol** ist ein offener Standard – der Server ist nicht an Claude gebunden.
Kaveyl Wiki spricht **Streamable HTTP** in der zustandslosen Form: jede Anfrage ist ein `POST` auf
`/mcp` mit einer JSON-RPC-Nachricht, die Antwort ist JSON. Unterstützte Protokollversionen:
2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05. Nicht angeboten: Server-Sent Events (`GET /mcp`
→ 405), Sitzungen, Ressourcen, Prompts, OAuth (Anmeldung nur per Token-Kopfzeile).

### Werkzeuge

| Werkzeug | Zweck | braucht `write` |
|---|---|---|
| `list_sources` | Quellen mit ids – Startpunkt | |
| `search` | Volltextsuche mit Operatoren, optional nur in einer Quelle (`source_id`), Treffer mit Ausschnitt | |
| `list_tree` | Ordner und Notizen einer Quelle (optional ab Ordner, Tiefe) | |
| `read_note` | Notiz als Markdown + `hash`; `editingNow` nennt, wer gerade in der App darin tippt | |
| `write_note` | ganze Notiz ersetzen (mit `base_hash` aus `read_note`) | ✓ |
| `create_note` | neue Notiz in einem Ordner (fehlende Ordner entstehen mit) | ✓ |
| `create_folder` | neuer Ordner, mit Ordner-Notiz | ✓ |
| `move_note` | umbenennen/verschieben (auch in andere Quelle), Links werden repariert | ✓ |
| `copy_note` | Notiz oder Ordner (mit Bildern) kopieren, auch in eine andere Quelle – bei Bedarf „(Kopie)“ | ✓ |
| `delete_note` | Notiz oder Ordner in den Papierkorb | ✓ |
| `upload_file` | Bild oder Datei (Base64 oder Text, z. B. SVG) nach `assets/` neben der Notiz, liefert den fertigen Markdown-Link | ✓ |
| `list_changes` | Änderungen seit einem Stand (mit Person), wartet auf Wunsch – für Agenten, die auf Menschen reagieren | |
| `list_attachments` | Dateien, auf die eine Notiz verlinkt (mit Größe; fehlende mit `null`) | |
| `get_backlinks` | Rückverweise | |
| `get_history` | Versionen aus Git | |
| `read_version` | Inhalt einer älteren Version | |
| `get_sync_status` | Abgleich-Status der Quellen (letzter Abgleich, Fehler/Konflikt, wartende Änderungen) | |
| `sync_source` | jetzt committen und abgleichen | ✓ |

Lesende Werkzeuge sind als `readOnlyHint` markiert – viele Clients fragen dann bei ihnen nicht
jedes Mal nach; `delete_note` ist als `destructiveHint` markiert, `sync_source` als `openWorldHint`
(spricht mit dem Git-Server). Fehler (keine Berechtigung, Konflikt, nicht gefunden) kommen als
normales Werkzeug-Ergebnis mit `isError`, damit das Modell darauf reagieren kann (z. B. neu lesen) –
in der Sprache der Anfrage (`Accept-Language`), sonst deutsch. Die Werkzeugbeschreibungen und die
Anleitung beim Verbinden (`instructions`: Pfade, Linkformat, Commit-Pause und eine Kurzreferenz des
Kaveyl-Wiki-Markdowns – Hinweis-Boxen, Aufklappblöcke, Formeln, Mermaid, Frontmatter mit Tags und Icon, Bilder)
sind englisch, weil sie sich an das Modell richten.

## Ereignisse für Agenten

Ein Agent, der auf Menschen reagieren soll – etwa auf eine abgehakte Checkbox in einer Notiz, die er selbst angelegt
hat –, muss erfahren, **was** sich geändert hat und **wer** es war. Dafür gibt es zwei Wege; beide liefern nur, was das
Konto des Agenten lesen darf, und lassen seine eigenen Änderungen weg.

**1. Nachfragen (Long Polling):** `GET /api/v1/changes` bzw. das MCP-Werkzeug `list_changes`. Der erste Aufruf ohne
`after` liefert nur einen `cursor` (den Startpunkt). Danach mit `after=<cursor>` fragen und den neuen `cursor` aus jeder
Antwort aufheben; `wait=50` wartet bis zu 50 Sekunden auf die erste Änderung, statt leer zu antworten (mehr als 50 geht
nicht, größere Werte gelten als 50). `source` und `path` grenzen auf eine Quelle bzw. eine Notiz oder einen Ordner ein,
`own=true` liefert auch die eigenen Änderungen. Beim MCP-Werkzeug heißen die Angaben `after`, `source_id`, `path`,
`wait_seconds` und `include_own`.

```json
{
  "cursor": "3f9c1a2b-42",
  "reset": false,
  "changes": [
    { "sourceId": "01J…", "path": "Vorfälle/Platte voll.md", "kind": "changed", "at": "2026-10-23T09:12:03.120Z",
      "by": "Maria Chen", "byId": "01J…", "via": "app" }
  ]
}
```

`kind` ist `created`, `changed`, `deleted` oder `moved` (dann mit `from`). `by` ist die Person, wie der Server sie
kennt – nicht, was jemand in die Notiz geschrieben hat; `null` heißt „von außen“ (Git-Push, ein Programm im Ordner).
`via` sagt den Weg: `app`, `api`, `mcp` oder `extern`. `reset: true` bedeutet: der Cursor war zu alt oder Kaveyl Wiki
wurde neu gestartet – dann das Beobachtete einmal neu lesen und mit dem neuen Cursor weitermachen.

**2. Ereignis-Webhooks:** Ein Admin legt unter Einstellungen → KI & APIs → **Ereignis-Webhooks** eine Adresse an. Kaveyl
Wiki schickt Änderungen dorthin, sobald sie passieren (gebündelt je Sekunde):

```http
POST /kaveyl HTTP/1.1
Content-Type: application/json
X-Kaveyl-Event: changes
X-Kaveyl-Delivery: 6f1c…
X-Kaveyl-Signature: sha256=9b2e…

{"event":"changes","hook":"01J…","name":"Server-Agent","changes":[{"sourceId":"01J…","source":"Server","path":"Vorfälle/Platte voll.md","kind":"changed","at":"…","by":"Maria Chen","byId":"01J…","via":"app"}]}
```

Der Empfänger prüft die Signatur: HMAC-SHA256 des **unveränderten** Inhalts mit dem Geheimnis, als Hex – in Node etwa
`crypto.createHmac('sha256', secret).update(rawBody).digest('hex')`, in Python
`hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()`, verglichen mit `timingSafeEqual` bzw.
`hmac.compare_digest`. „Testen“ schickt `{"event":"ping"}`. Antwortet der Empfänger nicht mit 2xx, versucht Kaveyl
Wiki es noch dreimal (nach 10 Sekunden, 1 und 5 Minuten); kommen fünf Lieferungen in Folge auch so nicht an, ist der
Webhook aus. Die Adresse muss von Kaveyl Wiki aus erreichbar sein – läuft es in Docker, ist `127.0.0.1` der Container
selbst.

**Muster: Meldung und Antwort in einer Notiz.** Der Agent legt eine Notiz an (z. B. in „Vorfälle“, den das Team
beobachtet – Handbuch, „Beobachten“), mit Befund und Vorschlägen als Checkboxen:

```markdown
# Platte /var fast voll (web-01)

Belegt: 95 % · seit 09:10 · Quelle: syslog

- [ ] Alte Logs löschen (älter als 14 Tage)
- [ ] Dienst nginx neu starten

Antwort hier drunter – der Agent liest mit.
```

Kommt eine Änderung an dieser Notiz, liest der Agent sie (`read_note`), sieht nach, welche Checkbox neu abgehakt ist, und
prüft **`by`** im Ereignis: Nur wenn die Person das entscheiden darf, handelt er – und nur mit fest erlaubten Aktionen,
nie mit Befehlen aus dem Notiztext. Das Ergebnis schreibt er in die Notiz (`write_note` mit dem `hash`). Tippt gerade
jemand in der Notiz (`editingNow` beim Lesen), wartet er besser kurz; der offene Editor übernimmt die Änderung dann von
selbst.

**Beispiel (Python): auf Änderungen warten.** Der Cursor gehört in eine Datei, damit ein Neustart nichts verliert:

```python
import os, requests

BASE = "https://wiki.example.org/api/v1"
SOURCE, FOLDER = "<Quellen-ID>", "Vorfälle"
APPROVERS = {"01J…"}                              # byId der Personen, die freigeben dürfen
s = requests.Session()
s.headers["Authorization"] = f"Bearer {os.environ['KAVEYL_WIKI_TOKEN']}"

def changes(**extra):
    return s.get(f"{BASE}/changes", params={"source": SOURCE, "path": FOLDER, **extra}, timeout=70).json()

cursor = changes()["cursor"]                      # Start: nur der Cursor
while True:
    page = changes(after=cursor, wait=50)         # wartet bis zu 50 s auf die erste Änderung
    for c in page["changes"]:
        ok = c["byId"] in APPROVERS               # None = von außen: nie eine Freigabe
        print(c["kind"], c["path"], c["by"], c["via"], "darf freigeben" if ok else "keine Freigabe")
    if page["reset"]:
        print("reset: alles Beobachtete neu lesen, nichts ausführen")
    cursor = page["cursor"]                       # aufheben (Datei) – ein Neustart verliert dann nichts
```

Die ID einer Person (`byId`) steht in jedem Ereignis, das sie auslöst – ein Agent kann sie beim ersten Mal ins
Protokoll schreiben, dann trägt man sie in seine Liste ein.

**Worauf es ankommt** (so hat es auch der Test mit mehreren Agenten und einer KI gezeigt):

- **Nur die Aktionen dieses Vorfalls.** Hakt jemand eine bekannte Aktion ab, die der Agent für diese Notiz gar nicht
  vorgeschlagen hat (selbst dazugeschrieben), führt er sie nicht aus.
- **Alle Änderungen seit dem letzten Mal zählen.** Hat zwischen zwei Abfragen neben Maria auch Tom an der Notiz
  geändert, lässt sich nicht sagen, wer den Haken gesetzt hat – dann nicht handeln, sondern um erneutes Abhaken bitten.
  Dasselbe gilt bei `reset`.
- **Eins nach dem anderen.** Schreibt der Agent aus mehreren Gründen in dieselbe Notiz (neue Warnung, Antwort, Ergebnis),
  dann nacheinander, jeweils mit frisch gelesenem `hash`; bei einem Konflikt neu lesen.
- **Ein eigenes Konto je Agent,** das nur dort schreiben darf, wo er berichtet. Seine eigenen Änderungen kommen in
  den Ereignissen nicht vor (außer mit `own=true`), er reagiert also nicht auf sich selbst.
- **Eine KI über MCP** bekommt für den Server nur lesende Werkzeuge. Ausführen soll ein fester Agent nach einer
  Freigabe durch einen Menschen; ein Haken der KI zählt dort nicht – auch nicht, wenn sie sich überreden lässt.

Ein vollständiges Beispiel (Node.js, ohne weitere Pakete) bringt Kaveyl Wiki mit –
[agent.mjs](/hilfe/beispiele/incident-agent/agent.mjs) und [Anleitung](/hilfe/beispiele/incident-agent/README.md), im
Quellcode unter `examples/incident-agent`: Warnungen
aus dem Syslog werden zu Vorfall-Notizen, Haken von freigabeberechtigten Personen zu festen Aktionen, Zeilen
„Question:“ bekommen eine Antwort; mit oder ohne Ereignis-Webhook, zuerst im Trockenlauf. Einrichtung des Kontos und
der Rechte: Handbuch, [Agenten im Team](BENUTZERHANDBUCH.md#agenten-im-team).

## MCP-Clients einrichten

Für alle gilt: Token mit **MCP** anlegen (und **schreiben**, wenn der Client ändern soll). Adresse
`http://<host>:8093/mcp`, Kopfzeile `Authorization: Bearer kw_…`. Der Reiter API-Tokens zeigt nach dem
Erstellen den Befehl für Claude Code und eine allgemeine JSON-Konfiguration zum Kopieren.

Achtung: Die folgenden Konfigurationsdateien enthalten den Token im Klartext – nur im eigenen
Benutzerprofil ablegen, nicht in ein Git-Repository einchecken.

**Claude Code** (Terminal):

```bash
claude mcp add --transport http kaveyl-wiki https://wiki.example.org/mcp --header "Authorization: Bearer kw_…"
```

Damit der Token nicht in der Shell-Historie landet, kann man ihn vorher verdeckt einlesen:
`read -rs KAVEYL_WIKI_TOKEN` (Token einfügen, Enter) und dann `--header "Authorization: Bearer $KAVEYL_WIKI_TOKEN"`.

**Cursor** (`~/.cursor/mcp.json`) und andere Clients mit dem verbreiteten `mcpServers`-Format, die
HTTP-Server mit Kopfzeilen unterstützen (z. B. LM Studio `mcp.json`):

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

**VS Code** (Copilot-Agent, `.vscode/mcp.json` oder Benutzer-Einstellungen):

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

**Claude Desktop** und Clients, die nur lokale (stdio-)Server starten können: über die Brücke
`mcp-remote` (braucht Node.js; läuft Kaveyl Wiki im eigenen Netz ohne HTTPS, z. B. unter `http://server:8093`, kommt
`--allow-http` dazu):

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

**Hermes und andere Agenten:** in deren MCP-Konfiguration einen Server vom Typ „HTTP“ /
„Streamable HTTP“ mit obiger Adresse und Kopfzeile eintragen. Clients, die nur das alte
HTTP+SSE-Verfahren (2024) kennen, verbinden sich über `mcp-remote` wie bei Claude Desktop.

**Andere Modell-Anbieter:** Ob Claude, GPT, Gemini, Llama oder Qwen dahinterstecken, ist egal –
entscheidend ist, dass der **Client** MCP spricht. Reine API-Aufrufe an ein Modell (ohne MCP-Client)
nutzen stattdessen die REST-API oder den eingebauten KI-Assistenten (Einstellungen → KI).

## Fehler und Fehlersuche

| Symptom | Ursache / Abhilfe |
|---|---|
| 401 „MCP nur mit API-Token“ | Kopfzeile fehlt oder Cookie statt Token benutzt – MCP geht nur mit `Authorization: Bearer` |
| 403 „Token ohne Recht „mcp““ | Token ohne Scope MCP – neuen Token mit „MCP“ anlegen |
| Werkzeug meldet „kein Schreibrecht“ | Token ohne „schreiben“, oder in Kaveyl Wiki nur Leserecht auf dem Ziel |
| 403 „Origin nicht erlaubt“ | Aufruf aus einer fremden Webseite im Browser – nur Clients außerhalb des Browsers oder dieselbe Adresse |
| Client findet keine Werkzeuge / will OAuth | Client kann keine Kopfzeilen bei HTTP-Servern → über `mcp-remote` anbinden |
| Konflikt beim Schreiben | Datei wurde inzwischen geändert – neu lesen, zusammenführen, mit neuem `hash` schreiben |
| Notiz „nicht gefunden“, obwohl sie existiert | fehlendes Leserecht (Kaveyl Wiki verrät nicht, ob es sie gibt) oder Pfad falsch kodiert |

Jeder Zugriff mit Änderung steht unter Einstellungen → Werkzeuge → Protokoll (Art „Sicherheit“, `api-…` /
`mcp-…`); „zuletzt benutzt“ eines Tokens zeigt die Token-Liste.
