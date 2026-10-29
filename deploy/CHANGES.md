# Kaveyl Wiki – Changes

What each release changes for people who run Kaveyl Wiki. The newest release is at the top; notes under
“Upgrade notes” need attention before updating. Installation and updating: `INSTALLATION.md`.

## 0.2.8 (Beta) – 2026-10-29

The first release published on GitHub: source code under the AGPL-3.0 and the image `ghcr.io/kaveyl/wiki`. To install,
take `docker-compose.yml` and follow `INSTALLATION.md` (both attached below). Everything Kaveyl Wiki can do is listed at
https://kaveyl.app/features/; the changes of earlier versions follow further down in `CHANGES.md`.

### Upgrade notes
- **From 0.2.3 to 0.2.7:** replace the image and restart. No database change.
- **From 0.2.2 or older:** the database is updated on start (v24, see 0.2.3) – take a database backup first.

### Fixed
- **Sidebar width on touch screens:** the divider between sidebar and note now follows a finger as well (for example on
  an unfolded phone or a tablet in landscape) and has a wider grip; with the keyboard it moves with the arrow keys.

## 0.2.7 (Beta) – 2026-10-29

### Upgrade notes
- **From 0.2.3 to 0.2.6:** replace the image and restart. No database change.
- Keep `restart: unless-stopped` in `docker-compose.yml` (as in the template): restoring a database in the first-run
  setup ends Kaveyl Wiki once so that Docker starts it again.
- **From 0.2.2 or older:** the database is updated on start (v24, see 0.2.3) – take a database backup first.

### What's new
- **New server from a backup:** the first-run setup has **New server? Restore from a backup** – upload the database
  backup (the ZIP from the folder `kaveyl-wiki-datenbank` on a backup target, with its backup password, or a
  `kaveyl-wiki.db`), Kaveyl Wiki checks it and restarts with all accounts, permissions, sources and backup targets.
- **Backup targets find their backups again:** a new target is searched for the backups already lying there, and
  **Search** does it later – after a target was removed and added again, or on a new server. Backups of a folder without
  a source of that name come back with **Save as**.
- **Restore** at every backup brings the whole source back; a local folder with versions also gets its history back.
- A target used by a schedule can be removed together with the schedule (the confirmation names it).
- A backup that the target's current backup password does not open asks for the password it was made with.

### Changed
- **Very large notes:** the server parses Markdown in a separate process with a time and memory limit, and notes over
  256 KB not at all. Such a note (or one nested too deeply) opens in the Markdown view, and its links do not count for
  “Linked from” and the link check. The import converts in a separate process too.
- “All tokens” (AI & APIs) opens in the normal size again; only the permissions grid widens the settings window.

### Fixed
- A crafted note (deeply nested lists or quotes, many brackets in one paragraph) could keep the server busy for
  minutes or end it.
- Deleting a backup that had already been removed from the SMB share by hand failed.
- Import: a Trilium export in HTML format brings formulas and footnotes; a Wiki.js Git storage gives the same folders as
  the disk dump; Wiki.js tag links become text; names from Mac ZIPs are written in the usual Unicode form and Markdown
  links find targets written differently or in other upper/lower case; Outline keeps `[TOC]`/`{%…%}` as written.

## 0.2.6 (Beta) – 2026-10-28

### Upgrade notes
- **From 0.2.3, 0.2.4 or 0.2.5:** replace the image and restart. No database change.
- **From 0.2.2 or older:** the database is updated on start (v24, see 0.2.3) – take a database backup first.
- A reverse proxy in front of Kaveyl Wiki must let uploads of up to 500 MB through for the import (see 0.2.5).

### What's new
- **Import ▸ From another program …** knows four more programs:
  - **Obsidian** (the vault folder): `[[links]]` also relative and with `?`/`#`/`%` in names, embeds, callouts of all
    types, comments, highlights, inline tags; `.obsidian` and the trash stay out.
  - **Trilium** (Export → Markdown): the tree with Trilium's titles, pictures, attachments, embedded notes, footnotes,
    code and Mermaid notes, labels as properties; protected notes are named in the report.
  - **Wiki.js** 2.x (“Dump all content to disk” or the Git storage): titles, languages, files, tags, callouts, links by
    Wiki.js's rules; visual-editor and HTML pages become Markdown.
  - **Outline** (Markdown or OKF export): collections, nested documents, icons, dates, files once, notices, toggles.
- A note of an import that has child notes becomes the page of its folder.
- A Trilium export in HTML format is taken too, with a note that the Markdown export keeps formulas and footnotes.

### Fixed
- Import: crafted or very large exports no longer keep the import busy for minutes (several patterns were quadratic);
  one import makes at most 20,000 notes and files.
- Import from Wiki.js leaves the hidden `.git` folder of a Git storage out (it may hold the remote's password).
- Import: links whose address would run code are found in every way of writing them (entities, escapes, titles,
  definitions in quotes) and lose the address.
- Import: two folders of the same title (Trilium, Wiki.js) stay apart; Wiki.js links that led nowhere in Wiki.js no
  longer land on a page of another language; Obsidian links in tables (`[[Name\|Text]]`) and files with Windows line
  ends are converted; a docs folder with GitHub alerts (`> [!NOTE]`) is no longer taken for an Obsidian vault; pictures
  in list items, hard line breaks, picture descriptions with numbers and titles like “Plan v1.2” stay as they were.

## 0.2.5 (Beta) – 2026-10-28

### Upgrade notes
- **From 0.2.4:** replace the image and restart. No database change.
- **From 0.2.2 or older:** the database is updated on start (v24, see 0.2.3) – take a database backup first.
- A reverse proxy in front of Kaveyl Wiki must let uploads of up to 500 MB through for the new import (otherwise “Too
  large for the server”).

### What's new
- **Import ▸ From another program …** (right-click a folder or source): upload another program's export as a ZIP (up to
  500 MB), check the preview (format, counts, notes on links that cannot be matched), then everything goes into a new
  folder with an “Import report” note – one version in sources with versions. Formats:
  - **HedgeDoc** 1.x (“Export user data”); the pictures, which the export lacks, can be fetched from the old server.
  - **Joplin** (“Markdown + Front Matter”): notebooks, pictures, attachments, tags, to-do state; web-clipper HTML notes
    become Markdown.
  - **Logseq** 0.10.x (the graph folder): pages, journals, namespaces, properties, tasks; block references become links.
  - **SilverBullet** (the space folder): pages, pictures, `[[links]]`; Lua and queries stay as text.
  - A zipped **Markdown folder**: structure, pictures and `[[wiki links]]` are kept.
- The conversion runs apart from the server, with limits on time and memory: a huge or broken export cannot slow
  down or stop Kaveyl Wiki for others.

### Fixed
- Links to notes or files whose name contains `#`, `?` or `%` (“Meeting #3”) are written correctly when notes are
  moved or renamed.
- Note names from titles with several special characters in a row no longer get “ - - ” (“Weight - Backpack”).

## 0.2.4 (Beta) – 2026-10-28

### Upgrade notes
- **From 0.2.3:** replace the image and restart. No database change.
- **From 0.2.2:** the database is updated on start (v24, see 0.2.3) – take a database backup first.
- **Ctrl+click in the tree now marks** a note or folder (as in a file explorer). To open in a new tab, use the middle
  mouse button or right-click → “Open in new tab”. Under Favorites and Recent, Ctrl+click still opens a new tab.

### What's new
- **Mark several notes and folders** in the tree: Ctrl/Cmd+click, Shift+click for a range, on touch “Select” with
  boxes. A bar above the tree and the right-click menu offer: send by e-mail, give access by e-mail, move, export as one
  ZIP (Markdown or HTML), delete into the trash.
- **Share ▸ Send by e-mail …:** a note (or several) as a `.md` attachment – a ZIP when it has pictures or files – to
  any address, for people without an account. No links; replies go to the sender. Anyone who may read the note may
  send it (not guests, never encrypted notes); at most 30 addresses per hour and person, 200 per instance. Greyed out without e-mail
  sending. The log records who sent what to whom.
- **Share ▸ Give access by e-mail …** is the former “Share by e-mail …”; it also takes several marked items at once.
- **Import ▸ Markdown files …** on a folder or source: `.md` files from the computer become notes there, never over an
  existing one (“Name 2”).
- **All tokens** moved next to the API tokens: Settings → AI & APIs → **All tokens** (was Users & permissions →
  Tokens).
- **Copy account id** (fingerprint) per account under Users – for an agent's list of who may release actions.

## 0.2.3 (Beta) – 2026-10-28

### Upgrade notes
- **From 0.2.2:** replace the image (`0.2.3`) and restart. The database is updated on start (v24: who made a token);
  going back to 0.2.2 needs the database backup taken before the update (Settings → Backup → Database → “Back up now”).

### What's new
- **Tokens for others (admins):** Settings → Users & permissions → **Tokens** lists every API token of every person –
  renew or delete them there – and makes a token for someone, e.g. the account of an AI agent, without signing in as
  them. The token can do at most what the person may. The person sees “made by” and the admin's name in their own list;
  the log records who made, renewed or deleted which token for whom.
- **Renew a token:** a new value with the same name, permissions and validity; the old value stops working at once.
  “Revoke” is now called **Delete** – that is what it does.
- **Initial password without forced change:** when creating an account or setting a new password, untick “Must be
  changed at the first sign-in” – for accounts of agents, or when the person may keep the password.
- **Download button** in the note's header, next to the width: the note as `.md` – as a ZIP with its pictures or files
  when it uses any. Export ▸ “Markdown” of a single note works the same way (before: always a ZIP).
- **Wider settings for “Permissions” and “Tokens”:** the window grows almost to the full width, so many sources fit
  side by side.

### Fixed
- The commit text counts only Markdown files as notes: a note with a picture saved through MCP says “1 Notiz und 1
  Datei bearbeitet” instead of “2 Notizen bearbeitet”.

## 0.2.2 (Beta) – 2026-10-27

### Upgrade notes
- **From 0.2.1:** replace the image (`0.2.2`) and restart – the database stays as it is, no new steps.

### Fixed
- **Trash of sources with versions** (repositories and local folders with versions): a note deleted in the app is in
  the trash at once. Before, the trash stayed empty until the next commit (after the pause, 2 minutes by default) – and
  a note created and deleted again within that pause never reached the history and could not be brought back. Now its
  latest state is committed before it goes, and the deletion right after.
- **Deleting a folder** no longer counts the folder's own page as a note in it: a new, empty folder asks
  “… really delete?” instead of “… and 1 note in it”.

## 0.2.1 (Beta) – 2026-10-26

### Upgrade notes
- **From 0.2.0:** replace the image (`0.2.1`) and restart – the database stays as it is, no new steps. Local folders added
  before keep working as before (files only); “Edit source …” → “Turn on versions …” gives them versions.
- If a local folder of yours is your own Git repository with a filter, diff or merge driver or an `include` entry in its
  `.git/config` (e.g. after `git lfs install --local`), Kaveyl Wiki no longer runs Git there and says why in the source's log.

### What's new
- **Local folders with versions:** when you add a local folder, “Keep versions” (on by default) gives it a Git of its
  own – versions, the trash from the history and who changed what, like a repository but without syncing. Changes by
  other programs on the folder (e.g. through a NAS share) become versions too. Folders added before: “Edit source …” →
  “Turn on versions …”. Backups carry the history along; a folder unpacked from a backup gets it back. A change by
  another program that comes in while someone saves in the app becomes a version of its own (by “Kaveyl Wiki”), not
  one under that person's name; an executable bit set by a share is no change. A folder Kaveyl Wiki may not write
  into is refused with a clear message instead of an internal error.
- **New folder …** in the wizard's folder browser: one folder per wiki without a terminal. An empty folder can now be
  added (before, “Next” stayed grey).
- **Folder owner:** the template has a commented line `user: "1000:100"` – for folders that belong to another user (e.g.
  on a NAS); see `INSTALLATION.md`. Git now also works in folders of another owner and never runs hooks from a folder.
- The hint for webhooks to an address on your own network names Gitea 28's new place for the setting:
  `ALLOWED_HOST_LIST` under `[security]` (before Gitea 28: `[webhook]`); the manual also explains `EGRESS_MODE = lax`.
- **Security:** Git never starts a program from a folder's own settings – hooks and file-system monitors are switched
  off, signing is off, and a repository whose `.git/config` holds a filter, diff/merge driver, `include` or `core.worktree`
  is refused. Plain text that another program puts into an encrypted folder does not go into the versions.
- REST API: `GET /api/v1/status` – `git.upstream` is `null` for a local folder with a Git of its own (documented now).

## 0.2.0 (Beta) – 2026-10-26

**First beta.** The feature set is complete; bugs are still possible – back up your data regularly and report what you
find. The version shows as “0.2.0 Beta” under Settings → Help. The first version without “Beta” will be 1.0.0.

### Upgrade notes
- **From 0.1.3:** back up `kaveyl-wiki/config`, then update as described in `INSTALLATION.md`. The database is updated
  automatically on the first start (three new steps for following and notifications); there is no way back to 0.1.3
  without that backup.
- **From a version before 0.1.3:** set up afresh as described for 0.1.3 below – your notes stay in Git or in their folders.
- **Template `docker-compose.yml`:** port 8093 is now reachable in your network by default (`"8093:8000"`);
  `"127.0.0.1:8093:8000"` is the option for a reverse proxy on the same Docker host. The `TRUST_PROXY` example has
  sample addresses to replace with your own. An existing `docker-compose.yml` keeps working unchanged.

### Working together
- Changes reach everyone at once: when someone saves – in the browser, through the REST API, MCP or a Git push – every
  open editor shows it immediately, and your cursor, focus and scroll position stay where they were.
- Starting to type in a note someone else is editing asks once first (“Maria Chen is editing this note right now …”);
  nothing is locked.
- The conflict notice has “Merge”: changes in different places of the same note are brought together with one click;
  for the same place you choose a version as before.
- Several people editing in the same commit pause now each get their own commit; files edited together name the others
  as co-authors, and the version history shows them.
- Renaming, moving or deleting a note someone has open: their tab follows a move (what they type lands at the new place),
  a deletion is shown at once with “Save as a new note …”.
- Moving a folder into another source takes its images along instead of leaving an `assets/` folder behind.
- MCP: new tool `copy_note`; `read_note` (and `GET /api/v1/notes/…`) tell in `editingNow` who is typing in the note.

### Diagrams
- Mermaid diagrams use Kaveyl Wiki's colours in light and dark mode: timelines, mind maps, pie charts and Git graphs
  get clear, friendly colours, and the first line of a chart is no longer almost invisible.

### Agents and following
- Follow a note, folder or source (right-click → Follow …): a dot in the sidebar and “New for you” until you open it,
  and/or bundled e-mail and Pushover (your own Pushover user key under Settings → Account → Follow).
- Events for agents: `GET /api/v1/changes` and MCP `list_changes` tell what changed and who did it (long polling);
  admins can add event webhooks that send signed batches of changes right away, with the rights of one person.
- Fixed: a file the app had just written and that was renamed or deleted outside right after stayed in the tree.
- New: `examples/incident-agent` – an example agent that turns server warnings into incident notes and runs a fixed
  action only when someone allowed to release it ticks the box (dry run by default, no dependencies).
- Manual: new chapter “Working as a team” (a walk-through of two people on one note, who changed what, following,
  agents in the team with set-up steps), and a Python example for waiting for changes in the API reference.

### Notifications
- Settings → Account → Follow → **How often?**: bundled (after 2 minutes), at most hourly, or once a day at a time you
  choose. Admins set how many messages a person gets per day at most (default 100). Limits now delay messages instead of
  dropping them – the next message brings everything; waiting messages survive a restart or update.
- Following moves along when a followed note or folder is moved or renamed, and so does the path filter of event
  webhooks; removing a source clears its follows and switches its event webhooks off.
- Many changes at once (e.g. a large Git sync) no longer hold up the server while people follow notes.
- A note saved many times waits as one message (its newest state) instead of one per save.

### Push webhooks (instant sync)
- Own address for webhooks under Settings → Sources → Webhooks (FQDN or IP, `http` or `https`); empty = the public address.
- Connections → **Set up webhook** asks only when there is something to do and says exactly what happens; at Gitea you
  choose between one webhook per added repository or one for your whole account. New webhooks are called “Kaveyl Wiki”.
- The row below a connection shows only the webhooks that really exist at the provider, each with its own remove
  button; webhooks of another Kaveyl Wiki instance (e.g. a test server on the same Gitea) are shown but never changed.
- The help has two pictures that show what is synced when, in every direction.

### Sources and attachments
- Blocked file endings for attachments are a list the admin can edit (Settings → Attachments).
- Adding an empty repository (no commit yet) says so and offers “Check again” instead of a greyed-out “Next”.
- “Remove” in Edit source is red, the question is short, and for repositories it names the cleanup rule for the local copy.
- “Copy path” puts the source name in front.

### Editor and help
- Headings 1–3 in the selection menu.
- Typing or pasting a file name like `Notes.md` no longer turns it into a web link; the slash menu finds commands by
  any word (e.g. “/heading 2”); spaces at the edge of bold or italic text no longer end up as `&#x20;` in the file.
- The help search keeps the search term and the hits; the example agent can be downloaded from the help.

### Fixes
- After a restart, notes were no longer all reported as “changed from outside” (dots, e-mails, webhooks).
- Co-authors are named per file, not per commit; copies no longer show the versions of the original.
- Invitations and e-mails to accounts with language “Automatic” use the language last shown to that person.

### Security
- Live updates no longer tell users about changes in sources or folders they cannot read (empty tree events).
- The default list of blocked file endings for attachments also has `.js`, `.jse`, `.msix`, `.appx`, `.iso`, `.img`,
  `.chm`, `.url`, `.sh` and `.command`. If an admin has saved the list before, it stays as it is – Settings →
  Attachments → “Default list” takes the new one.
- E-mails and Pushover messages about a move name the old place only if you may read it; the same for `/api/v1/changes`
  and event webhooks.
- “Test Pushover” is limited to 3 per hour per account.
- Display names can no longer contain line breaks or control characters (they could add made-up co-authors to commits),
  nor invisible characters such as right-to-left overrides that make a name look like another one.
- Deleting an account also deletes its Pushover key, the secrets of its event webhooks and the invitations it sent
  that nobody has accepted yet.
- An incoming push webhook with a malformed signature is rejected and logged like any other wrong signature.

## 0.1.3 – 2026-10-22

First public release.

### What Kaveyl Wiki is
- A self-hosted wiki whose only storage is Git: notes are plain Markdown files in any number of repositories (Gitea,
  GitHub, GitLab, any Git URL) or folders, synchronised in both directions with your editor, `git` or other tools.
  Nothing is overwritten silently; conflicts are shown and resolved in the app.
- Editor that shows formatting directly, or the Markdown source; tables, formulas, diagrams, drawings, callouts,
  templates, tags, links with automatic repair, backlinks, instant search and a command palette.
- Versions and trash for every note, repository trash, nightly consistency check, backups to a folder or an SMB share
  (optionally encrypted), restore by comparing.
- Accounts with invitations, groups, guests, permissions per source, folder and note (shown as a grid), sharing of
  notes, folders and sources by e-mail, encrypted notes and folders.
- Sign-in with a password, or through Cloudflare Access or Authentik in front of Kaveyl Wiki.
- AI assistant (Ollama, Ollama Cloud, OpenAI-compatible providers) that only suggests – you decide; REST API and MCP
  for scripts and AI tools with the same permissions as the person behind the token.
- Notifications to admins by e-mail and/or Pushover; a hint at the top right when a new version is out.
- Interface and in-app manual in English and German.
- Runs in any browser and can be installed as an app on phones, tablets and computers – no download needed.
- Free software under the GNU Affero General Public License v3.0; the licences of all third-party components are in
  `THIRD-PARTY-NOTICES.txt` (in the package, in the image and served by every installation).

### Upgrade notes
- None – this is the first public release. Set it up fresh as described in `INSTALLATION.md`.
