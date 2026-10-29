---
title: Kaveyl Wiki – User manual
tags: kaveyl-wiki, manual
---

# Kaveyl Wiki – User manual

> Sources and connections (Gitea, GitHub, GitLab, Git, folders), editor, permissions and encryption, REST API and
> MCP, AI assistant with agent, drawings and export, phone and desktop, deletion rules and help in the app.
> This manual is also the **Help in Kaveyl Wiki** (Settings → Help, F1, “?”). The pictures show
> sample data.

## Contents {#inhalt}

1. [What is Kaveyl Wiki?](#was-ist-kaveyl-wiki)
2. [Help in Kaveyl Wiki](#hilfe-in-kaveyl-wiki)
3. [Signing in and the interface](#anmelden-und-oberfläche)
4. [Menus at a glance](#menüs-im-überblick)
5. [Adding sources](#quellen-einbinden)
6. [Finding and reading notes](#notizen-finden-und-lesen)
7. [Editing](#bearbeiten) (with [Markdown cheat sheet](#markdown-spickzettel))
8. [How syncing works](#so-funktioniert-der-abgleich)
9. [Saving, transferring and syncing](#speichern-übertragen-und-synchronisieren)
10. [Creating, renaming, moving, deleting](#anlegen-umbenennen-verschieben-löschen)
11. [Links and “Linked from”](#links-und-verlinkt-von)
12. [Versions and trash](#versionen-und-papierkorb)
13. [Resolving conflicts](#konflikte-auflösen)
14. [Deleting repositories](#repositories-löschen)
15. [Permissions](#berechtigungen)
16. [Accounts, invitations and sharing by e-mail](#konten-einladungen-und-teilen-per-e-mail)
17. [Working as a team](#im-team-arbeiten) (with [Following](#beobachten) and [Agents in the team](#agenten-im-team))
18. [Encrypted notes and folders](#verschlüsselte-notizen-und-ordner)
19. [Settings at a glance](#einstellungen-im-überblick) (with [Backup](#backup))
20. [Access over the network](#zugriff-über-das-netz) (reverse proxy, Pangolin)
21. [Data, log and backups](#daten-protokoll-und-sicherungen) (with [deletion rules](#löschregeln))
22. [AI assistant](#ki-assistent)
23. [API and MCP (Claude, Hermes, scripts)](#api-und-mcp-claude-hermes-skripte)
24. [Keyboard shortcuts](#tastenkürzel)
25. [Troubleshooting](#fehlerbehebung)
26. [Export and print](#exportieren-und-drucken)
27. [In the browser and as an app: phone, tablet, computer](#im-browser-und-als-app-handy-tablet-computer)
28. [Technology and components](#technik-und-komponenten)

---

## What is Kaveyl Wiki? {#was-ist-kaveyl-wiki}

Kaveyl Wiki is a wiki interface for **perfectly ordinary Markdown files** in Git repositories
and folders. There is no separate database for content: what you write in Kaveyl Wiki ends up
as a `.md` file in the repository – and what you change in VS Code, Wiki.js or via `git push`
appears in Kaveyl Wiki. So you can work with both worlds at any time.

Key principles:

- **Your files stay your files.** When saving, Kaveyl Wiki changes only the sections you
  edited; everything else stays exactly as it was, byte for byte (including other people's formatting).
- **Merely opening a note never changes anything.**
- **Nothing is overwritten silently.** If changes happen at the same time, a conflict dialog appears.

How Kaveyl Wiki works together with the Git server and with other editors and devices is explained in
[How syncing works](#so-funktioniert-der-abgleich).

### At a glance {#auf-einen-blick}

**Files instead of a database.** Kaveyl Wiki is a wiki for perfectly ordinary Markdown files – there is
no separate database for content. The notes live in Git repositories (Gitea, GitHub, GitLab or
any Git address) or in folders mounted into the container. Each source appears on the left as
its own tree; the instant search and the command palette (Ctrl+K) find everything.

**Writing and syncing.** You write in an editor that shows the formatting directly, or
in the Markdown source. Saving happens immediately; in repositories Kaveyl Wiki turns this into commits with you as the
author and pushes them. What you change in VS Code, Wiki.js or via git appears in Kaveyl Wiki as well –
nothing is overwritten silently, and Kaveyl Wiki shows conflicts. Every source has Git underneath: repositories sync
with your Git server, local folders keep their versions with a Git of their own on the server.

**Protection and permissions.** Versions, Trash, backups to a NAS or a folder of your own,
link repair and a nightly check protect against loss and broken links. Permissions, groups, guests and encrypted notes control who may see
and change what.

**AI and interfaces.** An AI assistant helps you write and answers questions from
shared notes – it only makes suggestions, you decide. Via the REST API and MCP, scripts and
AI tools such as Claude work along with the same permissions.

Kaveyl Wiki runs as a **Docker container**. What it stores itself (users, settings, log,
backups, local copies of the repositories) lives in the mounted folders `/config` and `/data`;
local folders (notes on this server only) live under `/docs` – see [Data, log and backups](#daten-protokoll-und-sicherungen).

## Help in Kaveyl Wiki {#hilfe-in-kaveyl-wiki}

This manual is fully built into Kaveyl Wiki – with pictures, search and the reference for API and MCP.
This is how you get there:

| Where | What opens |
|---|---|
| **?** at the top right (next to the gear; on the phone in the account menu) | the manual |
| **F1** – everywhere | in a settings area or dialog, the help on exactly that; otherwise the manual |
| **Settings → Help** | at the very top the installed version (admins: also whether a newer one has been released), then what Kaveyl Wiki is, where to find help, and buttons to good starting points |
| **?** at the top right of the settings title bar (next to the ×) | explains every entry of the tab that is currently open |
| **?** in the header of many dialogs (Add source, AI access, Permissions, Trash, Versions …) | the matching place in the manual |
| **?** at the end of the formatting toolbar in the editor | [Editing](#bearbeiten) with the [Markdown cheat sheet](#markdown-spickzettel) |
| **Command palette** (Ctrl+K): “Help”, “Help: Markdown cheat sheet”, “Help: keyboard shortcuts” | the manual at that place |

In the help window, the chapters are on the left (for the selected chapter also its sections), the
text on the right. **Search help** finds words in all chapters and sections. The results stay while you
open one after the other – the open one is marked, **×** clears the search. At the top right you switch
between **Manual** and **API & MCP**. Clicking a picture shows it large, links in the text jump to
the place they name. On narrow screens you choose the chapter from a list at the top.

![Help window](handbuch/91-hilfe.webp)

![Settings → Help](handbuch/92-einstellungen-hilfe.webp)

## Signing in and the interface {#anmelden-und-oberfläche}

Address: that of your Kaveyl Wiki server – on your own network e.g. `http://server:8093`, from outside an
`https://` address (e.g. behind Cloudflare Access). How to make Kaveyl Wiki reachable via your own domain and a reverse proxy:
[Access over the network](#zugriff-über-das-netz).

On the very first start there is no account yet. Instead of the sign-in page, **“Set up Kaveyl Wiki”** appears: there
you create the first administrator account. For this, the page asks for a **setup code**. Kaveyl Wiki writes it
to the container log at startup (`docker logs kaveyl-wiki`, framed by equals signs) and to the file
`setup-code` in the configuration folder. That way nobody who happens to open the address first can take over the instance.
After setup the code expires; if Kaveyl Wiki restarts without an account, there is a new one.

If this is a **new server** for a Kaveyl Wiki instance that existed before, do not create a new account: below the form,
**New server? Restore from a backup** brings the database back – how, see [On a new server](#auf-einem-neuen-server).

![Sign in](handbuch/01-anmelden.webp)

- You sign in with your **e-mail address and password**. The eye in the password field shows what you typed
  in plain text for a moment.
- **Stay signed in:** when ticked, the sign-in lasts 30 days; when not ticked, it ends
  when the browser is closed (after one day at the latest). The device remembers your choice.
- **Forgot password?** below the form: enter your e-mail and you get a link (valid for 30 minutes,
  single use only). Through it you set a new password; all other sign-ins end, and
  a notification e-mail confirms the change. The response is always the same – even for addresses without an
  account. If sending e-mail is not set up, it says there that an administrator has to reset
  the password.
- **Too many failed attempts:** after 10 wrong passwords for the same address (or 30 from one device)
  within 15 minutes, Kaveyl Wiki takes a break and reports “Too many failed attempts” – then even
  the correct password only works again after a few minutes. This slows down password guessing;
  administrators see the incident in the log.
- **Password rules** (for every new password, following the NIST SP 800-63B-4 recommendation): at least **15 characters**
  (at most 256), all characters allowed (including spaces, umlauts, emojis), no requirement for capital letters, digits or
  special characters. A long sentence of several words makes a good password. Rejected is anything that is easy to
  guess: well-known passwords (a built-in list, also with digits or characters before or after them, such as
  “Passwort2026!!!!”), repetitions and sequences such as “aaaa…”, “123456…” or “qwertz…”, your own e-mail address
  and passwords made only of your own name. A list below the field ticks off what is already met. As long as an
  entry is missing, the submit button is disabled; below it you see what is still missing (e.g. “Still missing: Repeat
  password”). If the repetition differs, “Does not match” appears at the field as soon as it is as long as the
  password or you leave the field – the same goes for Change password, Backup password and Passphrase. Existing passwords remain valid – they are checked only when a password is newly set. Anyone who
  signs in with a start password from the administrator must first set their own; nothing else works before that.
- The sign-in page follows **light/dark** from the device setting (or Settings →
  Appearance); on the phone the form sits below a strip of pictures.
- **Language and colour scheme** are at the top right of the sign-in page and in the setup wizard: **DE | EN**
  switches the language, the icon next to it the colour scheme. This way you can also set up Kaveyl Wiki entirely in English.
  Without a choice of your own, the language follows the browser (German browser → German, otherwise
  English). What you choose here is taken over by your account when you sign in.

![Sign in in dark mode](handbuch/81-login-dunkel.webp)

![Sign in on the phone](handbuch/82-login-handy.webp)

![Set a new password (required)](handbuch/43b-passwort-pflicht.webp)

![Interface](handbuch/02-oberflaeche.webp)

- **Left (sidebar):** at the top next to “Kaveyl” the **sync icon**, then ✦ **Ask AI** (if set up),
  **#** Tags and Hide sidebar; below that
  the search, Favourites, “Recent” and every added **source** (repository or folder) as its own tree.
  All menus, entry by entry: [Menus at a glance](#menüs-im-überblick).
- **Top right** in the tab bar – always visible, even with the sidebar collapsed: **?** Help, the
  **gear** (Settings), the **account menu** (person icon: your name and your e-mail address,
  **My account …**, **Sign out**) and the **colour scheme icon** (sun, moon or screen). Each click on it
  moves on: Light → Dark → System (follows the device); the choice stays saved in this browser. On the
  phone, Help and Settings are also in the account menu so that the tabs have room.
- **Top:** tabs of the open notes. The middle mouse button opens in a new tab (under Favorites and
  Recent also Ctrl+click; in the tree Ctrl+click [marks](#mehrere-markieren)). Right-click a tab → **“Pin tab”**: pinned tabs move to the left,
  show a pin instead of ×, are never replaced when you open another note and stay
  open with “Close other tabs” and middle-click. Clicking the pin unpins them again.

![Pinned tabs](handbuch/50-angeheftet.webp)
- **Middle:** the editor with the formatting toolbar. **Right:** the table of contents (for
  longer notes), can be shown and hidden.
- At the top right of the note: **Editor / Markdown** (switch view), switch width
  and the **“…”** menu (Versions, Rename, Delete …).

**Welcome page.** As long as no note is open, the middle shows the welcome page. At the top are the first
steps, matching your role; what is already done is ticked off:

- **Administrators:** Add source, Set up e-mail sending, Set up a reverse proxy with https (done
  as soon as Kaveyl Wiki recognises your request as https – see [Reverse proxy](#reverse-proxy)), Invite people (done
  as soon as there is a second account) and Set up backup (done with an active schedule). Without https,
  passwords and notes travel across the network unencrypted, and without a configured proxy Kaveyl Wiki cannot see who is really
  making the request – the log then only shows the address of the proxy, and the sign-in throttle hits everyone at once.
- **Users:** Find notes (done after the first opened note), Keep favourites (after the first star),
  Adjust appearance, Use Kaveyl Wiki like an app (with the way for your device; done if it is already running as an app
  – see [In the browser and as an app](#im-browser-und-als-app-handy-tablet-computer)).
- **Guests:** open the shared note, Adjust appearance, Use Kaveyl Wiki like an app.

If no source has been shared yet, **“Wait to be given access”** appears instead of “Find notes” – an administrator
shares sources or folders (see [Permissions](#berechtigungen)); the same then also appears in the sidebar. Below that is what Kaveyl Wiki can do: for everyone,
Versions and Trash; for users also the AI assistant, API and MCP, encryption and working with
other editors; for administrators additionally Backup, Notifications and Kaveyl Wiki like an app.
**“Set up”** opens the matching setting, **“Learn more”** the chapter in this manual. As soon as a source
has been added, **“Don’t show again”** hides the page; a short message tells you where to find it again.
You bring it back under Settings → [Help](#hilfe) with **“Show welcome page again”** or in the empty
middle with **“Show welcome page”**. The choice applies to your account on all devices.

![Welcome page for administrators](handbuch/02b-willkommen.webp)

![Welcome page for users](handbuch/02c-willkommen-benutzer.webp)

## Menus at a glance {#menüs-im-überblick}

You reach almost everything by **right-clicking** (on touch devices: **long press**) or via the
note menu **“…”**. What you are not allowed to do (e.g. without write permission) does not appear at all.

### Sidebar header {#kopfzeile-der-seitenleiste}

| Icon | Effect |
|---|---|
| Sync icon | Status of all sources (green = in sync, dot = waiting to be transferred, warning = please take a look, crossed-out cloud = no connection to the server); a click opens the [sync overview](#speichern-übertragen-und-synchronisieren) |
| ✦ Ask AI | [Ask the knowledge base](#frag-die-wissensbasis) about everything shared |
| # Tags | all tags with count and colour; a click shows the notes, right-click colours or renames |
| Hide sidebar | as labelled |
| Next to the search: New …, Expand/collapse all | new note/new folder; expand or collapse all sections and folders |

### Top right {#oben-rechts}

| Icon | Effect |
|---|---|
| ? Help | this manual (also **F1**) |
| Gear | [Settings](#einstellungen-im-überblick) |
| Account menu (person icon) | your name and your e-mail address; **My account …** opens Settings → Account; **Sign out** (asks first if something is still unsaved). On the phone also **Help / manual** and **Settings** |
| Colour scheme | Light → Dark → System |

### Right-clicking a source {#rechtsklick-auf-eine-quelle}

| Entry | Effect |
|---|---|
| New note / New folder | at the top level of the source |
| Paste “…” | what you copied or cut before (Ctrl+V) |
| Import ▸ Markdown files … | `.md` files from your computer as notes at the top level ([Import Markdown](#markdown-importieren)) |
| Import ▸ From another program … | another program’s export (ZIP) as a new folder ([Import from other programs](#aus-anderen-programmen-importieren)) |
| Permissions … | [Permissions](#berechtigungen) for the whole source (admins, “manage”) |
| Share ▸ Give access by e-mail … | [share](#konten-einladungen-und-teilen-per-e-mail) the whole source with someone (admins, “manage”) |
| AI access … | [AI access](#ki-freigaben) and AI memory of the source (admins) |
| Arrange → Move source up / down, Sort top level alphabetically | order in the sidebar or of the top level |
| Sync now | pulls and pushes immediately (repositories) |
| Export ▸ HTML (ZIP) / Markdown (ZIP) | the whole source as web pages or as Markdown files ([Export](#exportieren-und-drucken)) |
| Trash | deleted notes of this source ([Trash](#versionen-und-papierkorb)) |
| Backup ▸ Back up now / Backups and restore … / Schedules … | back up immediately (all active schedules with this source), open its [backups](#sicherungen) or [schedules](#zeitpläne) (admins) |
| Edit source … | [Edit the source](#eine-quelle-bearbeiten): name, icon, options, contents, remove (admins) |
| Delete repository … | Gitea/GitHub/GitLab only, admins ([Deleting repositories](#repositories-löschen)) |

### Right-clicking a folder or a note {#rechtsklick-auf-einen-ordner-oder-eine-notiz}

| Entry | Effect |
|---|---|
| Open in new tab, Open to the right / to the left | note in a new tab (also the middle mouse button) or in the [split view](#notizen-finden-und-lesen) |
| Show only this folder (focus) | the sidebar shows only this folder |
| New note / New folder | inside it (on a note: next to it) |
| Rename / move | name and destination, also into another source; links are repaired |
| Copy, Cut, Paste “…” | Ctrl+C / Ctrl+X / Ctrl+V in the tree |
| Copy path | full path with the source in front (`Source/Folder/Note.md`) to the clipboard |
| Select | [mark several](#mehrere-markieren) – boxes before the rows, a tap marks (for tablet and phone; with a mouse: Ctrl+click) |
| Import ▸ Markdown files … | folders only: `.md` files from your computer as notes into it ([Import Markdown](#markdown-importieren)) |
| Import ▸ From another program … | folders only: another program’s export (ZIP) as a new subfolder ([Import from other programs](#aus-anderen-programmen-importieren)) |
| Export ▸ HTML file, or HTML (ZIP) for a folder, Markdown, or Markdown (ZIP) for a folder | [Export](#exportieren-und-drucken) |
| Restore from backup … | the [backups](#sicherungen) of the source, with this place selected when it opens (admins) |
| Arrange → Move up / Move down, Sort contents alphabetically | order without dragging |
| Add to Favourites / Remove from Favourites | star list at the top of the sidebar |
| Change icon … | icon, emoji or custom icon |
| Encrypt folder … / Finish encrypting folder … / Remove encryption … | [Encryption](#verschlüsselte-notizen-und-ordner) |
| Permissions … | [Permissions](#berechtigungen) for this folder or this note |
| Share ▸ Send by e-mail … | notes only: the note as a file to any address ([Send by e-mail](#per-mail-versenden)); greyed out without e-mail sending and for encrypted notes |
| Share ▸ Give access by e-mail … | [share](#konten-einladungen-und-teilen-per-e-mail) the folder (with everything in it) or the note with someone (“manage”) |
| AI access … | [AI access](#ki-freigaben) exactly here (admins) |
| Delete | to the [Trash](#versionen-und-papierkorb), with a confirmation |

### Note menu “…” and note header {#notiz-menü--und-kopfzeile-der-notiz}

In the header: the note's **icon** (a click changes it), **path** (source / folder / note – in narrow windows
shortened to “…” at the front; a click or tap shows it in full), **star** (favourite), **Editor / Markdown** (labelled
only if there is full room for the note name next to it), **Download** (arrow down: the note as `.md`, as a ZIP when it
uses pictures or files – see [Export](#exportieren-und-drucken); not for encrypted notes), width, table of contents
on/off and **“…”** with:

| Entry | Effect |
|---|---|
| Show in tree | expands the tree down to the note |
| Versions | [Versions](#versionen-und-papierkorb) from the Git history – restore or save as a new note |
| Print / as PDF …, Export ▸ HTML file / Markdown | [Export](#exportieren-und-drucken) |
| Ask AI …, AI: Summarise, AI: Continue writing | only where there is no toolbar (reading mode, Markdown view) – otherwise in the [AI button](#ki-im-editor) |
| Make read-only / Remove read-only | `readonly: true` in the front matter |
| Save as template | turns the note into a [template](#vorlagen) |
| Encrypt … / Remove encryption … / Lock now | [Encryption](#verschlüsselte-notizen-und-ordner) |
| Permissions …, Share ▸ Send by e-mail … / Give access by e-mail … | as in the right-click menu |
| Rename / move, Delete | as in the right-click menu |

### Right-clicking a tab {#rechtsklick-auf-einen-tab}

**Show to the right**, **Show to the left**, **Close split view**, **Pin tab /
Unpin tab**, **Close tab**, **Close other tabs**. The middle mouse button closes a tab.

### Command palette {#befehlspalette}

**Ctrl+K** opens an input field for notes and commands; with `>` at the start, commands only: new note,
new folder, show in tree, favourite, versions, ask AI, tags, search with filters,
sync, print, export, Trash, Settings, **Help**, Add source,
light/dark/system, language, sidebar, table of contents, width.

![Right-clicking a note](handbuch/101-menue-notiz.webp)

## Adding sources {#quellen-einbinden}

“Add source” opens a wizard with four steps.

![Add source](handbuch/03-quelle-einbinden.webp)

1. **Source:**
   - **Gitea**, **GitHub**, **GitLab** – list of your repositories via a
     [connection](#verbindungen). If there is none yet, you set it up right here (address and
     token); if there are several, you choose the connection at the top. With **“New repository”** you create a
     repository directly at the provider (private by default, with a README) and add it straight away.
   - **Git URL** – any HTTPS repository. Under **Sign-in**: none (public), a
     matching connection (same address – it is suggested) or **New token …** (optionally with a
     username); this becomes a connection when the source is added.
   - **Local folder** – for notes that live on this server only: a subfolder of `/docs` that the operator mounts in
     the `docker-compose.yml` (on the server e.g. `./kaveyl-wiki/docs` next to the `docker-compose.yml`).
     **New folder …** creates a subfolder inside the open folder and opens it – for example one per person (“Anna's
     wiki”), without a terminal. With **Keep versions** (the default, see options) the folder gets a Git of its own:
     versions, trash and who changed what, as with a repository, only without syncing to a Git server. If no folder
     is mounted, the wizard explains how to do it. To sync with a Git server (and other devices, VS Code on your PC):
     a repository (Gitea, GitHub, GitLab, Git URL).
2. **Branch** (repositories only). If the repository is still empty (no commit, so no branch either – the provider still names “main”), the step says so: add a file at the provider first (e.g. a README) or create the repository with “New repository”, then **Check again**.
3. **Contents:** a tree with checkboxes – the whole repository, individual folders or individual files.
4. **Options:** name and icon in the sidebar (the same choice as for notes: icons,
   emoji, custom icons; without a choice the sidebar shows the type: **Git branch** for repositories,
   **folder with a Git mark** for local folders with their own Git, **hard disk** for local folders without
   Git – hovering over the name always shows the type, even with a custom icon) as well as:

![New repository](handbuch/04-neues-repository.webp)

![Options](handbuch/05-optionen.webp)

![Local folder: keep versions](handbuch/122-lokaler-ordner-versionen.webp)

| Option | Meaning |
|---|---|
| Keep versions | Only for local folders without Git, **on by default**. Kaveyl Wiki creates a Git of its own in the folder (hidden folder `.git`) and saves every change as a version – with the person as the author; what another program changes there (for example through a share of the NAS) becomes a version as well, with “Kaveyl Wiki” as the author. No push, no pull. Deleted notes stay in the history (as with repositories). Kaveyl Wiki must be allowed to write into the folder (owner, see `user:` in `docker-compose.yml`), otherwise it says so when adding the source. Off = files only, without versions; later by right-clicking the source → “Edit source …” → **Turn on versions …**. |
| Commit (and push) changes automatically | Default for repositories, always on for folders with **Keep versions**. Off in local folders with a Git of your own (for example a project you work on in VS Code): Kaveyl Wiki only writes the files, you do the committing yourself. **Local folders without Git** do not have this option – there, files are only saved. |
| When to write your changes to Git? | Pause after the last change before committing/pushing: 10 s, **2 min (default)**, 5 or 15 min. Always immediately when you leave the note and with Ctrl+S. |
| Write metadata to the front matter | New notes get an `id:` – this lets Kaveyl Wiki recognise them even after they are renamed in VS Code. Off = files never get metadata. |
| Read-only | Read only; no editing, creating or deleting in Kaveyl Wiki. |
| Folder note | File shown as the content of its folder (`index.md`, with Wiki.js often `home.md`). |
| AI memory | Send along the AI's instructions and memory entries in `.kaveyl-wiki/ai/` of this source (only effective if the source is shared with the AI). |
| Keep AI chats | How long unused [AI chats](#chats-und-aufbewahrung) about this source (its notes, folders or the whole source) are kept: **as in Settings → AI** (default 90 days), 7 / 30 / 90 / 180 days, 1 year or never delete – e.g. shorter for a diary. |

### Editing a source {#eine-quelle-bearbeiten}

You edit or **remove** a source (admins) by right-clicking its name → “Edit
source …”. For repositories you can also switch the **connection** there (e.g. to another
account with the same address). In addition: **Paused** (hidden; for repositories also no sync), the
glob patterns **Include / Exclude** and “Select again in the tree …” – these apply to every source,
including local folders: they determine which files and folders appear in Kaveyl Wiki. **Remove** (red, bottom left)
only takes it out of Kaveyl Wiki; the **AI access and permissions of this source** are removed along with it (they would
no longer apply anywhere). Where the files stay:
- **Repository:** unchanged at the provider. The local copy on the server becomes an “orphaned copy” and is saved as a
  Git backup and deleted according to the cleanup rule (Settings → Tools → [Cleanup](#aufräumen), default 30 days). To
  delete the repository **for good**, do not remove the source but right-click it → [Delete repository …](#repositories-löschen)
  (Gitea, GitHub, GitLab) – that removes the source as well. If it is already removed, delete the repository at the
  provider yourself.
- **Local folder:** folder and files stay where they are – with versions including their history (`.git` in the
  folder). Kaveyl Wiki never deletes a local folder by itself, because it is the original; it is only gone when you
  delete it on the server.
Confirmations such as “Discard unsaved input?” or “… delete?” appear in a Kaveyl Wiki window: **Esc** or
“Keep editing”/“Cancel” leaves everything as it was.

![Editing a source: options with “Keep AI chats”](handbuch/103-quelle-bearbeiten.webp)

### Connections {#verbindungen}

You manage access credentials for repositories in one place: **Settings → Sources →
Connections** (first tab; next to it **Added sources** with the list, “Add source” and the
repository trash). A connection is an account with **Gitea**, **GitHub** (github.com or
Enterprise), **GitLab** (gitlab.com or your own instance) or **Git (generic)** (any HTTPS server,
optionally with a username). Several connections – including several Gitea instances – are possible.

![Connections](handbuch/70-verbindungen.webp)

- **Add connection** (below the list): choose the type, address (prefilled for GitHub/GitLab), optionally a name,
  token. Which permissions the token needs is stated directly below the field.
- **Check** signs in at the provider and shows “signed in as …” or the error.
- **Edit:** name and token (for “Git (generic)” also the username) at any time – a new
  token applies immediately to all sources of this connection. The stored token is never shown,
  only replaced. The **address** is fixed as long as sources use the connection or repositories
  from it are in the trash.
- A connection's token goes **only to its own server**: if you choose a connection in the wizard
  and then change the address, the selection falls back to “Without sign-in”.
- **Delete** is only possible once no source uses it any more and no repository from it is in the
  trash.
- **Webhook** (Gitea, GitHub, GitLab with a token): the line below shows whether a webhook arrived recently
  (“Instant sync via webhook – last …”) or whether the sources are synced every 5 minutes.
  Below it is what **really** exists at the provider in webhooks of Kaveyl Wiki – one line per webhook: “Webhook on
  account … – reports pushes from all your repositories” and/or “Webhook on repository …”. If there is none, it only
  says “No webhook set up – sync every 5 min.”. A webhook is marked when it still points at an earlier address, is
  switched off at the provider, or is a repository webhook next to the account webhook (“every push arrives twice”).
  If only some added repositories have one, the line “Without webhook (sync every 5 min.)” names the rest. Kaveyl Wiki
  asks when the page opens, on **Check webhook** and when you come back to the window – a webhook you deleted by hand at
  the provider is gone here too. A webhook only counts as its own if it points at the current webhook address of this
  Kaveyl Wiki instance or at one it used itself before – also one you created yourself; pushes only arrive if it carries
  the secret from the [Webhooks](#webhooks) page. A webhook at …`/api/webhooks/git` on any other address belongs to
  another Kaveyl Wiki instance (e.g. a test instance on the same account): it is shown in grey as “… – belongs to another
  Kaveyl Wiki instance (address)”, without a button, and Kaveyl Wiki never moves or removes it – not with “Remove all”
  either. **Set up webhook** creates the missing ones – after a confirmation, never on its own. New
  webhooks are called “Kaveyl Wiki” at the provider (GitHub has no names):
  - **Gitea:** the question lets you choose. **Only the added repositories** creates a webhook on each added repository –
    only pushes there are reported; if you add another one later, set it up again. **Your whole account** creates
    **one** webhook on your account (user settings → Webhooks): it applies to all repositories you own, future ones
    too – every push from them goes to Kaveyl Wiki, but only added sources are synced; the rest shows under “Recently
    received” as “no matching source”. Repositories of other owners (organisations) get their own in both cases. The
    question names for each way what happens; when you switch, Kaveyl Wiki tidies up the other way (the account
    webhook goes, or the webhooks on your own repositories) so that no push arrives twice. If both exist anyway, the
    check reports it.
  - **GitHub / GitLab:** one webhook per added repository (personal accounts have no
    account-wide one). For this the token needs the permission for webhooks (see the note below the token field).
  - The target is the [address for webhooks](#webhooks) (Settings → Sources → Webhooks), without one of your own the
    public address from Settings → Notifications → E-mail. If it is on your own network, Kaveyl Wiki tells you right
    away for GitHub.com/GitLab.com that they cannot reach the address.
  - **A question only when there is something to do:** when everything is set up, the button reads **Webhook set up**
    (with a tick), and a click only says “Nothing to do”. Otherwise the question names per place what happens (create,
    or move from which address to which).
  - **New address:** if one of Kaveyl Wiki's webhooks still points at an earlier address, the check says so (“still
    points at …”); **Set up webhook** then moves it instead of adding a second one. Below it you see what happened –
    “Created”, “Moved to the new address” or “Nothing to do”.
  - **Removing:** each webhook line has its own bin – after a question it deletes exactly that webhook, the others
    stay. With several there is also **Remove all** at the top (the question names each place). Other webhooks at the
    provider (not Kaveyl Wiki's) always stay. When none is left, the row says “No webhook set up – sync every 5 min.”;
    **Set up webhook** brings it back.

Public repositories and local folders do not need a connection.

## Finding and reading notes {#notizen-finden-und-lesen}

- **Instant search** at the top left (Ctrl+P): results appear as you type, grouped into
  folders, notes (title/path) and content. Right-click (on touch devices: long press) a result → “Open in new
  tab”, “Open to the right/left”, “Show in tree” or “Copy path” (the path
  with the source in front; a message confirms the copy). “All results …” opens the
  search page.

![Search](handbuch/06-suche.webp)

- **Command palette** (Ctrl+K): one input field for everything – search for a note and open it
  (Ctrl+Enter: new tab) or run commands (new note/new folder, show in tree,
  versions, sync, settings, light/dark, sidebar, table of contents,
  width). With `>` at the start, only commands appear.

![Command palette](handbuch/33-befehlspalette.webp)

- **Search page** (command palette → “All results …” or “Search with filters”): full
  list of results with tags, modification date and text snippet, filters for source, tag, folder and
  “changed since”. You can also type the filters directly:

  | Input | Effect |
  |---|---|
  | `tag:project` | only notes with this tag |
  | `in:Handbuch` | only this source (name) |
  | `path:docs/` | only this folder |
  | `since:7d` | changed in the last 7 days (`h`, `d`, `w`, `m`, `y` or a date) |
  | `"exact phrase"` | words in exactly this order |
  | `-word` | exclude notes with this word |

![Search page](handbuch/34-such-seite.webp)

- **Favourites:** the star at the top right of the note (or right-click in the tree → “Add to Favourites”;
  this also works for folders without their own folder note – clicking one shows the folder expanded
  in the tree). Favourites are at the very top of the sidebar. Right-click an entry in
  “Favourites” or “Recent”: open in new tab, open to the right or left, show in tree,
  **Remove from Favourites** or “Add to Favourites”. **Recent** below it shows the most recently
  opened notes – or, with “changed”, the most recently changed ones (also by others, from VS Code
  or via Git). After each entry, the **source** is shown in grey in brackets – handy, because
  Git projects often have the same folder structure (e.g. several `README` or `docs/`). Both
  sections can be collapsed; clicking “opened” or “changed” expands “Recent”
  automatically. The lists belong to your account and are not stored in the repository.
  A note only ends up in “Recent” once it could be opened. Entries whose note no longer
  exists (deleted, renamed outside, source removed) are hidden by the sidebar.
  If a note cannot be opened, the tab offers “Search” and “Trash” (note not
  found) or “Try again” (another error) and “Close tab”.

![Favourites and Recent](handbuch/37-favoriten.webp)

![Menu in the favourites](handbuch/51-favoriten-menue.webp)

- **Icons:** click the symbol to the left of the path (or right-click in the tree → “Change icon
  …”). Three tabs:
  - **Symbols** – “Common” shows a selection; the list next to it gives all roughly 1,900
    Lucide symbols by **Category** (files, development, finance, weather …) or “All”.
    The search field searches names, keywords and categories (names and keywords in English,
    e.g. `bird`, `cloud`).
  - **Emoji** – a selection or any emoji of your own.
  - **Custom** – **Upload …** (PNG, WebP, JPEG, GIF or SVG, at most 256 KB, several
    at once too). Custom icons apply to **all sources** and all users; they may be deleted by
    whoever uploaded them or by an admin. Notes with a deleted icon show an empty
    box.

  “No icon” removes it. Stored in the frontmatter as `icon: lucide:rocket`,
  `icon: emoji:📘` or `icon: custom:<id>`; a folder shows the icon of its folder note. Custom
  icons are stored in the app’s database (not in the repository) and are included in its backup.

![Searching symbols](handbuch/53-icon-suche.webp)

![Custom icons](handbuch/54-eigene-icons.webp)
- **Read-only:** “…” → “Make read-only” writes `readonly: true` into the note – it
  then opens in reading mode for everyone (“Read only” unlocks it temporarily). Remove it via
  the same menu item.
- **Split view:** right-click a note in the tree or a search result → “Open to the
  right” or “Open to the left” (in the tab menu it is called “Show to the right/left”). The chosen note is placed next to the
  current one. If it is itself the current one (just opened with a click), the previously opened
  note goes to the other side. Both halves are full editors; clicking the tab of the
  right-hand note swaps the sides, × in its header closes the split.

![Split view](handbuch/38-geteilte-ansicht.webp)

- **Expanding and collapsing:** you expand and collapse Favourites, “Recent”, “AI access” and each source by clicking their
  heading. Next to the search there is a symbol that switches depending on the state: **Collapse all**
  as long as any folder is open, otherwise **Expand all** (all sections, all folders of all sources). Hovering over a source shows **Expand all folders
  / Collapse all folders**, hovering over any folder – in any source, at any level – shows **Expand everything below
  / Collapse everything below** (one symbol that switches depending on the state; if the folder has no
  subfolders, it only expands or collapses the folder itself) and, where you may write, **+** for a
  new note or a new folder. **Alt+click** on the
  arrow of a folder also expands or collapses it with everything below. On touch devices
  (without a mouse) the symbols are always shown on the source and on the currently selected folder.
- **Markers at the right edge** of a row always stay in the same place: ✦ (its own
  [AI access rule](#ki-freigaben), visible to admins only), the lock (encrypted folder) and,
  on a source, the sync spinner or the warning triangle for a sync error or conflict (tooltip with
  the message). The buttons that appear on hover show up to the left of them – nothing shifts.
- **Width of the sidebar:** drag the right edge of the sidebar – with the mouse or a finger. With the keyboard: select the edge with Tab, then arrow left/right.

![Everything expanded](handbuch/58-alles-aufgeklappt.webp)

- **Focus (hoisting):** right-click a folder → “Show only this folder (focus)”. The
  sidebar then shows only this folder; “Focus: …” at the top with × leaves it.
- **Names:** tree, tabs, header, search, favourites and lists show the **file name**
  without `.md` everywhere (a folder note `index.md` under the name of its folder). A `title:` in the
  frontmatter or the first heading does not change the display – but the search still finds notes
  by their title as well.
- **Tags:** are shown above the text. “+ Tag” adds one (typing suggests matching existing
  tags, the arrow in the field or ↓ shows all of them; tap or Enter accepts), × removes it, a click shows all notes with this tag. It is stored
  in the frontmatter `tags:` in the style of the file – the Wiki.js notation `tags: a, b` stays that way,
  a YAML list stays a list. All tags with their count: **#** at the top of the sidebar.

![Tags](handbuch/35-tags.webp)

- **Coloured tags:** right-click a tag (above the note or in the **#** window; on a phone, long
  press) → **Colour** → one of twelve colours or **No colour** (grey). The colour applies to the tag in
  the whole source and appears above the notes, in the **#** window and in the search. It is stored
  in the file `.kaveyl-wiki.yml` at the top of the source (`tagColors:`) – so it travels with the repository,
  and other Kaveyl Wiki installations see the same colours. If a tag occurs in several sources,
  Kaveyl Wiki colours it in all those you may write to; in the others it stays as it is. The **#** window
  then shows the most common colour. Anyone who may write in the source may colour tags.
- **Renaming or merging a tag:** right-click a tag → **Rename / merge …**,
  enter the new name. Kaveyl Wiki changes the tag in every note you may edit (in all
  sources; each file keeps its notation). If the new name already exists, Kaveyl Wiki asks and
  merges the two – a note with both tags keeps it once. The colour goes along if the target
  does not have one yet. Notes without write access stay unchanged; the message says how many.

![Choosing a tag’s colour](handbuch/117-tag-farbe.webp)

- **Links to notes** carry a small note symbol, links to attachments a paper clip.
  Hovering briefly over a note link with the mouse shows a **preview** (name, path,
  beginning of the text).

![Link preview](handbuch/36-link-vorschau.webp)

- **Table of contents** on the right: a click jumps to the heading; the current one is highlighted.

![Table of contents](handbuch/07-inhaltsverzeichnis.webp)

- **Markdown view:** shows and edits the source text directly.

![Markdown view](handbuch/08-markdown-ansicht.webp)

- On a **phone** the interface is usable (sidebar can be shown/hidden); for longer
  writing, the desktop is more comfortable.

![Mobile](handbuch/09-mobil.webp)

## Editing {#bearbeiten}

Just click into the text and write – the editor shows the formatting directly (WYSIWYG).
The **?** at the right end of the formatting toolbar opens this help; if you prefer to type Markdown
directly, you will find all notations in the [Markdown cheat sheet](#markdown-spickzettel).

![Editor](handbuch/10-editor.webp)

- **Formatting toolbar** at the top: paragraph style (headings), bold, italic, strikethrough,
  code, link, lists, checklist, quote, code block, callout, collapsible block,
  divider, table. When the cursor is in a table, buttons for rows/columns
  (insert above/below, left/right, delete) are added; in a code block, a choice of language
  (for syntax highlighting, including YAML, Bash, PowerShell, Dockerfile, nginx, TOML). If no
  language is set, Kaveyl Wiki detects it itself and shows “Automatic: yaml”; **“apply”**
  writes it into the file (` ```yaml `) so that Gitea and VS Code highlight it too; in a callout, the type (Note, Tip, Important,
  Warning, Caution).
- **Callouts** are stored as `> [!NOTE]`, `> [!WARNING]` … – the same
  notation that Gitea and GitHub also display in colour.
- **Collapsible blocks** are stored as `<details><summary>…</summary> … </details>`.
  Expanding and collapsing with the arrow on the left does not change the file. Typing: heading,
  **Enter** → into the content (a collapsed block expands); in the content, **Enter** makes a
  new line in the block, **Enter on an empty last line** leaves the block; **Shift+Enter**
  breaks the line within the same paragraph. Markdown does not store empty lines – they disappear when
  saving (this applies everywhere, not just here).
- **Line breaks:** **Enter** starts a new paragraph, **Shift+Enter** breaks the line within the
  same paragraph. In a **table cell**, Kaveyl Wiki stores both as `<br>` – a cell is one line
  in the file – and shows it as a line break the next time it is opened. If a file has been wrapped by hand in the source text (a new line without a blank line
  in between), Kaveyl Wiki shows it as **one continuous paragraph** – just like Wiki.js, Gitea, GitHub
  and the Markdown standard. The line breaks in the file are kept; in the **Markdown** view
  you can see them.
- **Code blocks** are highlighted in colour as soon as a language is chosen (` ```python `).
- **Selection menu:** select text → a small menu for bold, italic, strikethrough, code, link, **Heading 1–3**
  (turns the whole paragraph into a heading, clicked again back into text; not in lists) and
  **AI** (see [AI assistant](#ki-assistent)).

![Selection menu](handbuch/12-auswahlmenue.webp)

- **Slash commands:** `/` at the start of a line or after a space opens a menu (heading, list, checklist,
  code, table, quote, callouts, collapsible block, link note, file or image,
  diagram (Mermaid), divider, link). Typing further filters – several words work too, German or English
  (`/überschrift 2`, `/heading 2`, `/h2`) –, Enter or Tab inserts, Esc closes.

![Slash menu](handbuch/13-slash-menue.webp)

- **Attaching files and images:** paper clip in the toolbar, drag a file into the editor window
  or paste it from the clipboard (e.g. a screenshot). The file goes into the folder
  `assets/` next to the note and is inserted as an image or link – so it also works in
  Gitea and VS Code. Below the note the **Attachments** list appears with size, preview (images,
  PDF) and download. Clicking a file link opens the preview or downloads the file.
  Files with the same name are numbered (`Angebot-2.pdf`), never overwritten. Executable
  files (.exe, .bat, .ps1 …) are blocked by default; which endings are blocked and the maximum size (default
  20 MB) an admin sets under Settings → Attachments.

![Attachments](handbuch/31-anhaenge.webp)

![Language detected](handbuch/56-code-erkennung.webp)

- **Aligning and resizing images:** clicking an image opens a small toolbar:
  **Left / Centred / Right**, **25 / 50 / 75 %** (relative to the original size of the image,
  stored in pixels), **Original** and **Column width** (as wide as the text). On the
  selected image (or when hovering over it) a **drag handle** appears at the bottom right, with which you
  set the width freely in pixels. It is stored so that Gitea, GitHub and VS Code display it
  the same way: a size as `<img src="…" alt="…" width="400">` (column width:
  `width="100%"`), the
  alignment as `<div align="center">` around the paragraph. “Original” and “Left” turn it back
  into a normal `![…](…)`. Aligning works for images at the top level and in collapsible
  blocks (not in lists or tables).

![Image centred, half width](handbuch/55-bild-zentriert.webp)

- **Large images:** an image without its own width takes up at most about **two thirds of the window height**
  – so a phone photo no longer fills the whole screen, and the note stays readable. The
  **magnifier** at the top right of the image (when hovering, on the selected image and always
  visible on touch devices) or **“View large”** in the small image toolbar shows it as large as the window
  allows; in the reading view a click on the image is enough. Close with a click, **Esc** or ×. Images
  are only loaded when they scroll into view – so long notes with many images open and
  scroll smoothly.
- **Reduced on insert:** photos and screenshots that are larger than **2400 pixels** (longest
  edge) or heavier than 2 MB are reduced by Kaveyl Wiki in the browser already and stored as
  **WebP** – usually a tenth of the file size with the same sharpness on screen. A short
  message gives the old and new size. GPS and camera data are dropped in the process; GIF and SVG stay as
  they are. An admin sets the limit under [Settings → Attachments](#anhänge) (1600 to 4000
  pixels or “Do not shrink (originals)”). Images that are already in the repository stay unchanged.

![Viewing an image large](handbuch/94-bild-gross.webp)

- **Linking a note:** type `[[` and a few letters of the title – Kaveyl Wiki suggests
  matching notes from the same source; Enter inserts a normal relative link
  (`[Roadmap](plan/roadmap.md)`) that also works in Gitea and VS Code.
- **Link to an address:** `/link` or the link button opens a Kaveyl Wiki window with **Link target**
  (web address or relative path) and **Link text**; Enter accepts, Esc cancels. On an existing link
  the button opens the same window for changing it – emptying the target removes the link.

![Inserting a link](handbuch/107-link-einfuegen.webp)

![Linking a note](handbuch/32-notiz-verlinken.webp)

- **Formulas:** `$E = mc^2$` within a sentence or `$$ … $$` on a line of its own (LaTeX) are typeset with KaTeX
  – exactly as GitHub displays them. The slash commands “Formula …” insert one (input in the
  Kaveyl Wiki window), a double-click edits it. Amounts of money such as “$5 and $10” stay normal text.
- **Diagrams:** a code block with the language `mermaid` (slash command “Diagram (Mermaid)”)
  shows the drawn diagram below it; the text stays editable. The optional `elk` layout is not included for licence
  reasons – diagrams are drawn with the default layout.
  Besides flowcharts, Kaveyl Wiki draws the other kinds of Mermaid diagram too, such as a timeline (`timeline`) for a
  roadmap, a mind map (`mindmap`), a pie chart (`pie`), a project plan (`gantt`) or a Git history (`gitGraph`) – in
  Kaveyl Wiki's colours, light and dark. A roadmap, for example:

  ````
  ```mermaid
  timeline
    title Roadmap
    section 2026
      Q4 : Group bookings
    section 2027
      Q1 : Mobile check-in : Offline tickets
      Q2 : Partner API v2
  ```
  ````

![Formulas and diagram](handbuch/41-formeln-diagramm.webp)

- **Drawings (Excalidraw):** the slash command “Drawing (Excalidraw)” (`/drawing`) opens a
  canvas – shapes, arrows, text, freehand. **Save** stores the drawing as
  `assets/zeichnung.excalidraw.svg` next to the note and inserts it as an image (each further one gets
  a number: `zeichnung-2.excalidraw.svg` – each can be edited the same way). Because the file
  is a normal SVG, it can be seen everywhere (Gitea, VS Code, Wiki.js); the drawing itself
  is contained in the file. Editing: **double-click** the image, or click the image →
  “Edit drawing” – it is saved to the same file, the old version stays in the
  Git history. The file can also be opened on excalidraw.com (“Open” → SVG with scene).
  There are no drawings in encrypted notes (the file would lie next to the note unencrypted).

![Drawing](handbuch/65-zeichnung.webp)

- **Emoji:** type `:` and two letters (`:check` → ✅, `:warn` → ⚠️, `:rocket` → 🚀) or
  use the smiley in the toolbar. The character itself is stored, not a `:code:`.
- **Copy formatting** (brush in the toolbar): place the cursor in formatted text (e.g. bold),
  click the brush, then select the target text with the mouse (or with Shift+arrow keys) –
  it gets exactly this formatting. Esc cancels.
- **Who else is here?** If other users have the same note open, “Maria has the note
  open” is shown at the top – if someone is typing right now, “Maria is editing” (orange). Editing at the same time
  is possible, but whoever saves last gets the notice “changed outside”
  and decides (see Conflicts) – so better agree with each other.

![Presence](handbuch/45-praesenz.webp)

- **If you start typing while someone else is editing the note,** Kaveyl Wiki asks once:
  “Maria is editing this note right now …” – with the consequence: whoever saves later gets a notice;
  changes in different places can be merged, for the same place a version has to be chosen. **Edit
  anyway** keeps what you typed and does not ask again while the other person goes on editing (pauses
  under a minute do not count). **Cancel** drops the text you just typed, and the note shows the saved
  state again. Nothing is locked – the question is only a notice. Changes through the API, MCP or from
  outside (Git, other programs) do not trigger it.
- **If someone else saves while you have the note open,** you see the change at once – your cursor and
  the place you are reading stay where they were. If you have unsaved changes yourself, the notice comes
  instead (see [Resolving conflicts](#konflikte-auflösen)). If someone moves or renames the open note,
  your tab follows it, and what you type lands at the new place.

![Question when editing at the same time](handbuch/45b-weiche-sperre.webp)

- **Saving** happens automatically, shortly after you stop typing (top right:
  “Saved”).
- What the editor cannot display (e.g. HTML, footnotes) appears as a block with a grey
  border and is kept unchanged.
- Notes with `readonly: true` in the frontmatter open in reading mode (“Read only” to unlock).

### Markdown cheat sheet {#markdown-spickzettel}

In the editor you don’t need Markdown – the toolbar, `/` commands and keyboard shortcuts are enough. But what is saved
is Markdown, so that the file stays readable everywhere. In the **Markdown view** (top right
“Markdown”) you see and edit exactly this text; the table shows both ways.

| What | Notation in the file | In the editor |
|---|---|---|
| Headings | `# Title`, `## Section`, `### Subsection` | Paragraph style in the toolbar, `/heading` |
| Bold, italic, strikethrough | `**bold**`, `*italic*`, `~~gone~~` | Ctrl+B, Ctrl+I, toolbar |
| Code in the text | `` `code` `` | Ctrl+E |
| Link | `[Text](https://example.com)` | Toolbar “Link” or select text → link in the selection menu |
| Link to a note | `[Roadmap](plan/roadmap.md)` (relative) or Wiki.js style `/plan/roadmap` | `[[` + name |
| Image | `![Description](assets/image.webp)`, with width `<img src="…" width="400">` | paste, drag, paper clip |
| Bulleted list | `- Item` or `* Item` | Toolbar, `/bullet` |
| Numbered list | `1. Item` | Toolbar, `/numbered` |
| Checklist | `- [ ] open`, `- [x] done` | Toolbar “Checklist”, `/checklist` |
| Quote | `> Text` | Toolbar, `/quote` |
| Code block | three backticks with language (` ```python `), code, three backticks | Toolbar “Code block”, `/code`; choose the language when the cursor is in the block |
| Table | cells separated by vertical bars, below the header row a row of `---` | Toolbar “Insert table”, `/table` |
| Callout | `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` | Toolbar “Callout” |
| Collapsible block | `<details><summary>Title</summary> … </details>` | Toolbar, `/collapsible` |
| Divider | `---` on a line of its own | Toolbar, `/divider` |
| Formula | `$E = mc^2$` within a sentence, `$$ … $$` as a line of its own | `/formula` |
| Diagram | Code block with language `mermaid` | `/diagram` |
| Drawing | Image `assets/name.excalidraw.svg` | `/drawing` |
| Emoji | the character itself (✅) | `:` + word (`:check`) |
| Metadata | Frontmatter at the very top between `---`: `title:`, `tags:`, `icon:`, `id:`, `readonly: true`, `ai: false` | Tags above the text, icon in the header |

What the editor cannot display (custom HTML, footnotes …) stays unchanged as a block with a grey
border. Markdown does not store empty lines – they disappear when saving.

### Templates {#vorlagen}

When creating a note you can choose a **template**. Templates are normal Markdown
files in the folder `.kaveyl-wiki/templates/` of the respective source (versioned, also editable in VS Code;
they do not appear in the tree). In the selection they are listed under their **file name**. An existing note becomes a template via “…” → “Save as
template”. Placeholders that are replaced when creating a note:

| Placeholder | Example |
|---|---|
| `{{title}}` | Title from the create dialog |
| `{{date}}` / `{{time}}` / `{{datetime}}` | 2026-10-06 / 14:30 / 2026-10-06 14:30 |
| `{{year}}` `{{month}}` `{{day}}` `{{weekday}}` | 2026, 10, 06, Tuesday |
| `{{user}}` | your display name |

![Choosing a template](handbuch/40-vorlage.webp)

## How syncing works {#so-funktioniert-der-abgleich}

Kaveyl Wiki is not a store of its own but **one participant among several**. The shared centre is always the
Git server – Gitea, GitHub, GitLab or another one. Everyone who works on a repository has their own
copy of it: VS Code on your PC, a code-server, Obsidian on the laptop – and Kaveyl Wiki itself too. Syncing always
goes through the centre: whoever changes something sends it there (push), and the others fetch it from there (pull).
The copies never talk to each other directly.

![Who sends what where – and when: browser, agents, Git server, mounted folder, notifications and event webhooks with their times](handbuch/en/abgleich-wege.webp)

**What Kaveyl Wiki sends.** What you write in Kaveyl Wiki is in the file in less than a second. It goes to the server
in batches: as soon as you leave the note, with Ctrl+S, after a pause in writing (default 2 minutes, adjustable per source
under “When to write your changes to Git?”) and, if you write without a break, at the latest every 10 minutes. This creates a commit with
you as the author, and Kaveyl Wiki pushes it immediately.

**What Kaveyl Wiki fetches.** Kaveyl Wiki fetches other people’s changes from the server every 5 minutes. With a
[webhook](#verbindungen) the server reports every change immediately; it is then there within a few seconds. In the
[sync overview](#speichern-übertragen-und-synchronisieren) you can also do it by hand at any time with “Sync now”.
If a note is open and unchanged, it loads the new version by itself.

**Two kinds of webhook.** The **push webhook** goes from the Git server to Kaveyl Wiki: it reports every push, so Kaveyl
Wiki does not wait for the next sync (set it up under [Connections](#verbindungen)). The
**[event webhook](#ereignis-webhooks)** goes from Kaveyl Wiki to another system, such as an agent: it reports every change
to notes, whether it came from the app, the API, MCP or from outside. Who learns about which changes by dot, e-mail or
Pushover is described under [Following](#beobachten). The example shows everything together with times:

![Example with times: Anna writes, Tom sees it live, an agent answers, Lena gets an e-mail, a colleague pushes from VS Code](handbuch/en/abgleich-beispiel.webp)

**One branch per source.** Kaveyl Wiki works only on the branch you chose when adding the source (usually `main`). What
happens on other branches, Kaveyl Wiki does not see. Anyone who wants to see the same repository state in Kaveyl Wiki works on
this branch or merges their work into it.

### Typical setups {#typische-aufstellungen}

**Only Kaveyl Wiki, on several devices.** PC, tablet and phone open the same Kaveyl Wiki instance in the browser. They all work
on the same copy, so there is nothing to sync between the devices – a change on the phone is
there on the PC immediately. If two devices edit the same note at the same time, Kaveyl Wiki notices this when saving and shows the
notice “The note was changed outside the app” with “Merge”, “Load the other version” or “Save my version”.

**Kaveyl Wiki and a PC with VS Code.** The PC has its own clone of the repository. VS Code does not sync it
by itself: before editing, fetch the latest state (in VS Code “Sync Changes” or `git pull`) and afterwards send it
back up (commit and “Sync Changes” or `git push`). Only then does Kaveyl Wiki see your change – after at most
5 minutes, immediately with a webhook. The other way round, what was written in Kaveyl Wiki reaches the PC with the next pull. If you rename
a file in VS Code, Kaveyl Wiki recognises this and updates links to it in a separate commit `fix(links): …`.

**Kaveyl Wiki and a code-server.** A code-server is a VS Code in the browser that runs on a server. For syncing,
the same applies as for the PC: it has its own clone and needs pull and push. It is only different if code-server and
Kaveyl Wiki use **the same folder** on the server – then the next paragraph applies.

**A shared folder without Git in between.** If a folder on the server is mounted both in Kaveyl Wiki (as “Local folder”)
and in another program, both work on the same files. Kaveyl Wiki watches the folder: what another
program changes there is in Kaveyl Wiki after about a second – and, the other way round, immediately in the file. There is no server, pull
or push here. If the folder has **versions** (created by Kaveyl Wiki), every change by the other program also becomes a
version after the pause, with “Kaveyl Wiki” as the author; what it puts unencrypted into an encrypted folder does not go
into the versions (a notice in the source's log). Whoever can also change the hidden folder `.git` through a share can
alter the history. Git settings that would make Git start programs (such as filters or `include`) are recognised: Kaveyl
Wiki then stops using Git in that folder until the entry is removed – still, give such shares only to people you trust
with the server. If the folder is your own Git repository instead (for example a
project from VS Code), commit and push remain up to you; Kaveyl Wiki only commits its own changes there if you switch on
“Commit changes automatically” for the source, and never pushes.

**Kaveyl Wiki and Obsidian.** Obsidian works on a folder on your device. With Obsidian’s Git plugin it
becomes a clone of the repository that fetches and sends at an adjustable interval – then Obsidian is a participant just like
VS Code. Without the plugin, Obsidian remains an editor for local files, and you do the syncing by hand.

**Kaveyl Wiki and Wiki.js (or a second Kaveyl Wiki instance).** These are simply further participants in the same repository.
Wiki.js fetches changes at its own interval (every 5 minutes by default), so it can take a while until a change from Kaveyl Wiki
can be seen there.

### When two people change things at the same time {#wenn-zwei-gleichzeitig-ändern}

If both Kaveyl Wiki and someone else have changed something since the last sync, Kaveyl Wiki rebases its own changes
onto the new state of the server. If they affect **different notes or different places in the same note**,
they fit together by themselves, and nobody notices anything. The version history stays a straight line, without
additional merge commits.

If both have changed **the same or directly adjacent lines** – or one has deleted a note that the other
has edited –, a **conflict** arises. Then Kaveyl Wiki overwrites nothing: your version stays saved,
pushing pauses, and the sync symbol shows a warning. The conflict is resolved in Kaveyl Wiki, with all three versions
side by side – see [Resolving conflicts](#konflikte-auflösen). Until then, nothing from this source reaches the server.

If someone has **rewritten** the branch on the server (force push), Kaveyl Wiki takes over the new state and only rebases its
own changes that have not been pushed yet onto it. What was removed on the server stays removed; the history
of the sync overview shows a warning about it. This also applies if a conflict arises in the process – see
[Resolving conflicts](#konflikte-auflösen).

### Tips for smooth syncing {#tipps-für-einen-reibungslosen-abgleich}

- **Set up a webhook** (Settings → Sources → [Connections](#verbindungen)): then Kaveyl Wiki sees changes from
  outside after seconds instead of after up to 5 minutes.
- **In VS Code**, switch on the setting `git.autofetch` and click “Sync Changes” before editing. Whoever
  fetches first and then writes almost never gets a conflict.
- **Push small and often** instead of collecting for a whole day: the shorter two versions diverge, the
  less often they hit the same place. Kaveyl Wiki does this by itself; in VS Code it means committing and pushing more often.
- **Work on the added branch** (usually `main`) – Kaveyl Wiki only sees changes on other branches once
  they have been merged there.
- The exact times and the sync symbol are explained in the next section.
## Saving, transferring and syncing {#speichern-übertragen-und-synchronisieren}

- **Saving** to the file happens immediately (a few hundred milliseconds after you type).
- **Signed out while something is still unsaved** (sign-out in another tab, session expired,
  password changed): The tab stays open, with the notice **“You are signed out”** and the number of notes not yet
  saved. **“Sign in in a new tab”** opens Kaveyl Wiki in a new tab; afterwards click **“Save now”** here
  – the new sign-in also applies to this tab. Only once everything is saved (or you confirm **“Discard changes and
  sign out”**) does the sign-in page appear. The content stays only in this tab, not on the device;
  the browser warns you when you close or reload it. Your own **Sign out** button also asks first if
  something is still unsaved.
  If a **different account** has signed in meanwhile (the sign-in applies to all tabs of this browser),
  the changes are **not** saved under that account: The notice **“Another account signed in”** names
  both names. **“Copy content”** puts the text of all notes not yet saved on the clipboard;
  if you sign in again with the original account in the other tab, **“Check again”** or the editor saves
  on its own. **“Discard changes”** (with a confirmation) opens the new account's workspace.
- **Server briefly not reachable** while something is still unsaved: The workspace stays as it is, and a
  notice with the number of open notes appears at the top. As soon as the server is back, the editor saves
  on its own – leave the tab open until then. If nothing is open, “Server not reachable” appears as before.
- **Transferring** (commit and, for repositories, push) happens as soon as you **leave** the note
  (another tab, closing the tab, browser window in the background), with **Ctrl+S**, after the
  configured **pause** (default 2 min) – and if you write without a break, at the latest every 10 minutes.
  One editing session thus usually results in **one** commit; you are the author.
- **Sync icon** next to “Kaveyl”: green = everything in sync, dot = saved changes
  are waiting to be transferred, warning/error = please take a look, crossed-out cloud = **no connection
  to the server** (Kaveyl Wiki reconnects on its own; until then the overview shows the last known state).
  If the list of sources cannot be loaded, the sidebar says so, with “Try again”. For **folders** there are two cases:
  without Git, changes are only saved and there is nothing to sync – such folders appear in the
  overview only in one line at the bottom (a click on the name shows their history), unless there is a
  problem. If the folder itself is a
  Git repository (e.g. a project you work on in VS Code), Kaveyl Wiki does **not** commit there
  itself – the overview shows “Folder with its own Git repository” and how many files are changed
  and not yet committed; you make the commit as usual in VS Code or with git. If you
  don't want that: edit the source → “Commit changes automatically”. A click opens the overview per
  source with “Sync now”, “Sync all” and the **History**.

![Sync overview](handbuch/11-sync-uebersicht.webp)

- Kaveyl Wiki fetches changes from outside every 5 minutes, immediately if a
  [webhook](#webhooks) is set up, or with “Sync now”. If a note is
  open and unchanged, it reloads automatically.
- **Wiki.js** fetches changes from Git at its own interval (5 minutes by default).

## Creating, renaming, moving, deleting {#anlegen-umbenennen-verschieben-löschen}

Everything by **right-click** in the tree (or in the note menu “…”):

- **New note / New folder** – also via the **“+”** that appears when you hover over a source or
  a folder (choice of “New note” or “New folder”). The file name is formed from the
  title (special characters such as `:` are replaced).

![“+” on a folder](handbuch/59-ordner-neu.webp)
- **Rename / move:** type the file name, **choose the target from the list** (all
  sources and folders, searchable). Links to the note are adjusted automatically.

![Rename and move](handbuch/15-umbenennen-verschieben.webp)

- **Move to another source:** same window, target in another source.
  The note is created there and deleted here; linked images are copied along
  (the originals stay, files without read permission are not taken along). The Git history stays in the old source, and Kaveyl Wiki cannot adjust links from the old
  source to this note across repository boundaries.

![Moving to another source](handbuch/18-quellwechsel.webp)

- **Copy / Cut / Paste:** right-click a note or a folder →
  “Copy” (Ctrl+C) or “Cut” (Ctrl+X), then right-click a folder or the
  name of a source → “Paste …” (Ctrl+V; on a note = next to it). The shortcuts work when
  the entry is selected in the tree. This also works between sources.
  - **Copy** creates a duplicate; if the name already exists at the target, it is called “name (Kopie)”,
    “name (Kopie 2)” … A folder is copied with its notes, images, PDFs, attachments (`assets/`) and
    folder settings (`.kaveyl-wiki.yml`); other files in it – scripts, configuration, hidden
    files – stay behind (the message states how many). A note takes its images and attachments from its folder along. Every copy gets a new
    `id`; links in the copy are adjusted so that they reach the same notes (within
    a copied folder: the copies). Notes and files without read permission are not copied along. When copied into
    **another source**, links to notes that exist only in the old source may no longer
    be correct – the [Check](#prüfung) shows them as broken links.
  - **Cut + Paste** moves – like drag and drop; until then the cut entry
    appears faded.

![Copy and paste](handbuch/57-kopieren-einfuegen.webp)

- **Several at once:** mark them (see [Mark several](#mehrere-markieren)), then move, delete, export or share them.
- **Delete:** with a confirmation; for folders it states the number of notes in them (the folder page does not count). For folders,
  only notes are deleted; other files (code, images) stay. Deleted items end up in the
  [Trash](#versionen-und-papierkorb) of the source and can be brought back from there – right after
  deleting also via **Restore** in the message ““Name” is in the trash”. The
  keyboard focus then moves to the next line in the tree.

### Mark several {#mehrere-markieren}

As in a file explorer: **Ctrl+click** (Cmd+click on a Mac) marks a note or folder and one more; the row that is open
joins in. **Shift+click** marks all visible rows from the last marked one to here. On tablet and phone: long press →
**“Select”** – boxes appear before the rows, every tap marks or unmarks. Marking always stays within **one** source; a
click in another source starts over.

Above the tree it then says **“… marked”** with **Actions** and **Done**; right-clicking a marked row shows the same
actions:

| Action | Effect |
|---|---|
| Send by e-mail … | the marked notes as files in one e-mail ([Send by e-mail](#per-mail-versenden)); only when just notes are marked |
| Give access by e-mail … | one invitation or notice for all marked ones ([Sharing](#konten-einladungen-und-teilen-per-e-mail)); only when you may “manage” each |
| Move … | all into one folder, also into another source; links are adjusted. If a name already exists at the target, that item stays where it is and the message names it |
| Export: Markdown (ZIP) / HTML (ZIP) | one ZIP file with the marked notes and folders – paths from their common folder ([Export](#exportieren-und-drucken)) |
| Delete … | after one question, all into the [trash](#versionen-und-papierkorb) |
| Clear selection | like **Done** or Esc in the tree |

A plain click clears the marks and opens as always. The **middle mouse button** or right-click → “Open in new tab” opens
in a new tab.

![Two notes marked, right-click shows the actions](handbuch/89-mehrere-markiert.webp)

### Import Markdown {#markdown-importieren}

Right-click a folder or the name of a source → **Import ▸ Markdown files …** → choose one or more `.md` files from your
computer. Each becomes a note in that folder, as it is (frontmatter, tags), under its file name. If the name already
exists, the new note is called “Name 2” – nothing is ever overwritten. The note gets a new `id`, like a copy. Pictures
the file points to do not come along; single files at most 5 MB. An unencrypted file cannot be imported into an
encrypted folder. You need “write” there. Whole exports from other programs: [Import from other programs](#aus-anderen-programmen-importieren).

### Import from other programs {#aus-anderen-programmen-importieren}

Right-click a folder or the name of a source → **Import ▸ From another program …** → choose the other program’s export
as a ZIP (500 MB at most). Kaveyl Wiki recognises the format and shows **before anything is written** what will come
over: the number of notes, files and folders and a list of notes on the import, for instance about links that could not
be matched. You can change the format and the name of the new folder there. **Import** puts everything into a **new
folder** – never over anything that exists; if the name is taken, a number is added – and writes the note **Import
report** into it, with all notes and links to the notes concerned. In a source with versions the whole import is one
version. To undo it, delete the folder (it goes to the trash).

![Preview of an import from HedgeDoc](handbuch/90-import-vorschau.webp)

Names are cleaned up as when creating a note (“Hut 1: Tyrol” becomes `Hut 1 - Tyrol.md`); links between the imported
notes and pictures point to the new names afterwards. Pictures and PDFs stay where they are, other files go into
`assets/` next to them, blocked file extensions ([Attachments](#anhänge)) stay out. You need “write” in the target
folder; nothing can be imported into encrypted folders, and guests cannot import. Only one import runs at a time. If a
reverse proxy sits in front of Kaveyl Wiki, it must let uploads this large through – otherwise the dialog says “Too
large for the server”.

| Program | How to get the export | What comes over |
|---|---|---|
| **HedgeDoc** (1.x, also CodiMD) | start page → user menu at the top right → **Export user data** | all your own notes, the title becomes the name; `:::info` boxes become callouts, `:::spoiler` a collapsible section, `{%youtube …%}` a link, `[TOC]` is dropped; empty notes stay out |
| **Joplin** | in the File menu, export everything as “Markdown + Front Matter” and pack the folder as a ZIP (plain “Markdown” works too, then without tags and to-do state) | notebooks become folders, the title becomes the name; pictures and attachments go into `assets/` next to the first note that shows them; links between notes stay; tags stay; to-dos keep open/done and the due date in the frontmatter (`todo`, `done`, `due`); HTML notes from the web clipper and resized pictures (`<img>`) become Markdown |
| **Logseq** (0.10.x, graph as a folder) | pack the graph folder (with `pages`, `journals`, `assets`, `logseq` in it) as a ZIP | pages and journals (`Journal/2026-10-28.md`), namespaces `Tours/2026` become folders; page properties become frontmatter (`alias::` → `aliases`), block properties a line `key: value`; the outline stays a list; `[[Page]]` links and links to journals become normal links, also through aliases; `TODO`/`DONE` become task boxes (`LATER`, `NOW` … stay as a word in front); block references `((…))` and embeds become a link to the page with the text of the block; `#+BEGIN_NOTE` and the like become callouts; pictures without the time stamp in their name; queries stay as text, Org pages and whiteboards stay out. Logseq 2.x (database version, beta) is not supported yet |
| **SilverBullet** | pack the space folder (the pages as `.md` files) as a ZIP | pages and subfolders, pictures and files; `[[Page]]`, `[[Page\|Text]]` and `[[Page#Heading]]` links become normal links, embedded pages a link; `> **note**` boxes become callouts; Lua expressions and queries (`${…}`, `space-lua`) stay as text and are not run; `CONFIG`, the standard library and plugs stay out |
| **Obsidian** (checked with 1.14) | pack the vault folder as a ZIP – with or without `.obsidian` | folders, notes, pictures and files where they were; `[[Name]]`, `[[Name\|Text]]`, `[[Name#Heading]]`, relative `[[../Folder/Name]]` and Markdown links become normal links – also with `?`, `#` or `%` in the name; for names that exist more than once the nearest note wins; embedded pictures stay pictures (without size), embedded notes and PDFs become a link; callouts of all types become one of the five callouts (the title stays), foldable ones an expandable section; `==highlights==` become bold, `%%comments%%` invisible HTML comments; block ids `^abc` go; `#tags` in the text also go into `tags`; properties stay as they are (links in them as `[[…]]`); canvas and base files come along as files; `.obsidian` and the trash `.trash` stay out |
| **Outline** (checked with 1.12) | Settings → **Export** → whole workspace, or a collection’s menu → **Export**, each as **Markdown** (the newer **OKF** works too); then download the ZIP | collections as folders, a document with child documents becomes the folder page; title, created/updated and an emoji icon before the title come along; links between documents (a link to a heading opens the document); each file only once (Outline puts it next to every document that uses it); notices (`:::info` …) become callouts, toggle blocks an expandable section; mentions of people become `@Name`; `__underline__` becomes italics. Drafts, archived and deleted documents and templates are not in the export – links to them stay as text and the report names them |
| **Trilium** (checked with 0.106) | right-click the top note of the subtree → **Export** → **Markdown** | the tree as Trilium shows it – with Trilium’s titles (not the shortened file names of the export); a note with text **and** child notes becomes the page of its folder; pictures, attachments, references, embedded notes, footnotes and download links become Markdown; code and Mermaid notes become a note with a code block; canvases become a picture with the drawing as a file next to it, mind maps and relation maps a file; labels without a value become tags, with a value their own properties in the frontmatter, relations the title of the target note; a clone stays at its first place and is a link to it at the others. Trilium exports **protected notes** only while the protected session is open – otherwise they are missing and the report names the folder. Search, render and map notes stay out; Trilium already drops links to headings in its export |
| **Wiki.js** (2.x, checked with 2.5) | Administration → **Storage** → turn on **Local File System** (path in the container) → action **Dump all content to disk**, then pack the folder as a ZIP; with the **Git storage**, pack the folder of the repository | pages with their title as name, folders like the page addresses (named after the page at the same address), a page with child pages becomes the folder page; other languages in a folder of their own (`en/`); uploaded pictures and files stay where they were; description, tags, created/updated go into the frontmatter, unpublished pages with `published: false`; callouts (`{.is-info}` …) become callouts, `{.class}` attributes and picture sizes go; pages of the visual editor and HTML pages become Markdown (without scripts), AsciiDoc pages a code block. Links follow Wiki.js’s rules (`/de/…`, child pages); a relative link that led nowhere in Wiki.js but means a neighbour page of that name is set to it – the report says so; links to tags (`/t/…`) become text. The Git storage gives the same structure as “Dump all content to disk” (the main language without a folder of its own). Scheduled publishing is not in the export |
| **Markdown folder** | pack a folder of `.md` files (with subfolders and pictures if you like) as a ZIP | folders, notes and files as they are; relative links stay, `[[Name]]` links become normal links; hidden files and folders (`.git`, `.vscode` …) stay out |

**Names and links:** Kaveyl Wiki writes file and folder names in the usual Unicode form (NFC) – ZIP files from a Mac sometimes store umlauts differently. Markdown links find their target also when it is written differently there or differs only in upper/lower case (`notiz.md` → `Notiz.md`), as `[[links]]` already did.

**Pictures with HedgeDoc:** the export does not contain the uploaded pictures; they stay on the HedgeDoc server. The
preview therefore offers **“Fetch pictures from the old server”** (naming the server): Kaveyl Wiki downloads them from
there once while importing and puts them into `assets/`, named after their picture text. The old server has to be still
running and reachable from the Kaveyl Wiki server. Only files under `/uploads/` (pictures and PDFs) are fetched, without
redirects and never over loopback or link-local addresses (`127.0.0.1`, `169.254.…`), for 10 minutes at most. Whatever does not arrive stays a web link, and the
import report names the notes.

**Limits with HedgeDoc:** the export holds no addresses of the notes. So links to other HedgeDoc notes keep pointing to
the old server – the import report names every note concerned. Slides (`type: slide`) show as normal text.

**Wikis that already are a Git repository of Markdown** – Gollum, the wikis of Gitea, GitHub and GitLab
(`….wiki.git`), documentation repositories with MkDocs or Docusaurus – need no import: simply
[add them as a source](#quellen-einbinden).

### Drag and drop in the tree {#ziehen-und-ablegen-im-baum}

- Dragging a note or a folder **onto a folder** moves it there (links are
  repaired, as when renaming). Dragging onto the name of a source = top level. Notes
  can also be dragged into **another source** (the note is created there and deleted here).
- Dragging **between** two entries (line above/below the entry) sets the **order**.
  It is stored in the folder's `.kaveyl-wiki.yml` (`order:`) and is therefore the same for everyone;
  entries not listed follow alphabetically.
- Without dragging (e.g. on a tablet or phone): right-click or long press → **“Arrange”** →
  **“Move up” / “Move down”** moves an entry by one position. For a folder with
  its own order, **“Arrange” → “Sort contents alphabetically”** resets it (on a
  source: “Sort top level alphabetically”); `order:` is then removed from `.kaveyl-wiki.yml`,
  and a file that is otherwise empty is deleted.
- Entries you cannot see because of the [permissions](#berechtigungen) keep their
  place behind the entry they followed before when you rearrange; “sort alphabetically” only resets what you see.
- **Sources** themselves (repositories, folders) are sorted by an admin: drag a source by its name onto another
  (line above/below the name) or right-click → **“Arrange” → “Move source up / Move source
  down”**. The order applies to all users.

![Sorting in the tree](handbuch/42-baum-sortierung.webp)

![Move up / Move down](handbuch/52-sortierung.webp)

## Links and “Linked from” {#links-und-verlinkt-von}

- Links are stored in the file as perfectly normal Markdown links – relative (`../ordner/notiz.md`)
  or in Wiki.js style (`/docs/seite`). Both work in Kaveyl Wiki.
- **Web addresses:** typing `www.beispiel.de` is enough – Kaveyl Wiki saves `https://www.beispiel.de`
  (an e-mail address becomes `mailto:`). Links written elsewhere without `https://` also
  open the web page and do not count as broken links. A typed or pasted address becomes a link by itself;
  file names like `Note.md` or `pictures.zip` stay text, even though these endings are also web endings
  (with `https://` in front they become a link).
- **Click** opens the note (with Ctrl/⌘ or the middle mouse button in a new tab), a file as a
  preview or download, a web address in a new browser tab. **Right-clicking** a link
  shows Kaveyl Wiki's link menu: Open or Open in browser, Open in new tab (notes), Copy link,
  Edit link …, Remove link (the text stays). Right-clicking normal text still shows the
  browser's menu (e.g. for spelling suggestions).

![Link menu](handbuch/108-link-menue.webp)
- Below every note, **“Linked from”** shows which notes refer to it.
- **Very large notes:** a note over 256 KB – or one nested so deeply that the server cannot read it within a few
  seconds – is not read as Markdown. It stays in the full-text search and can be edited, but only appears in the
  Markdown view (with a notice at the top); its links to other notes do not count for “Linked from” and the link check,
  and when a target is renamed, Kaveyl Wiki does not adjust them in it. Kaveyl Wiki still recognizes its pictures and
  attachments – they never count as unused and go along when it is moved or exported. An HTML export shows its text unformatted.

![Linked from](handbuch/14-verlinkt-von.webp)

- **Automatic link repair:**
  - Renaming/moving **in Kaveyl Wiki** → links are adjusted immediately, each in the style
    of the file (relative stays relative, Wiki.js style stays Wiki.js style).
  - Renaming **outside** (VS Code, Wiki.js, `git mv`) in a repository → Kaveyl Wiki
    recognises the note again and repairs the links in a separate commit
    `fix(links): …`.
  - In **local folders without automatic commit** nothing is changed on its own; the
    sync overview offers “**Repair links**”.
  - Kaveyl Wiki does not touch links that already led nowhere before – the
    [Check](#prüfung) finds those.
- **Links leading nowhere** are marked **red and dashed** in the note (“Target missing”) – immediately while
  you write, not only after saving. A click on one opens the link menu with **Create note**
  (creates the note where the link points and opens it in a new tab), **Edit link …**
  and **Remove link**. With Ctrl/⌘+click the link is opened anyway. The marking does not change
  the file; a target you are not allowed to read also counts as missing. Encrypted notes are not
  checked (their links do not leave the browser).

![Link leading nowhere](handbuch/110-link-ins-leere.webp)

## Versions and trash {#versionen-und-papierkorb}

**Versions** (note menu “…” → “Versions”, only in Git sources): list of all commits of the
note, also across renames. For each version “Changes in this version” or
“Difference to the current version”. **“Restore this version”** makes the old
state the current version – as a new change, the history stays complete.

![Versions](handbuch/16-versionen.webp)

**“Save as …”** stores the selected version as a **new note** instead; the current
version stays as it is. In the window you choose the **folder** – the original's folder is
suggested, but you can switch to any folder of any source you are allowed to write to (the list
is searchable) – and the **file name**; Kaveyl Wiki appends `.md`. The suggestion is
“Name (Version 2026-10-03)”. If the name already exists in the folder, the window says so right away and offers
a free one (“Name (2)”); if you accept it, you stay in the name field and can keep typing or save with
Enter – nothing is ever overwritten. The new note gets its own `id`;
images and attachments the old version refers to come along (including ones that have since been deleted
– they are fetched from the Git history), and links are adjusted so that they reach the same notes
from the new location. In another source, links to notes of the old source
no longer work. Afterwards the new note opens.

The same window appears in the [Trash](#versionen-und-papierkorb) (“Save as” on an entry)
and in [Backups](#sicherungen) (“Save as …”).

![Save as](handbuch/116-version-speichern-als.webp)

**Trash** (trash icon at the bottom of the sidebar, right-click on the source →
“Trash”, or the command palette): every source has its own; at the top of the window you choose the
source. Where deleted items are kept depends on the source:

- **Sources without automatic commit** (local folders without versions): Kaveyl Wiki moves deleted
  notes into the source's hidden folder `.kaveyl-wiki/trash/` instead of deleting them. If the
  folder is in a Git repository, Git ignores the trash (its own `.gitignore` inside).
- **Git sources with automatic commit** (repositories, local folders with versions): Deleted items are in the Git
  history; the trash shows them from there. Deleting in Kaveyl Wiki does not wait for the pause before the next
  commit: the note goes into the history with its latest state at once and is in the trash right away – even one you
  have only just created. Notes deleted and committed outside also appear here. What was deleted
  before the versions were turned on stays in the trash folder and is still listed.

A deleted **folder** is one entry (“plan/Unterordner (3 Notizen)”) – **“Restore
all”** brings everything back, a click on the name shows the individual notes for
restoring them one by one. In Git sources, notes deleted in the same commit are
grouped the same way. If another file now sits at the old place, nothing is
overwritten.

- **Save as:** the icon with the pen next to “Restore” (for a folder entry also on
  each individual note). It opens the **Save as** window as for versions: folder in any
  source you are allowed to write to, and name – suggested is “Name (restored)” at the
  old place. A whole folder entry comes back as a new folder with all notes and subfolders.
  If something already sits at the old place, Kaveyl Wiki offers this window on its own with the normal
  “Restore” – so nothing is ever overwritten. If the note has an `id:`, the
  restored version gets a new one (the old one belongs to the note that now sits there).

![Save as from the trash](handbuch/93-unter-anderem-namen.webp)

- **Delete for good** (bin on the entry, only `.kaveyl-wiki/trash`) and **“Empty trash”**
  (both with a confirmation, only for those allowed to manage the source) remove entries forever. In
  Git sources, emptying only hides the entries – the history is never rewritten, they remain reachable via
  “Versions” or Git.
- **Retention:** Settings → Tools → [Clean-up](#löschregeln), default **30 days**,
  0 = never automatically. Kaveyl Wiki deletes older entries for good every night at 3 a.m. (Git entries:
  hidden).

![Trash](handbuch/60-papierkorb.webp)

![Trash of a Git source](handbuch/17-papierkorb.webp)

## Resolving conflicts {#konflikte-auflösen}

A conflict arises when you and someone else (VS Code, Wiki.js, an agent) have changed **the same
spot**. Your version is then saved, transferring pauses, and the
sync icon shows a warning.

Sync overview → **“Resolve conflict”**: three versions side by side – **Base** (common
state), **My version**, **Their version (server)**. Then:

- **Keep mine**, **Take theirs** or
- **Merge manually:** the text field contains both versions with the markers
  `<<<<<<<`, `=======`, `>>>>>>>` – merge the text, remove the markers.

**“Resolve and sync”** saves the result as a merge commit and transfers it.

Folder permissions apply here too: Only those allowed to read every affected file see the versions,
and only those allowed to change every one can resolve it. If the conflict also affects folders that are locked
or read-only for you, an administrator resolves it.

If the branch on the server was **rewritten** (force push), the base is the earlier
server state your changes were based on. When resolving, Kaveyl Wiki then puts only your
changes that have not been transferred yet as one commit on top of the new state, without a merge (its
description names the own commits it contains) – whatever was removed on the server does
not come back.

![Conflict](handbuch/21-konflikt.webp)

If a note that is **currently open** changes outside while you are editing it, a notice appears
directly in the editor. **Merge** brings both changes together when they are in different places
(other paragraphs, lines or list items): the note then holds both, nothing is lost. If both changed the
same place, Kaveyl Wiki says so and changes nothing – then you choose a version.
**Show differences** shows what is only in the other version (red, “-”) and what
is only in your version (green, “+”). **Save my version** replaces the other change with your version.
**Load the other version** discards your unsaved changes – Kaveyl Wiki asks first. If the note was
**deleted or moved** outside, you keep your version with **Save as a new note …**: you choose the folder and name
as with “Save as”; existing notes are never overwritten. For encrypted notes there is
neither merging nor the comparison nor saving as a new note.

![Notice with Merge](handbuch/21b-zusammenfuehren.webp)

## Deleting repositories {#repositories-löschen}

Right-click a source on **Gitea, GitHub or GitLab** → **“Delete repository …”** (administrators only; the connection needs the permissions to archive and delete for this):

![Delete repository](handbuch/27-repository-loeschen.webp)

- **Move to the trash (recommended):** The repository is archived at the provider
  (read-only) and deleted for good after **30 days** (configurable under Settings →
  Sources → Added sources or → Tools → [Clean-up](#löschregeln); 0 = only when you delete it). Until then it is
  **restorable** under Settings → Sources → “Deleted repositories”. There, each repository shows
  when it was deleted and how many days it has left, with **Restore** and
  **Delete for good …** (asks for the full name). Without entries it only says “No
  deleted repositories”; retention, backup folder and manual restore are
  collapsed under **Technical details**.
- **Delete for good right away:** only after typing the full name (e.g. `anna/notizen`).

![Deleted repositories](handbuch/28-repository-papierkorb.webp)

Before **every** final deletion, Kaveyl Wiki backs up the complete repository as a
Git bundle (kept for 30 days by default, configurable; in the container `/config/backups/repos/`, on the
server e.g. `./kaveyl-wiki/config/backups/repos/`).
To restore: `git clone <datei>.bundle` and push to a new repository.
Added sources of the repository are unmounted beforehand.

![Deleted, with backup](handbuch/29-repository-geloescht.webp)

## Permissions {#berechtigungen}

Who may see and change what is set with **rules** – on a whole source, a
folder or a single note. Right-click → **“Permissions …”** (for a note also “…” →
“Permissions …”). The menu entry appears for admins and for everyone who has the permission
“manage” at that place.

| Permission | Meaning |
|---|---|
| **no access** | The note or folder is invisible – in the tree, in search, in “Recent”, in backlinks. |
| **read** | View, search, view versions. The editor is locked, rename/delete/create are missing. |
| **read & write** | Additionally change, create, move, delete, attachments, order. |
| **manage** | Additionally assign rules for this area. Not for [guests](#konten-einladungen-und-teilen-per-e-mail). |

A rule applies to **All**, a **group** or a **person**. This is how it is evaluated:

- The **most specific** rule wins: note before folder before parent folder before source. On the same
  level, a person rule comes before a group rule before “All”.
- **“No access” for a person or group always applies**, even if more is allowed further down.
  “No access” for **All**, on the other hand, is only the default and can be opened again below or per
  group. Example *private source for a team*: on the source “All: no access” and
  “Group Team: read & write”.
- Without a matching rule, the **default** applies (not for [guests](#konten-einladungen-und-teilen-per-e-mail); Settings → Users & permissions → [Permissions](#rechte),
  “Without a grant, users may:”; default “see nothing” – you open up sources with a rule, such as “All: read & write” on the
  source). Administrators always see and may do everything.
- The dialog shows the rules at this place and, below them, the ones **inherited** from above. Rules on
  notes are attached to their ID and survive renaming; note and folder rules move along when you move items in the
  app, also into another source (after renaming or deleting outside the app they appear on the source under “Rules without a
  target”). A folder rule is attached to the folder name: It stays there and applies again as soon as there is a folder with
  that name – remove it when it is no longer needed. If files stay behind at the old place when a folder is moved to another source (e.g. PDFs),
  its rules apply at both places. If such a move is interrupted midway, the old place stays protected
  as before, and whatever has already arrived at the target carries the same rules (shown in the dialog as rules of the respective note).
- **Deleting whole folders or moving them to another source** (and deleting a trash entry
  for good) is only possible with write permission on **everything** inside – including notes you
  cannot see, and subfolders that contain only images or PDFs. Otherwise Kaveyl Wiki reports “The folder contains notes you have no write
  access to”.
- **Syncing** (“Sync now”, “Sync all”) needs read & write
  on the whole source; “Sync all” only takes those sources.
- **Limit:** The permissions apply in Kaveyl Wiki (interface, REST API and MCP). Anyone working directly with Git or in the
  file system is not affected by them – real separation only through separate repositories.

![Permissions](handbuch/46-berechtigungen.webp)

## Accounts, invitations and sharing by e-mail {#konten-einladungen-und-teilen-per-e-mail}

**Roles.** *Users* see and change what the [permissions](#berechtigungen) allow
(without a rule, the default applies). *Administrators* may do everything. **Guests** only see what has been
**explicitly** granted to them or one of their groups – the default and rules
for “All” do not apply to them. Guests cannot create API tokens and cannot invite anyone; in the
permissions selection they only see themselves and their own groups, not all accounts.
Guests **never get “manage”**: For a guest the dialog offers at most “read & write”.
A group rule “manage” applies to the normal members of the group; for guests in it, it acts
like “read & write” – as does an older rule “manage” for a guest (shown in the dialog as
“read & write (guest)”).

**New users only see what you grant**, as long as the default is “see nothing” (the preset);
their welcome page tells them so.

**Language of the e-mails.** Anyone who already has an account gets e-mails (reset, shared note, notifications) in
the language of their account – if none is chosen (“Automatic”), in the language their interface showed last.
Invitations to new people go out in the language of the person inviting – the invited person has not set one yet,
after all.

**Create an account** (Settings → Users & permissions → **Users** → “New user”): e-mail, name, role and
- **Invitation by e-mail** (needs [e-mail sending](#e-mail)): The person
  gets a link (valid for 7 days), sets their name and password themselves and is then signed in.
  The account appears only once the invitation has been accepted.
- **Set an initial password yourself:** The account is created immediately. With the tick **“Must be changed at the
  first sign-in”** (on by default) the person sets their own password at the first sign-in. Without it, the password
  stays as you set it – for example for the account of an AI agent, or when the person may keep it.

With the **pen** on an account you change name, e-mail and role, assign a new
initial password (with the same tick) or send a **reset link**. A new initial password signs the
person out everywhere and deletes their API tokens – the method of choice if an account might have fallen into the wrong
hands.

![Accepting an invitation](handbuch/84-einladung.webp)

**Give access by e-mail.** Right-click a note, a folder or a source (for a note also “…” in the
note) → **Share ▸ “Give access by e-mail …”** – visible to administrators and everyone allowed to *manage* there.
Several [marked](#mehrere-markieren) notes and folders of one source go in one invitation. On accepting, only what the
inviting person may then still share applies – if that right was taken away meanwhile, that part is left out. Enter the e-mail (and
optionally a name), choose **read** or **read & write**, **Invite**. A folder or a source is shared
with everything in it, including whatever is added later.
- If the address already has an account, the person may read or edit **immediately** and gets a notification e-mail with a
  link (for a folder or a source the link shows it expanded in the tree). Anyone who was already allowed more there keeps
  their permissions – sharing never takes anything away.
- Otherwise an **invitation** goes out. On accepting it, a **guest account** with exactly this permission is created; the note
  opens straight away or the folder is open in the tree. In the tree the guest only sees what was shared and the folder path
  to it. Guests never get “manage” – they cannot share further.
- If the person is explicitly blocked there (“no access”, also via a group), Kaveyl Wiki reports that the
  grant would not take effect – first lift the block under “Permissions …”. Sharing never lifts a block.
  A block on a single note *in* the shared folder remains.
- **If a proxy with sign-in sits in front** (Cloudflare Access, Authentik, Pangolin): The invitation creates the account in
  Kaveyl Wiki, but the person only gets to the link if the proxy lets them through. Allow them there as well (see
  [SSO & proxy](#sso--proxy)) – otherwise the link ends at the proxy's sign-in screen.

The grant is a normal rule “Person: read” or “read & write” at that place (visible and removable
under “Permissions …” or under [Permissions](#rechte)). If a guest should see more, give them further
permissions or make them a normal user under Users → pen.

![Sharing a folder by e-mail](handbuch/85b-ordner-teilen.webp)

![Sharing a note by e-mail](handbuch/85-notiz-teilen.webp)

![A guest's view](handbuch/86-gast.webp)

![Forgot password](handbuch/87-passwort-vergessen.webp)

![New password via the link](handbuch/88-neues-passwort.webp)

### Send by e-mail {#per-mail-versenden}

For people **without an account**: right-click a note (or “…” in the note) → **Share ▸ “Send by e-mail …”**, one or more
addresses (separated by commas, 10 at most) → **Send**. Each address gets its own e-mail – the recipients do not see each
other. It says who sent the note; the note is attached as a Markdown file (`.md`), as a ZIP when it has pictures or
files – the same file as the **Download** button. There is **no link**: the e-mail gives no access to Kaveyl Wiki.
Replies go to your address. Several [marked](#mehrere-markieren) notes go together in one e-mail.

- Anyone who may **read** the note may send it – they could download it anyway. **Guests** may not.
- **Encrypted notes** never (the server does not know their content).
- Without [e-mail sending](#e-mail) set up, the entry is greyed out.
- Against mass mail: at most 30 addresses per hour and person and 200 for the whole instance, at most 50 notes and
  10 MB per e-mail. Long names are shortened in subject and text.
- The [log](#protokoll) records who sent which notes to which addresses.

![Sending two notes by e-mail](handbuch/89b-per-mail-versenden.webp)

## Working as a team {#im-team-arbeiten}

Several people can edit the same sources, folders and notes – in the app, through the API or MCP (an agent, an AI) and
from outside (Git, VS Code, a program in the folder). Kaveyl Wiki never silently overwrites anything: every change comes
with the name of whoever made it, and whoever saves later decides about differences. What does **not** work: typing
at the same time letter by letter as in an online office suite – Kaveyl Wiki works with saved versions, and if two
people changed the same place, one of them picks a version.

### Together on one note {#gemeinsam-an-einer-notiz}

An example: Maria and Tom both have the note “Weekly plan” open.

1. **Maria types.** Tom sees “Maria is editing” (orange) at the top. When Maria saves (automatically, shortly after
   typing), Tom sees her change at once – his cursor and the place where he is reading stay where they were.
2. **Tom starts typing too** while Maria is still at it. Kaveyl Wiki asks him once whether he wants to edit anyway
   (picture under [Editing](#bearbeiten)). He chooses **Edit anyway** and changes a different paragraph than Maria.
3. **Whoever saves later** gets a notice in the editor that the note has changed in the meantime. **Merge** takes both,
   because the changes are in different places. Had both changed the same sentence, Kaveyl Wiki says so: with **Show
   differences** Tom sees what differs and picks his or Maria’s version – what is only in the other one is missing
   afterwards (see [Resolving conflicts](#konflikte-auflösen)).
4. **If Maria renames or moves the note** while Tom is typing, Tom’s tab follows the note, and his text ends up in the
   new place.
5. **The versions** then show who changed what – see the next section.

The same goes for changes from outside: a colleague working in the Git repository, or a program writing into a mounted
folder, shows up the same way – for a mounted folder at once, for a Git server with the next sync. An agent using the API
or MCP reads the current state of the note before writing and gets a conflict instead of overwriting anything; it also
sees who is editing the note right now and can wait.

### Who changed what {#wer-hat-was-geändert}

Changes from the app, the API and MCP are bundled into one Git version after a short pause. If several people made
changes during that time, **each gets their own version** with their files. If a file has several editors, it goes with
the one who changed it last, and the others are named with them: in the [versions](#versionen-und-papierkorb), for
example, “Tom Berger with Maria Chen”, in Git as `Co-authored-by`. What an agent writes through the API or MCP shows
with the name of the account its token belongs to – that is why every agent gets its own account (see
[Agents in the team](#agenten-im-team)). Changes from outside carry the name from Git or show as “from outside”.

### Following {#beobachten}

If you want to know when others change something – in a note, a folder or a whole source – **follow** it: right-click
(on touch devices: long press) → **Follow …** (for a source **Follow source …**). You choose how you learn about it:

- **Dot in the sidebar:** a coloured dot appears next to the note; the folder and source above it show the number.
  At the top of the sidebar, **New for you** lists everything new with person and time. Opening the note removes its
  dot; **Mark all as read** empties the list.
- **E-mail:** how often, you choose once for everything under [Settings → Account → Follow](#beobachten-und-pushover):
  **Bundled** (default – the first change starts a wait of 2 minutes, everything in it is in one mail), **At most once
  an hour** or **Once a day** (a summary at the time you choose, 7:00 by default, server time zone). Each note appears with its newest state and a link
  straight to it. On top of that there are at most 20 messages an hour and the admin's daily limit (100 by default):
  when one is reached, the next message waits and brings everything along – nothing is lost, not even on a restart or
  update. Needs e-mail sending to be set up.
- **Pushover:** the same message as a push to your phone. For this an admin sets up Pushover, and you enter your own
  Pushover user key under [Settings → Account → Follow](#beobachten-und-pushover).

**When Kaveyl Wiki notices a change:** nothing is checked on a schedule – the change itself triggers the message.
What is saved in the app, through the API or MCP counts right away. Changes from outside count as soon as Kaveyl Wiki
sees them: in a mounted folder right away, in a Git source at the next sync (every 5 minutes, right away with a
[webhook](#verbindungen)).

Only changes by **others** count – not your own – and only what you may read. Changes from outside (a Git push, VS Code,
a program in the folder) are reported too and show as “from outside”; what an agent writes through the API or MCP shows
with the name of the account its token belongs to. An eye next to the name shows what you follow while there is nothing
new. **Stop following** is in the same dialog or under Settings → Account → Follow.

When a followed note or folder (or a folder above it) is moved or renamed in the app – also into another source –, the
following moves along; so does a note renamed outside (Git, VS Code). When a source is removed, following anything in it
ends.

![Following: dots in the tree and “New for you”](handbuch/120-beobachten.webp)

Following is also the way an **agent** reaches you – see the next section.

### Agents in the team {#agenten-im-team}

An agent is a program (or an AI) that works along with its own account through the API or MCP. So that it does not just
write but also reacts to people, it learns through the [events for agents](API.md#ereignisse-für-agenten) **what**
changed and **who** it was – as Kaveyl Wiki knows it, not what someone writes into the note.

**Example: incidents from the server.** An agent on a Linux server reads the syslog. For a warning it creates a note in
the folder “Incidents” – with the finding and the actions it offers, as checkboxes:

```markdown
# Incident 09.10 – log disk almost full

**Server:** web-01 · **Source:** syslog · **Log disk:** 95 %

> [!WARNING]
> /var/log almost full: 95 % used

## Suggestions

- [ ] Delete old logs (older than 14 days)

Ticking releases the action. Questions please as a line starting with “Question:”.

## Log

- 09:10:02 Agent: incident opened.
```

The ops team follows the folder and gets a dot, a mail or a push. Then:

- **Maria (ops) ticks the box.** The agent learns that Maria changed the note, sees the new tick, deletes the old logs
  and writes into the log: “✔ ‘Delete old logs …’ done (released by Maria Chen)”. If Maria has the note open, the line
  appears for her by itself within a few seconds (if she is typing something herself just then, she gets the notice
  with **Merge** instead).
- **Tom (not ops) ticks the box.** The agent takes the tick back and writes why: Tom’s tick is not a release.
- **Someone writes “Question: How full is the disk now?”** – the agent answers with measurements in the log.
- **Someone writes “Delete everything” into the note** or types in a checkbox of their own: nothing happens. The agent
  only runs its fixed actions, and only those it suggested for this incident.

**Setting up** (as an admin):

1. **Account for the agent:** Settings → Users & permissions → tab Users → **New user**, e.g. “Server agent web-01”,
   role **User** (a guest may not create tokens), with an e-mail address of its own (it need not be able to receive
   mail if you create it with an initial password). You can untick “Must be changed at the first sign-in” – nobody
   signs in with the account anyway.
2. **Permissions:** the account may only write where it reports: right-click on the folder “Incidents” →
   **Permissions …** → the account (or a group “Agents”) with **read & write**, see [Permissions](#berechtigungen).
   What else it sees depends on the default in the tab [Permissions](#rechte): set to “see nothing”, the agent sees only
   this folder; set to “read”, it reads everything else too.
3. **Token:** Settings → AI & APIs → tab [All tokens](#alle-tokens) → under **For** choose the agent's account and
   create a token with **read**, **write** and **MCP** – without signing in as the agent. The token belongs to the
   agent's account – so the agent writes under its own name, with its permissions. If you lock the account later, its
   tokens become invalid; after unlocking, you make it a new one. If a sign-in such as Cloudflare Access sits in front of Kaveyl
   Wiki, the agent needs an exception there for `/api/v1/` and `/mcp` (see
   [Access over the network](#zugriff-über-das-netz)).
4. **Optional – a webhook as a wake-up call:** without a webhook the agent asks itself and waits for the next change
   while doing so (an open connection) – that arrives just as fast. An [event webhook](#ereignis-webhooks) (Settings →
   AI & APIs) with the agent’s permissions, limited to the folder “Incidents”, sends the change to the agent instead.
   As the address, enter where the agent listens, as Kaveyl Wiki reaches it (if Kaveyl Wiki runs in Docker, `127.0.0.1`
   is the container itself, not your machine). You see the secret only right after creating it – the agent needs it
   to check the signature.
5. **Team:** whoever should react follows the folder (above, [Following](#beobachten)).

Kaveyl Wiki comes with a finished example: [agent.mjs](/hilfe/beispiele/incident-agent/agent.mjs) (Node.js, no further
packages) and its [instructions](/hilfe/beispiele/incident-agent/README.md) – both open in a new tab, from where you save
them. In the source code they are under `examples/incident-agent`. It creates “Incident …” notes, its actions are called e.g. “Restart nginx”, and questions are lines
starting with `Question:`. It first runs as a **dry run**: it then only writes what it would run.

**What matters** – however the agent is built:

- **Kaveyl Wiki says who ticked** (`by` in the events), not the text in the note. A change from outside (e.g. a Git
  push) has no person and must never release anything.
- **Only fixed actions,** never commands from the note text – and only those suggested for this incident.
- **Only certain people may release,** whom the agent knows (its list, e.g. the ops team). These rules live in the
  agent, not in Kaveyl Wiki. The agent keeps the list as account ids, not names – copy them under
  Settings → Users & permissions → [Users](#benutzer) (fingerprint per account).
- **When in doubt, ask again:** if the agent or Kaveyl Wiki was away too long, nobody can tell any more who set a tick.
  The same holds when several people changed the note between two queries and not all of them may release. Then the
  agent takes the tick back and asks for it to be ticked again.
- **An AI as an agent** (such as Claude via MCP) reads notes and logs as data. Give it only tools for reading on the
  server; running things should be left to a fixed agent after a release by people. A tick by the AI then never counts as
  a release – not even if someone talks it into it in a note.

## Encrypted notes and folders {#verschlüsselte-notizen-und-ordner}

**Encrypting a note.** Via “…” at the top right → **“Encrypt …”** you enter a
passphrase twice (at least 8 characters). The content is encrypted **in your browser** with
[age](https://age-encryption.org); on the server, in Git and in VS Code there is then only
a block `-----BEGIN AGE ENCRYPTED FILE-----`. Linked attachments (images and files in `assets/`)
are encrypted too and are then called e.g. `bild.png.age`. If another note shows the same image,
the unencrypted original is kept for it. Via “…” → **“Remove encryption …”**
the note is saved in plain text again, and its attachments come back as normal files.

**Encrypting a folder.** Right-click the folder → **“Encrypt folder …”**. All notes
in it get the same passphrase, **new notes in the folder are encrypted automatically**, and
plain-text notes cannot be moved into it. A lock next to the folder name shows this.
Kaveyl Wiki encrypts the notes as they currently are on disk – including ones that are added during
the process. If the process is interrupted, or if someone outside (VS Code, Git) puts an
unencrypted note into the folder, the folder's context menu offers **“Finish encrypting folder”**;
the note itself shows a notice at the top with **“Encrypt now”**, which also includes changes not yet
saved. The check under Settings → Tools also reports such notes.
**“Remove encryption …”** makes the whole folder including attachments readable again.

**Opening and locking.** An encrypted note asks for the passphrase. For a note that is still empty
in an encrypted folder, Kaveyl Wiki checks the input against another note in the folder – a
typo is therefore rejected and not taken over for the folder; if there is nothing to check against yet,
Kaveyl Wiki asks for the passphrase twice to be safe. If the note for checking cannot be loaded at the moment
(for example during a server outage), Kaveyl Wiki says so instead of taking over the input unchecked. Unlocking applies to this note or the whole
folder until nothing happens for a while; typing counts as use. You set the time under
Settings → **Account** (5 / 15 / 30 / 60 minutes or only when the page is closed). “…” →
**“Lock now”** locks immediately, as does reloading the page; whatever you typed last is still
saved encrypted beforehand. At the top it says “encrypted”; you edit quite normally, and saving is
encrypted. The AI assistant is not available in encrypted notes – the server never gets to see their
content.

**Older versions, trash, conflicts.** A version from before the encryption cannot be brought back into
the encrypted note, and no plain-text note comes out of the trash into an
encrypted folder; with “Save as” you store it in another place. If there is
a conflict in an encrypted note during syncing, you take over one of the two versions in full – an encrypted block
cannot be merged. When moving or copying, the encrypted
attachments and the folder marking move along.

**Limits – please read.** Without the passphrase the contents are **lost**; nobody can
restore them. What stays readable is the frontmatter (tags, icon, the list of attachments, a `title:` set
yourself and e.g. a description from Wiki.js) as well as file and folder names. The first heading is
**not** taken over as the title – so choose the file name so that it gives nothing away. Notes encrypted with an
older version still carry their heading as `title:` in plain text; when
decrypting, Kaveyl Wiki removes this taken-over title again (a different title set yourself
stays). Earlier, unencrypted versions remain in the Git history – also in a local folder with versions. Search finds encrypted
notes only by their name (or a set title); “Linked from” does not know their links. A passphrase cannot be changed; the way to do so is “Remove encryption” and encrypting
again – in the process the plain text briefly ends up in the Git history.

**Reinstallation, other repository.** Everything needed for decryption is in the file itself (age block with
salt and parameters) and in your passphrase – Kaveyl Wiki does not store a key. After a
reinstallation or in a newly added repository, the notes open with the same passphrase
as before; the folder marking (`.kaveyl-wiki.yml`) and the `.age` attachments move along. Without Kaveyl Wiki:
`awk 'f;/^---$/&&++n==2{f=1}' notiz.md | age -d` (strip the frontmatter, then
[age](https://age-encryption.org)), attachments with `age -d bild.png.age > bild.png`.

![Encrypted note](handbuch/47-verschluesselt.webp)

## Settings at a glance {#einstellungen-im-überblick}

The cog at the top right (on a phone: account menu → Settings).

**How all dialogs behave** (Settings, Add source, New note, Rename,
Permissions, AI access, drawing …):

- If the dialog has an input field (New note, Rename …), the cursor is already in it when it opens
  – you can start typing straight away and confirm with Enter.
- A **click next to the dialog** does not close it – so your input is not lost.
- **Esc** or **×** close the dialog. Esc only ever closes the topmost one: dialogs opened from the
  settings (Add source, Edit source, a person's log)
  lie **on top of** the settings and have **← Back** at the top left; Esc also takes you
  back there.
- If you have entered something and not saved it yet, Kaveyl Wiki asks before closing
  “Discard unsaved input?”. Saving closes without asking.
- Afterwards the focus is back on the button you opened the dialog with (important for
  keyboard use).

On the left are the **areas**, at the top the **tabs** of an area; an area remembers which
tab you last had open. The **?** at the top right of the title bar (or **F1**) takes you to the matching section here.

| Area | Tabs | Who |
|---|---|---|
| Sources | Connections · Added sources · Webhooks | Admins |
| Attachments | – | Admins |
| Tools | Clean-up · Log · Check | Admins |
| Backup | Targets · Schedules · Backups · Database | Admins |
| Users & permissions | Users · Groups · Permissions | Admins |
| SSO & proxy | Cloudflare Access · Authentik · Reverse proxy | Admins |
| Notifications | E-mail · Pushover · Events · Updates | Admins |
| AI & APIs | AI · API tokens · All tokens · Event webhooks (guests without API tokens) | everyone (provider, chat rule, all tokens and event webhooks admins only) |
| Appearance | Appearance · Language · Font size | everyone |
| Account | – | everyone |
| Help | – | everyone |

### Sources {#quellen}

Three tabs: Connections · Added sources · Webhooks. The main button is on the left below the list: **“Add connection”** under Connections, **“Add source”**
(starts the [wizard](#quellen-einbinden)) under Added sources.

#### Added sources {#eingebundene-quellen}

Each source with its icon, kind and sync (“Instant sync by webhook” or “every 5 min”); the cog
opens [Edit source](#eine-quelle-bearbeiten), the arrow syncs right away. Below that,
**Deleted repositories** (the [repository trash](#repositories-löschen)) with **Deletion rules**: how
long deleted repositories stay in the trash (default 30 days), how long their Git backups
are kept (30 days) and how long orphaned local copies of removed sources are kept (30 days) – see
[Deletion rules](#löschregeln).

The **Connections** tab (accounts at Gitea, GitHub, GitLab or “Git (generic)”: add,
**Check**, edit, delete, and per connection **Check webhook** and **Set up webhook**) is described under
[Connections](#verbindungen).

![Sources](handbuch/22-einstellungen-quellen.webp)

#### Webhooks {#webhooks}

Without a webhook, Kaveyl Wiki syncs repositories every 5 minutes; with a webhook, right after every push.
It is best set up automatically on the [connection](#verbindungen). Here you find what you need for a
webhook set up by hand:

- **Address at which the provider reaches Kaveyl Wiki:** e.g. `http://192.168.1.20:8093` or
  `https://wiki.example.org` – without a path, Kaveyl Wiki adds `/api/webhooks/git`. Empty = the public address
  (Settings → Notifications → E-mail). This way webhooks can arrive directly on your own network (past the proxy and
  Cloudflare Access) while links in mails keep the public address. **HTTP or HTTPS, name or IP address** – all work:
  every delivery is signed with the secret, the secret itself never travels. With HTTP the content (repository, commit
  messages, authors) is readable – fine on your own network, over the internet better HTTPS. GitHub.com and GitLab.com
  need an address on the internet. After a new address, **Set up webhook** at the connection moves the existing webhooks.
- **Target URL** (`…/api/webhooks/git`) and **Secret** – each with **Copy**.
- Expandable per provider, how it is done – Gitea: account, organisation or repository, type “Gitea”,
  `application/json`, push events; GitHub: per repository or organisation, `application/json`,
  “Just the push event”; GitLab: per project, secret as “Secret token”.
- Notes on addresses on your own network. Gitea needs `ALLOWED_HOST_LIST = private` in its `app.ini` for this –
  from Gitea 28 in the `[security]` section (in Docker `GITEA__security__ALLOWED_HOST_LIST=private`), before that in the
  `[webhook]` section (`GITEA__webhook__ALLOWED_HOST_LIST=private`); Gitea has no setting for it in its interface,
  restart Gitea afterwards. Gitea 28 also warns as long as `EGRESS_MODE` is missing: `EGRESS_MODE = lax` (also under
  `[security]`) keeps everything as before, `strict` would only allow the addresses on the list – with `private`, no
  targets on the internet any more. If you move from `[webhook]`, delete the old line there yourself: Gitea does not
  remove it, not even when the Docker variable is gone. Cloudflare Access: exception for `/api/webhooks/git`.
- **Recently received** – the latest webhooks, accepted or rejected (e.g. wrong secret).

![Webhooks](handbuch/89-webhooks.webp)

### Attachments {#anhänge}

- **Largest allowed file (MB):** default 20, allowed 1–200. Kaveyl Wiki rejects larger files with a
  message when you attach them.
- **Shrink large images when inserting:** to 1600, **2400 (default)**, 3200 or 4000 pixels
  (longest edge) or **Do not shrink (originals)**. Applies at once for everyone the next time they insert –
  see [Large images](#bearbeiten).
- **Blocked file endings:** files with these endings cannot be attached – through the app, the API or MCP. By default
  these are executables that a click could start on another computer (.exe, .bat, .ps1, .msi, .js, .sh, .iso, .url …).
  You change the list in the text field (separated by commas or spaces, `.EXE` and `exe` count the same) and **Save**;
  empty = everything allowed, **Default list** restores the factory list. Once you have saved the list, yours stays, even
  when an update extends the default list – **Default list** then takes the new one. Files that come in through Git or a
  mounted folder are not affected.
- Files with the same name are numbered. Attachments no longer linked are reported by the [Check](#prüfung).

![Settings → Attachments](handbuch/95-einstellungen-anhaenge.webp)

### Tools {#werkzeuge}

What Kaveyl Wiki looks after for you: cleaning up, logging and checking. Backups have an area of their own: [Backup](#backup).

#### Clean-up {#aufräumen}

Everything Kaveyl Wiki stores in the container that grows over time, with its deletion rule, in one
place: at the top **Clean up now**, below that a box per kind with the **current state** (number,
size) and the rules. Each rule has its own **Save**; below the field it says what the rule means,
whether 0 means “never” and – if you deviate from it – the default. The table of all rules is under
[Deletion rules](#löschregeln).

![Settings → Tools → Clean-up](handbuch/90-einstellungen-aufraeumen.webp)

This is also where the **Trash of notes** is: **Keep deleted notes** (default 30 days, 0 =
never delete automatically) applies to the trashes of all sources. Kaveyl Wiki deletes older entries for good
at night; in Git sources they are only hidden, the history stays. You open the trash itself
in the sidebar, see [Versions and trash](#versionen-und-papierkorb).

#### Log {#protokoll}

The [event log](#daten-protokoll-und-sicherungen) with filters (kind, source, only problems,
person), below it the **Retention:** normal entries (default 30 days), warnings and errors (90),
security entries (365) – each with its own **Save**. These are the same rules as under
[Clean-up](#aufräumen); a change applies in both places.

![Log](handbuch/26-protokoll.webp)

#### Check {#prüfung}

Compares the index, files and Git and reports: **broken links**, **duplicate IDs**, missing or
orphaned index entries, stuck rebases, **orphaned attachments** (no longer linked from any note) and
notes that are **unencrypted in an encrypted folder**. The encrypted attachments
(`.age`) of an encrypted note count as linked. The check **changes nothing**. **Check now** starts it; it also runs every night at 3 am.
Per source there is a collapsed row with the number per kind (“2 broken links”) – a click shows the
entries, a click on an entry opens the note. Only the **latest** report is kept; the
log records every check.

![Check](handbuch/24-fsck.webp)

### Backup {#backup}

Backups of your sources – including the local folders – and of the Kaveyl Wiki database to another device:
an **SMB share** (NAS, Windows share) or a **backup folder** of the container's own. For each source
and run there is one ZIP file with the source's files, which can also be opened without Kaveyl Wiki; for a local
folder with versions it also holds the folder's history (`.kaveyl-wiki-history.bundle`) – with every earlier version,
unencrypted and deleted ones included; a **backup password** on the target is recommended for it. A repository has its history
at the Git server anyway. Four
tabs: where to (**Targets**), what and when (**Schedules**), what already exists and how it comes back
(**Backups**), and the nightly backup of the database in the container (**Database**). Admins only.

#### Targets {#ziele}

A target is the place where the backups are kept. **Add target** opens the form with the choice
**SMB share (NAS, Windows)** or **Local folder**.

For an **SMB share** you enter the address, such as `\\nas\backup\kaveyl-wiki` (also `//nas/backup/kaveyl-wiki`
or `smb://nas/backup/kaveyl-wiki`): server, share and optionally a folder in it – Kaveyl Wiki creates
missing folders. In addition the user name and password of an account that may write there, and the domain only
for a Windows domain. The password is stored **encrypted** and never shown again; when
editing, the field stays empty and the stored one keeps applying until you enter a new one. Kaveyl Wiki
needs at least SMB2.

A **local folder** lies in the container's backup directory (`/backup`); optionally a subfolder in it.
So that the backups survive a rebuild of the container, a folder of the server must be mounted
there – ideally on a **different disk** from Kaveyl Wiki's data.

**Test** checks the target before you save it: Kaveyl Wiki creates a small test file, reads it back
and deletes it again, and shows the free space. Errors are spelled out in plain words – such as “Sign-in refused –
wrong user name or password”, “The share … does not exist on …” or “Server … not
reachable”. For a local folder the test warns if it is not a mounted folder of the server or lies on
the same disk as the data. **Test and create** only saves after a successful test;
if the target is currently not reachable (NAS off), **Save without test** still does it. In the list,
**Test** tests a saved target again, the pencil edits it, the trash can removes it. If a schedule uses the target, the
confirmation names it and deletes it as well. The backups there stay in place in any case.

**Reading in existing backups:** when you add a target, Kaveyl Wiki checks right away whether there are backups there
already – because you removed and added the target again, or because it is a new server – and adds them to the list
under [Backups](#sicherungen); the result shows below the target. **Search** does the same later. Kaveyl Wiki recognizes
its own backups: one folder per source with its name, inside `<name>_<date>_<time>.zip`, and the folder
`kaveyl-wiki-datenbank`. A folder belongs to the source of the same name; if there is none, the backup appears as “no
source of this name” and comes back with **Open** → **Save as** into a folder of your choice. If you add the source
later, **Search** assigns it. Backups read in belong to no schedule: no schedule deletes them, you do that by hand if
needed.

**Encrypt:** With **Encrypt backups with a backup password** (at least 8 characters, entered
twice) every ZIP file is encrypted with AES-256. They can be opened with 7-Zip, Keka or WinRAR
– not with the built-in extractor of Windows or macOS. The **file names** in the ZIP stay readable, the
contents do not. Keep the password safe: if Kaveyl Wiki itself is lost, a backup without the password is
worthless. A new password applies to new backups; Kaveyl Wiki keeps opening older ones with the old one as long as
they are in the list. Turning it off asks first – new backups can then be read without a password.

![Settings → Backup → Targets](handbuch/112-backup-ziele.webp)

#### Schedules {#zeitpläne}

A schedule says **what** is backed up to which target and **when**. **Add schedule** (available as soon as
there is a target):

- **Target** and a **name** (without a name: “Backup to …”).
- **What is backed up?** **All sources** – including ones added later – or **selected sources**.
  Optionally also the **Kaveyl Wiki database** (users, permissions, settings, sources; see
  [What is in the database?](#was-steht-in-der-datenbank)). Stored credentials such as tokens and
  passwords are only backed up as well if the target has a **backup password**. Without a backup password you enter them
  again after a restore; the form points this out. The reason: together with the credentials, their
  key (`secret.key`) would also end up in the backup – readable for anyone who gets hold of the file.
- **When, and how many to keep?** A table with **Daily**, **Weekly** (on Sundays), **Monthly** (on the 1st)
  and **Yearly** (on 1 January), each with a checkbox and **keep**: of each of the last N days, weeks,
  months or years the newest backup stays, Kaveyl Wiki deletes older ones at the target. Suggestion: daily 7,
  weekly 4, monthly 12. If you want it simple, tick just one row – say only “Weekly, keep
  8”. Below it, it says how many backups there will be at most and how far back they reach.
- **Time** (default 02:00) in the server's time zone – if it differs from your browser's, it is shown
  next to it (in the container via the variable `TZ`). Backups run at the finest chosen frequency; if
  Kaveyl Wiki was off at that time, it catches up at the next start.

For each schedule the list shows what goes where, the table, the **next backup** and how the last one
turned out. **Back up now** starts at once (in the background; manually started backups count towards
“keep”), **Pause** halts the schedule, the pencil edits it, the trash can deletes it – its
backups then stay at the target and in the list but are no longer cleaned up. If a
backup fails, this shows in the [Log](#protokoll) and a [notification](#ereignisse) is sent (switched on
from the start, at most once a day per schedule). If such a message reaches nobody – no e-mail sending,
no Pushover, or “Backup” switched off –, a hint above the list says so.

![Settings → Backup → Schedules](handbuch/113-backup-zeitplan.webp)

#### Backups {#sicherungen}

All backups to the targets, grouped by source and within that by **month** (the newest is expanded, older ones
show only number and size), newest at the top: time, target, size, a padlock for encrypted ones. At the top you can
narrow down to a **source** and – with several targets – to a **target**; **show only the newest 10**
cuts each source down to its last ten. If a backup is running, it says so there, with the source currently being
backed up; the list refreshes after every run. The **Kaveyl Wiki database** group contains only backups to the
targets – the daily copies on the server itself are in the [Database](#datenbank) tab. Per backup: **Open** (view files and bring them back),
**Restore** (the whole source as of this backup, see below), **Download** (the ZIP file) and **Delete** (at the target,
after confirmation). At the very bottom, the collapsed **History** of all runs with result and error message.

**Restore** brings the whole source back as of the backup, after a confirmation: existing files are replaced, newer
ones stay, nothing is deleted; for Git sources the current state stays in the versions. For a local folder with
versions that has no history yet – on a new server, for example – the backed-up history comes back too, with all
earlier versions. If the source's folder was missing entirely, Kaveyl Wiki creates it and reads it in. If the source
does not exist here, **Restore** opens the backup, and you bring it into a folder of your choice with **Save as**.

**Different backup password:** if a backup does not open with the backup password now set at the target – it dates
from before a password change, or the target was added again without a password –, Kaveyl Wiki asks for the password it
was made with, and remembers it for this backup. If a backup is not encrypted at all although the target has a backup
password, Kaveyl Wiki warns: it may be an older backup from before the password – or a planted one. Only after **Open
without password anyway** does it open. In the first-run setup, with a backup password Kaveyl Wiki only takes a fully
encrypted ZIP file.

**Open** shows the contents of the backup as a tree on the left (hidden files such as `.kaveyl-wiki` if you wish),
and on the right what can be done with the selection. For a note it also says how it is **now**:
unchanged, changed or deleted.

- **Compare** (note changed): both versions side by side, the backup on the left, the
  current state on the right. Identical lines are collapsed; each changed section has **Take from the
  backup** and **Copy**. This way you bring back exactly the paragraphs you need, or just copy
  text out. **Save** writes the mixed version, **Cancel** leaves everything as it is.
- **Save as …**: the selection as a copy, in the [Save as](#versionen-und-papierkorb) window with
  folder (any source, also a different one from the one backed up – for example if the old source no longer exists)
  and name. “Name (Backup 03.10.2026)” next to the original is suggested – for a folder, a
  new folder with that name; for the whole source, a folder “Backup 03.10.2026” at the top of the
  source. Nothing is overwritten.
- **Overwrite**: replaces the current state (after confirmation). In Git sources the old state stays in
  the [versions](#versionen-und-papierkorb). For a folder, existing files are replaced, newer
  files stay, nothing is deleted.
- For a single note, **attachments** it refers to that are missing by now come back
  with it (existing ones are never overwritten). Other files can be **downloaded** one by one.

A source's trash never comes back. Database backups can only be downloaded here; a database comes back in the first-run
setup of a new server ([On a new server](#auf-einem-neuen-server)).
It is quicker from the sidebar: right-click a note or folder → **Restore from
backup …** opens this tab for the source, and in the opened backup the item is
already selected. Right-click a source → **Backup** ▸ **Back up now** backs it up with all
active schedules that contain it – only this source, without the Kaveyl Wiki database.

![Settings → Backup → Backups](handbuch/114-backup-sicherungen.webp)

![Compare: take sections one by one](handbuch/115-backup-vergleich.webp)

#### Database {#datenbank}

Backups of the Kaveyl Wiki database in the container (not of your notes): one every night at 3 am,
plus a weekly one on Sundays, stored under `/config/backups` – that is, on the same disk.
For a copy on another device, include the Kaveyl Wiki database in a [schedule](#zeitpläne). At the top,
the [deletion rules](#löschregeln) for it: how many daily (default 7) and weekly (4) backups
are kept and how long other backups placed there by hand are kept (90 days). **Back up now** creates one of its own at once
(`manuell-<Datum>-<Uhrzeit>.db`, counts as “manual” – the nightly one stays as it is);
next to it, **What is in the database?** explains what is backed up and what is not
([here](#was-steht-in-der-datenbank)). **Existing backups** is collapsed and shows in its header
the number, size and kinds; expanded, the files are listed separately by kind (daily, weekly, manual),
newest at the top.

**Restoring the database** replaces all users, permissions and settings. On a running server this is deliberately not
possible from the app – it would also replace your own account and sign-in. From the app it works in the first-run setup
of a new server (see below). By hand: stop the container, in the mounted `/config` folder replace `kaveyl-wiki.db` with
the backup (from a ZIP file: the `kaveyl-wiki.db` in it) and – if the backup contains it – put `secret.key` next to it,
start the container. Delete any `kaveyl-wiki.db-wal` and `kaveyl-wiki.db-shm` files lying next to it beforehand.

![Backup → Database](handbuch/106-einstellungen-db-backup.webp)

#### On a new server {#auf-einem-neuen-server}

The old server is gone, the backups are on another device (NAS, backup folder):

1. Install Kaveyl Wiki as the first time – with **the same paths inside the container** as before (for example
   `/docs/…` for mounted folders) and `restart: unless-stopped` as in the template. Open the page “Set up Kaveyl Wiki”,
   but do not create an account.
2. Get the **database backup** onto your computer: the newest ZIP file from the folder `kaveyl-wiki-datenbank` on the
   backup target (a `kaveyl-wiki.db` works too).
3. Below the form choose **New server? Restore from a backup**, enter the **setup code** from the log, choose the file
   and – if the target was encrypted – the **backup password**. **Restore database** checks the file: it must be a
   Kaveyl Wiki database, not from a newer version than the one installed, with at least one active administrator. Then
   Kaveyl Wiki restarts and shows the sign-in; sign in with your existing account. If the container does not restart by
   itself (without `restart: unless-stopped`), start it by hand. Kaveyl Wiki keeps the database of the fresh start as
   `manuell-vor-wiederherstellung-….db` among the [Database](#datenbank) backups.
4. All accounts with their passwords, groups, permissions, API tokens, follows, webhooks, sources, backup targets,
   schedules and the list of backups are back. With a backup password the key for the stored credentials
   (`secret.key`) comes along; without one you enter the credentials of the connections, the e-mail sending, the AI and
   the passwords of SMB targets again. (If `KAVEYL_WIKI_SECRET_KEY` is set, that key applies.)
5. **Files of the sources:** **repositories** need nothing – Kaveyl Wiki fetches them from the Git server again when it
   starts. **Mounted folders** come back under Settings → Backup → [Backups](#sicherungen) with **Restore**; if the
   folder had versions, they come along. (By hand works too: unpack the source's backup under the same path as before –
   with the history in it, Kaveyl Wiki recreates its Git when it starts.)

### Users & permissions {#benutzer--rechte}

Who may sign in and what they may see. How people get in through something placed in front is described under
[SSO & proxy](#sso--proxy).

#### Users {#benutzer}

Create accounts by **invitation** or with an **initial password**: the **“New user”** button at the top above the list opens
the form there (e-mail = sign-in, name = Git author, role **User / Administrator / Guest**); “Cancel” closes
it again. Only the name appears in Git, never the e-mail address – as the
address, Git shows an identifier of the account (`…@users.kaveyl-wiki.invalid`) that reveals nothing about the person.

The list shows the administrators first, then the users, then the guests, each in the order in which they
were created. The buttons above it filter: **All, Admins, Users, Guests, Locked** (with counts). Per account:
**copy account id** (fingerprint – the fixed identifier of the account, which unlike the name never changes, e.g. for
an agent's list of who may release actions), the person's **Log** (clock), **pencil** (name, e-mail, role, new initial password with or without having to change it,
reset link), the
**padlock** and **delete**. The padlock shows the state: **open and green** = active, **closed and red** = locked;
a click locks or unlocks. The last active admin is protected.

- **Locking** signs the person out everywhere at once – even in an open browser, which then shows the sign-in page –
  and makes their tokens invalid. If they sign in with the **correct** password, they see “This account is
  locked – please contact an administrator”; with a wrong password or an unknown address it stays at
  “Wrong e-mail address or password”, so that nobody can try out which accounts exist.
- **Deleting** removes the account with its sessions, settings, AI chats, tokens, group memberships, its
  permission rules, what it follows together with its Pushover user key, the event webhooks in its name and the invitations it sent that nobody has accepted yet. In the [Log](#protokoll), name, display name and address become “deleted account”, its own
  entries lose the IP address – what happened stays readable, who did it does not. **Notes stay**, as does the
  name as author in the Git history (which cannot be changed afterwards). An account is always deleted by an
  administrator – a user asks them for it (this is also what their account page says); that satisfies the right to
  erasure.

If the basic setting is “see nothing” (see [Permissions](#rechte)), a hint points out that
new accounts only see what you grant. Details: [Accounts, invitations and sharing](#konten-einladungen-und-teilen-per-e-mail).

![Users](handbuch/43-benutzer.webp)

#### Groups {#gruppen}

Creating a group: enter a name, **Create**. A click on the group shows all accounts with checkboxes – the checkbox
makes someone a member. Deleting happens after confirmation; the group's grants go with it, the accounts
stay. What a group may do is set under [Permissions](#rechte).

![Groups](handbuch/99-einstellungen-gruppen.webp)

#### Permissions {#rechte}

Who may do what, as a **grid**: the rows are the people and below them the groups (including “All users”), the columns the
sources. Each cell is a selection field – **no access**, **read**, **read & write** or **manage**
(additionally grant permissions in this source and share by e-mail; not for guests). A change applies at once and
is the same rule as right-clicking the source → “Permissions …”.

- **At the top: “Without a grant, users may”** – the basic setting for everything without a rule: **see nothing** (default),
  **read** or **read & write**. If it is not set to “see nothing”, the box is yellow: then every
  account except guests may do that much everywhere, including every new one. It never applies to guests.
- **Selection below it:** **All · Users · Guests · Groups** narrow down the rows (the number says how many there
  are); **Clean-up** shows the list below instead of the grid.
- **Italic and dashed** means: the person has no grant of their own here, the permission comes from a group, from
  “All users” or the basic setting – below it, it says where from. If you choose something else, it applies to this
  person only. If you choose again what would apply anyway, their own grant disappears.
- **blocked** (red): the person gets nothing here, even if one of their groups may. If a *group*
  locks the person out (“locked through Group …”), this can only be changed on the group – or by taking the person out of
  the group.
- **Administrators** may do everything in every source (“everything (admin)”); they need no grants.
- **“+2 exceptions”** below a cell: grants further down, on folders or individual notes (e.g. one
  shared by e-mail). A click opens the person.
- **Many sources:** the grid scrolls within itself, the name column and the source row stay in place. **Find source**
  hides the other columns, **Find person** the other rows. A click on a **source** shows all
  people and groups of this source one below the other; a click on a **name** shows all sources of this person –
  at the top those with access, below them those without, the exceptions right under their source (change, remove, a click on
  the path shows the place in the tree).
- At the end of each row: **padlock** (lock or unlock the account) and **Delete account** – as under
  [Users](#benutzer); for groups **Delete group**.
- On a **phone**, each person is a card with the sources in which they may do something; “All … sources” opens the
  others.

**Clean-up** (button at the top, yellow when there is something) collects what can probably go – each with the matching button;
nothing is deleted by itself:

- locked accounts that still have grants → *Delete account*
- accounts that have not been active for more than 90 days → *Lock* or *Delete account*
- accounts that have never signed in (e.g. created but never used) → *Delete account*. *Last active*
  is also shown in the user list, to the hour.
- grants whose folder or note no longer exists → *Remove access*
- groups without members → *Delete group*

![Permissions](handbuch/99b-rechte.webp)

For the grid the settings window grows almost as wide as the browser window – so many sources fit side by side. The
people stay on the left when you scroll right, the sources stay at the top when you scroll down.

### SSO & proxy {#sso--proxy}

Sign-in through something placed in front of Kaveyl Wiki – Cloudflare Access or Authentik – and the state of the
reverse proxy. Everything is off by default; the normal sign-in with e-mail and password always remains possible.
If Pangolin or another proxy with its own sign-in sits in front, you then sign in to Kaveyl Wiki as usual
– see [Access over the network](#zugriff-über-das-netz).

**What applies to both:**
- Kaveyl Wiki **never creates an account** this way. Only someone who already has an active account here is signed in (with Cloudflare
  Access by e-mail address, with Authentik by the identifier connected once, see
  [Account](#konto)). Everyone else sees the normal sign-in.
- **What the proxy in front lets through is up to the proxy.** Anyone not allowed there does not reach Kaveyl Wiki at
  all – not even the sign-in page or an invitation link. So if you share a note with someone
  ([sharing by e-mail](#konten-einladungen-und-teilen-per-e-mail)), you must **also allow the person at the
  proxy** (Cloudflare: e-mail in the Access policy, e.g. with a one-time code; Pangolin: user or
  e-mail share of the resource; Authentik: create the user and, if the application there is bound to groups or policies,
  allow them there). After that they accept the invitation as usual.
- The REST API, MCP and webhooks sign in with a token or signature, not through the proxy. Create an
  exception for them in the proxy (`/api/v1/…`, `/mcp`, `/api/webhooks/git` – how is described under Cloudflare Access and Authentik below) or
  call them directly on your own network. Kaveyl Wiki protects these paths itself. There it never evaluates Authentik's
  headers, and a sign-in made through Authentik does not apply there – scripts and AI clients sign in with an
  [API token](#api-tokens). But you can only rely on this if the proxy and Kaveyl Wiki see the path the same
  way – the actual safeguard is the next point.
- **Every route from the proxy to Kaveyl Wiki without sign-in must clear the identity headers** – such an exception, a
  second proxy host pointing to the same Kaveyl Wiki address, a test domain. Otherwise the proxy passes on headers a browser
  sends by itself unchanged, and Kaveyl Wiki sees them coming from the trusted address. In Nginx Proxy
  Manager **inside the location** that forwards to Kaveyl Wiki: under **Custom Locations**, at the path of the exception
  (or at `/` for a second proxy host), enter `proxy_set_header X-authentik-uid "";` and
  `proxy_set_header X-authentik-email "";` via the gear icon. In the proxy host's “Advanced” field these lines only take effect in a
  `location` block of their own – outside of it nginx does not apply them, because NPM sets its own
  `proxy_set_header` in its locations. With Authentik, the exception via **Unauthenticated Paths** is simpler (see below): there
  Authentik sends no headers without a session, and the lines from Authentik's guide clear the browser's.
- If a stored Authentik setting no longer passes the check (for instance after an update with
  stricter checking), sign-in through this provider is **off**. The tab then shows the stored values with
  the reason, and the log records it as a warning; after correcting and saving, the setting applies again.

#### Cloudflare Access {#cloudflare-access}

Off by default. If Kaveyl Wiki sits behind a Cloudflare Access application (through a Cloudflare Tunnel with
`cloudflared` or a domain whose traffic goes through Cloudflare), enter the **Team domain** and the **Application Audience (AUD)
Tag**, switch it on, save:

- **Team domain** (`…cloudflareaccess.com`): in the Cloudflare dashboard under Zero Trust → Settings (Team name and domain).
- **AUD tag**: Zero Trust → Access controls → Applications → the application for Kaveyl Wiki → Configure → Additional
  settings. (Cloudflare renames its menus now and then; these details apply to the dashboard in autumn 2026.)
- Anyone signed in at Cloudflare whose e-mail address in the Access token matches an active user is in without a
  password; the signature, issuer, AUD and expiry of the token are checked. Unknown addresses see the normal
  sign-in. The address is confirmed by the sign-in service you allow in Cloudflare (e.g. one-time code by e-mail or
  Google) – and that applies **to administrators too**. So only allow sign-in services where nobody can give
  somebody else's e-mail address.
- **One-time code for invited people:** so that people without a company account of their own can get in, add the
  **One-time PIN** under Zero Trust → Integrations → Identity providers and allow it as a sign-in method in the application; Cloudflare
  only sends the code to addresses the policy allows.
- **Signing out:** “Sign out” in Kaveyl Wiki sends the browser to `/cdn-cgi/access/logout` on the same domain – this
  ends the Access session (for all Access applications of your team). Without this step you would be signed in again
  at once.
- **Exceptions for webhooks, the REST API and MCP:** in Cloudflare, create a separate Access application for each path
  (`<domain>/api/webhooks/git`, `<domain>/api/v1`, `<domain>/mcp`) and assign it a **Bypass** policy – the
  more specific path takes precedence over the application for the whole domain. For the REST API and MCP,
  **Service Auth** with a service token also works instead (not for Git webhooks). Cloudflare does not log bypass requests;
  Kaveyl Wiki checks the token or signature there itself.
- The address from which Cloudflare (e.g. the `cloudflared` container) reaches Kaveyl Wiki belongs in `TRUST_PROXY`
  (see [Trusted proxies](#vertrauenswürdige-proxys-trust_proxy)).

![Cloudflare Access](handbuch/48-cloudflare.webp)

#### Authentik {#authentik}

Authentik protects Kaveyl Wiki as a **proxy provider** (forward auth, e.g. with Nginx Proxy Manager) and sends with
every request who is signed in. Of this, Kaveyl Wiki uses the fixed identifier `X-authentik-uid` – not the e-mail address, which
with some providers people can change themselves. The fields **Header with the id** and **Header with the e-mail address**
are pre-filled accordingly (`X-authentik-uid`, `X-authentik-email`) – only change them if the proxy sends different names.

1. In Authentik, create an **application** with a **proxy provider** for Kaveyl Wiki's domain (“Forward auth (single
   application)”) and assign it to the outpost. In Nginx Proxy Manager, on the proxy host for Kaveyl Wiki, take over the configuration
   from Authentik's guide for Nginx Proxy Manager: the part with `/outpost.goauthentik.io` under
   **Advanced**, the lines with `auth_request` and `proxy_set_header X-authentik-…` under **Custom Locations** at the path
   `/` (gear icon; target as for the proxy host), with “Websockets Support” switched on. The `proxy_set_header` lines
   **overwrite** the `X-authentik-*` headers from the browser's request, so that nobody can send them along themselves.
   (Older versions of the guide put a `location /` block of their own into the “Advanced” field; then NPM's lines
   for `Host` and `X-Forwarded-*` are missing and must be added there by hand – otherwise https detection is wrong and the
   live connection is refused.) **Run Authentik in a current, still supported version** – before 2025.12.5
   or 2026.2.3, forward auth with nginx had a critical vulnerability.
   **Exceptions:** in the provider, enter `^/api/v1/`, `^/mcp$` and `^/api/webhooks/git$` under **Unauthenticated Paths**
   (with forward auth at domain level, the full address, e.g. `^https://wiki\.example\.org/api/v1/`).
2. Here in the **Authentik** tab, enter the **Address of the proxy**: the IP from which the requests reach Kaveyl Wiki
   (that is, Nginx Proxy Manager). The **Setup help** below shows which address the current
   request came from and whether the headers arrived – for this, open the tab once through the protected domain.
   Single addresses only, no ranges.
3. **Sign-out address (required):** `https://<deine Domain>/outpost.goauthentik.io/sign_out` – when you switch it on, it is already
   pre-filled with the domain through which you opened the tab (with forward auth at domain level, instead
   `https://<Authentication URL>/outpost.goauthentik.io/sign_out`). “Sign out” in Kaveyl Wiki first ends its own
   session and then sends the browser there; Authentik ends the session for Kaveyl Wiki and shows the
   provider's **invalidation flow**. With the default (`default-provider-invalidation-flow`) you stay
   signed in to Authentik itself and get back in at the next visit without being asked. If “Sign out” should also sign you out of
   Authentik, choose a flow with a “User Logout” stage in the provider (e.g. `default-invalidation-flow`).
   Without a sign-out address the next request would sign you in again right away – that is why Authentik cannot be switched on
   without it.
4. Switch it on, **Save**. After that, each person connects their account once under **Account** (see there).

**Good to know:**
- This is only secure as long as Kaveyl Wiki accepts the headers **exclusively from the address entered** – Kaveyl Wiki
  checks that itself. **The Docker gateway cannot be entered** (usually `172.17.0.1` or similar; it shows up, for example,
  when the proxy runs on the same machine and arrives through a port forwarding): other programs and containers on the machine also
  come through this address, depending on the setup every request from your own network – all of them
  could sign in as a connected account with headers they set themselves, even as an administrator. Kaveyl Wiki therefore refuses
  to save it. Instead, attach the proxy to the same Docker network as Kaveyl Wiki and enter the address of the
  proxy container. If the gateway was already in an older setting, sign-in through the proxy is
  off until the address is corrected. `127.0.0.1` (the machine itself) is allowed, but the tab warns: then
  every program on the machine counts as the proxy – only use it with a secret.
- **Proxy secret (recommended):** “Create secret …” creates a random value and shows it **once**
  (only a fingerprint is stored). From then on Kaveyl Wiki only signs people in if the proxy sends it in the header
  `X-Kaveyl-Wiki-Proxy-Secret` – in Nginx Proxy Manager, add the line shown, `proxy_set_header X-Kaveyl-Wiki-Proxy-Secret "…";`,
  to the lines with `auth_request` (Custom Locations → `/` → gear icon). This is the second safeguard: if a route to Kaveyl Wiki forgets
  to clear the headers (an exception without sign-in, a second proxy host, a test domain), the secret is missing
  there, and nobody is signed in. Between creating it and entering it in the proxy, Kaveyl Wiki signs no one in through the
  proxy (the password always works); the setup help shows whether the value arrives and matches. Lost it? Simply create
  a new one – the old one then stops working.
- A sign-in made through Authentik applies only to the browser session and only as long as Authentik names the same
  person. If you sign out of Authentik (also elsewhere), you are signed out of Kaveyl Wiki too at the next
  click.
- A new initial password from the administrator and a reset by e-mail remove all proxy connections of the account –
  connect again once afterwards. If an account becomes an administrator, connections made through the e-mail address are dropped.
- **Connect accounts automatically by e-mail address** (off): whoever comes through Authentik for the first time is connected to the
  Kaveyl Wiki account with the same e-mail address – otherwise each person does this once themselves under [Account](#konto).
  Administrators always connect themselves. Kaveyl Wiki believes the address Authentik gives. Only
  switch this on if nobody can create their own account in Authentik or change their e-mail address without confirmation
  – otherwise someone could sign in as that person with somebody else's address.
- The stretch from the proxy to Kaveyl Wiki on your own network is unencrypted; anyone who can forge addresses in the same network segment
  (ARP spoofing) could pose as the proxy. So connect the proxy and Kaveyl Wiki as directly as possible.

![Authentik](handbuch/48b-authentik.webp)

#### Reverse proxy {#reverse-proxy}

Applies to any reverse proxy (Nginx Proxy Manager, Pangolin with Newt, Cloudflare Tunnel …). Only a display, nothing
to set: which addresses are in `TRUST_PROXY`, where the current request came from and
whether Kaveyl Wiki believes the visitor address it gives, whether **https** is detected (then the sign-in only applies to https), whether the
**live connection** (WebSocket `/api/events`) gets through the proxy, and whether a proxy warning has come up since the start.
Setup: [Access over the network](#zugriff-über-das-netz).

![Reverse proxy](handbuch/48c-reverse-proxy.webp)

### Notifications {#benachrichtigungen}

How Kaveyl Wiki reaches you: account e-mails (forgotten password, invitations) and – if you want – messages
to the admins, by e-mail, [Pushover](https://pushover.net) or both. On top of that, the notice about new versions
([Updates](#updates)).

#### E-mail {#e-mail}

SMTP sending for “Forgot password?”, invitations, “Give access by e-mail”, “Send by e-mail”, the notice after
password changes and – if selected under [Events](#ereignisse) – messages to the admins:

| Field | Meaning |
|---|---|
| SMTP server, Port, Encryption | the mail provider’s server; STARTTLS (usually port 587), TLS from the start (usually 465) or none (only on your own network) |
| User (SMTP login), Password / SMTP key | your access at the mail provider; the key is stored encrypted and never shown again |
| Sender address, Sender name | how the e-mails arrive (the address must be allowed as a sender by the mail provider) |
| Public address of Kaveyl Wiki | all links in e-mails (and the target of the webhooks) point there; “Use this address” sets the current one |
| Send test e-mail, Recipient of the test e-mail | checks everything – to you or to an address you enter |

![E-mail sending](handbuch/83-email-einstellungen.webp)

#### Pushover {#pushover}

[Pushover](https://pushover.net) delivers messages as push notifications to your phone, tablet or browser.
Setting it up takes three steps:

1. Create an account at pushover.net, install the Pushover app and sign in there.
2. pushover.net shows the **user key** at the top right after you sign in (“Your User Key”). A
   **group key** (Delivery Group) reaches several people.
3. Under “Your Applications” → “Create an Application/API Token”, create an application “Kaveyl Wiki” – it
   gives you the **API token**.

Enter both, **Save**, then **Send test message**. Token and key are 30 characters each,
are stored encrypted and never shown again (leave empty = keep). **Device** (optional)
sends only to particular devices of the account, several separated by commas. **Remove access** deletes both.
Security messages come with high priority (even during the phone’s quiet hours), “back in sync” silently.
You choose which events are sent under [Events](#ereignisse).

![Pushover](handbuch/105-einstellungen-pushover.webp)

#### Events {#ereignisse}

A table: for each event one checkbox for **E-mail** and one for **Pushover**; every checkbox applies at once.
Out of the box, **Nightly run, Backup and Security** are switched on – they go through the channels that are already set up
(so without a mail server and without Pushover access they go nowhere, without a warning). As soon as you change anything here,
exactly your selection applies.

| Event | When Kaveyl Wiki reports |
|---|---|
| Sync problems | a source cannot sync (at most every 6 hours per source), a conflict is waiting to be resolved – and “back in sync” as soon as it works again after a reported error |
| Nightly run | the check, clean-up or backup at 3 a.m. has failed, the check has found **something new** (e.g. a link to nowhere – with source and note, at most ten listed; what has already been reported and stays does not come back every night, what was fixed and comes back counts as new) or storage space for `/data` or `/config` is running low (below 1 GB or 5 %) – **one** message per night, only if there is something |
| Backup | a scheduled or manually started [backup](#zeitpläne) has failed completely or partly – with source and reason. If the same schedule keeps failing, at most **one message a day** arrives; if it works again afterwards, once “working again” |
| Security | 10 failed sign-ins in 15 minutes (at most hourly), a new administrator, a new API token |

E-mails go to **all admins with an e-mail address**, Pushover to the Pushover account entered. If a
channel is not set up yet, “not ready yet” appears below it with a link there. If a
delivery fails, this appears as a warning in the [Log](#protokoll). If a channel is ticked but not set up at all
(e.g. after “Remove access”), this appears there **once a day** – not with every message. Account e-mails do not depend on this
selection – they always go to the person concerned.

**No flood of messages:** The same message only comes again after its pause (table above); Kaveyl Wiki remembers this
even across a restart. In addition, **at most 10 notifications per hour** go out; the eleventh is
“Further notifications held back”, after that there is silence until the end of the hour. What was held back is shown
in the [Log](#protokoll).

![Notifications](handbuch/104-einstellungen-benachrichtigungen.webp)

**Follow:** Below that you set how many messages about [followed things](#beobachten) each person gets **at most per
day** (1 to 1000, 100 by default) – this protects your mail account, free plans often allow only a few hundred mails a
day. How often within that limit, each person chooses. Whatever comes in beyond the limit is not lost but is in the
next allowed message.

#### Updates {#updates}

When a new version of Kaveyl Wiki has been released, the admins see this **at the top right** next to Help and Settings:
“New version 0.1.4”, for a security update in red as “Security update 0.1.4” (on the phone in the account menu). A
click opens the release notes on GitHub in a new tab. The **×** hides the notice for exactly this version –
no matter whether it is a security or feature update; with the next version it comes back. Under
[Settings → Help](#hilfe) the new version is still shown, with a link to the release. Users and guests see none
of this – only whoever looks after the installation can update anyway.

![Notice about a new version at the top right](handbuch/121-update-hinweis.webp)

**Notify about updates** switches the whole thing on or off; out of the box it is on. For this, the server – not the
browser – queries the public release list of Kaveyl Wiki on GitHub once a day. Nothing is transmitted apart from this
request. When switched off, Kaveyl Wiki does not ask at all any more and shows no notice. Below it you see the version of this
installation, the latest published one and when it was last checked; **Check now** asks straight away. If GitHub
cannot be reached (for instance because the server is deliberately not allowed onto the internet), this is shown there and once in the
[Log](#protokoll) – otherwise nothing happens. There are no e-mails or Pushover messages about new versions.

![Notifications → Updates](handbuch/120-einstellungen-updates.webp)

### AI & APIs {#ki--apis}

Everything that lets programs get at the notes: the AI assistant and personal tokens for scripts and AI tools.

#### AI {#ki}

The tab has two sections: **For everyone: providers and retention** (only visible to admins, applies to all
users) and **My AI assistant** (everyone’s own).

- **AI providers** (admins): list of providers with name, type, model and “☁ Cloud provider”; the
  **Default** radio button determines which provider applies when someone does not choose their own. “+ Ollama”, “+ Ollama Cloud”, “+ Anthropic”, “+ OpenRouter”,
  “+ OpenAI-compatible” open the form: **Name**, **Address**, **API key** (encrypted, never
  shown again), **Model** – “Test connection” lists the models. Details:
  [Setting up AI](#ki-einrichten).
- **Keep unused chats** (admins): default **90 days** since the last message, 0 = never.
  Different per source: [Edit source](#eine-quelle-bearbeiten) → “Keep AI chats”.
- **My AI assistant** (everyone): **My provider** (otherwise the default), **Personal instructions**
  (sent with every request, e.g. “answer briefly, in English”) and **Delete my chat histories**.
- What the AI may see is not set here but by right-click → **AI access …** –
  see [AI access](#ki-freigaben).

![AI providers](handbuch/60-ki-anbieter.webp)

#### API tokens {#api-tokens}

Personal tokens `kw_…` for scripts, AI tools (MCP) and apps: **Token name**, permissions
**read / write / MCP / manage** (manage only for admins), **Validity** 30 days up to
unlimited, **Create token**. The token is then shown **once** (with MCP also the ready-made
command and a JSON configuration). The list shows “last used” (e.g. “5 min ago”, updated every minute).
**Renew** gives the token a new value with the same name, the same permissions and the same validity – the old value
stops working at once, the new one is shown once. **Delete** removes it (after a confirmation – programs using the token
lose access immediately). If an administrator made the token for you (tab [All tokens](#alle-tokens)), “made by” and their name
are shown – they know the value. If you renew it, only you know the new one.
A token only applies to the API, MCP and fetching files – settings cannot be changed
with it. If an administrator disables the account or sets a new initial password, all tokens are gone.
Expired tokens stay visible for 30 days and then disappear. Guests have no tokens. More:
[API and MCP](#api-und-mcp-claude-hermes-skripte).

![API tokens](handbuch/44-api-tokens.webp)

#### All tokens {#alle-tokens}

All [API tokens](#api-tokens) of all people in one list (admins only): person, name, permissions, when it was created,
when it expires and when it was last used. **Person** filters to one account. Per token:

- **Renew** – the token gets a new value with the same name, the same permissions and the same validity (counted from
  now). The old value stops working at once; you see the new one once, with MCP also the ready-made command. The program
  using it then needs the new value.
- **Delete** – after a confirmation the token is gone; programs using it lose access at once.

**New token for …:** under **For** choose the person, then name, permissions and validity as under
[API tokens](#api-tokens). This way, for example, the account of an AI agent gets its token without you signing in as
the agent. The token acts as this person and can do at most what they may: “manage” only for administrators, guests
and locked accounts get no tokens. Because you know the value, the person's list shows “made by” and your name; if they
renew the token themselves, only they know the new value and the note goes. The log records who created, renewed or
deleted which token for whom. If you lock or delete an administrator or take the role away, the tokens they made or
renewed for others are gone at once – they know their values. Expired tokens are marked “expired”; “Renew” makes them
valid again with a new value.

![Tokens of all people](handbuch/44b-tokens-alle.webp)

#### Event webhooks {#ereignis-webhooks}

Admins only. An event webhook sends changes **right away** to another system – typically an agent waiting for answers
in a note – instead of the agent asking all the time. **New event webhook**: **Name**, **Receiver address** (http or
https; redirects are not followed), **With the rights of** (usually the agent’s account – only what this person may read
goes out), optionally a **Source** and a **folder or note**. This person’s own changes are left out (otherwise an agent
would hear its own), unless you tick the box for it.

After creating it, the **secret** is shown once; the receiver uses it to check the `X-Kaveyl-Signature` header
(HMAC-SHA256 of the body). **Test** sends a “ping” at once; **Switch off/on**, **New secret** (the old one stops
working) and **Delete** are on every entry. Kaveyl Wiki bundles changes that come within a second, retries a failed
delivery three more times (after 10 seconds, 1 and 5 minutes) and switches a webhook off when five deliveries in a row
do not arrive even so (entry in the log; a failed “Test” switches nothing off). A chosen folder or note moves along when
it is moved or renamed, as with [following](#beobachten); when the chosen source is removed, Kaveyl Wiki switches the
webhook off (entry in the log). Format of
a delivery: API reference, “Events for agents”. What goes where and when – push webhook, event webhook, e-mails – is shown in the picture under
[How syncing works](#so-funktioniert-der-abgleich).

### Appearance {#darstellung}

**Light / Dark / System** (follows the device), **Editor width** (Normal, Wide, Full width or a percentage of your own) and
**Table of contents** on/off. Light/Dark applies to this device – it is quicker via the colour scheme icon at the top
right. Width and table of contents belong to your account (the same on all devices).

![Appearance](handbuch/19-einstellungen-darstellung.webp)

![Dark](handbuch/20-dunkel.webp)

#### Language {#sprache}

Here you set the language of the interface: Deutsch or English. Because the page briefly reloads for this,
Kaveyl Wiki asks first; afterwards you are back on this page of the settings, and your open notes are still there.
You can do the same via the command palette (Ctrl K, “English” or “Deutsch”) and, before signing in, with **DE | EN** at the top
right.

The language belongs to your account and so applies on all devices. It applies to the whole interface, to messages
from the server and to e-mails to you (notifications, shared notes); invitations to new people go out in the
language of the person inviting. This manual, too, is available in German and English. Log entries that were already stored appear translated, as far as Kaveyl Wiki knows them. Notes
themselves are never translated.

#### Font size {#schriftgröße}

Four sliders from 80 to 150 %: **Interface** (menus, buttons, dialogs, tabs – everything around the
note, including the sidebar), **Sidebar** (tree, favourites, recent, AI access – on top of the
interface size), **Note text** (notes, reading view, help) and **Code** (code blocks, `code` in text, the
“Markdown” view). Every change applies **at once** throughout Kaveyl Wiki, also behind the window; below each slider
there is an example. **Reset all to 100 %** restores the default. It is saved for
your account (the same on all devices).

![Font size](handbuch/109-einstellungen-schriftgroesse.webp)

### Account {#konto}

Shows your **sign-in address**. **Change password**: current password, new password twice (following
the [password rules](#anmelden-und-oberfläche)) – ends all other sessions; if e-mail sending is set up,
a notification e-mail arrives. **Lock automatically after**: when unlocked
[encrypted notes](#verschlüsselte-notizen-und-ordner) are locked again (5 / 15 / 30 / 60
minutes or only when the page is closed). **Delete account**: an administrator does this – please request it there;
what is removed and what stays is described under [Users](#benutzer).

![Account](handbuch/98-einstellungen-konto.webp)

**Sign-in through a proxy** (only visible if an administrator has switched on [Authentik](#authentik)):
Open Kaveyl Wiki via the address protected by the proxy, sign in with your password as usual and
click **“Connect to Authentik”**. Kaveyl Wiki then remembers the fixed identifier that
the proxy sends for you; after that, it signs you in without a password. This also works for administrators – in
single-person use, one account is therefore enough. Connecting does not work via a different address (e.g. `http://<LAN-IP>:<Port>`).
**Disconnect** also ends the sessions created through the proxy; administrators can
disconnect under Users → pencil.

![Account connected to Authentik](handbuch/98b-konto-proxy.webp)

#### Follow and Pushover {#beobachten-und-pushover}

The list shows everything you [follow](#beobachten) – with symbols for dot, e-mail and Pushover and the number of new
changes – each with **Stop following**. Below is **Pushover for you**: once an admin has set up Pushover, you enter your
own **Pushover user key** here (shown on pushover.net at the top right after signing in) and send a **test message**
(at most three per hour – each one counts towards the instance's Pushover quota). The key is stored encrypted and never
shown again; saving it empty removes it.

Under **How often?** you choose when e-mail and Pushover come – for everything you follow: **Bundled** (2 minutes after
the first change), **At most once an hour** or **Once a day** (a summary; you set the **Time of the summary** below it,
7:00 by default, server time zone). The dot in the sidebar always comes
right away. Below it you see how many messages a day the admin allows at most; whatever comes in beyond that is in the
next one.

### Help {#hilfe}

At the very top is the **Version**, for example “Kaveyl Wiki 0.1.3 (685591d)”: the number of the release and, in
brackets, the state of the source code it was built from. If it says “dev”, a development build is running, not a
published release. If it says **“Beta”** (e.g. “0.2.0 Beta”), it is a published release of the beta phase: the
feature set is complete, but bugs are still possible – backups (see [Backup](#backup)) matter all the more. The first
version without “Beta” will be 1.0.0. What a version changes is in the release notes on GitHub and in the `CHANGES.md` that comes with the package.
Below that, admins see when a newer version has been released – with a link to its release notes on GitHub (see
[Updates](#updates)). Below that, everyone finds the links to the **licence** (GNU AGPL-3.0), the **source code** and the
**licences of the components used** (see [Technology and components](#technik-und-komponenten)).

After that come **What is Kaveyl Wiki?**, **Where do I find help?** and buttons to good starting points (manual, interface,
editing, Markdown cheat sheet, menus, keyboard shortcuts, AI, sources, troubleshooting, technology and components). See
[Help in Kaveyl Wiki](#hilfe-in-kaveyl-wiki).

If you have hidden the welcome page, **“Show welcome page again”** brings it back – it appears as soon as
no note is open.
## Access over the network {#zugriff-über-das-netz}

In your own network, Kaveyl Wiki can be reached directly via the address of the computer and the port from the
`docker-compose.yml`, e.g. `http://<LAN-IP>:<Port>`. For a domain of your own with https – in your own network or from
outside – a **reverse proxy** goes in front of it and passes the requests on to exactly this address. This section is
aimed at administrators; how to set up the container itself is described in `INSTALLATION.md`.

### First in your own network, then via a domain {#erst-im-eigenen-netz-dann-über-eine-domain}

1. Set up Kaveyl Wiki first via `http://<LAN-IP>:<Port>` (setup code, first account, sources).
2. Then create an entry for the domain in the reverse proxy (e.g. `wiki.example.org`), target
   `http://<LAN-IP>:<Port>` – there is an example under [Nginx Proxy Manager](#nginx-proxy-manager). Nothing needs to be
   changed in the `docker-compose.yml` for this: without a setting, Kaveyl Wiki accepts the information from proxies in
   your own network (see [Trusted proxies](#vertrauenswürdige-proxys-trust_proxy)).
3. Signing in applies per address: via the domain you sign in once more, even if you are already signed in via
   `http://<LAN-IP>:<Port>`. Both ways work side by side.
4. Over https, the sign-in automatically applies only to https (the sign-in cookie carries `Secure`), and the browser
   remembers to open the domain only via https from then on. Direct access via `http://<LAN-IP>:<Port>` keeps working.
   Kaveyl Wiki learns from the proxy that a request came over https – this only counts for a proxy that Kaveyl Wiki trusts.
5. Under Settings → Notifications → [E-mail](#e-mail), set the “Public address of Kaveyl Wiki” to the domain so that
   links in e-mails and webhooks lead there.

### Trusted proxies (TRUST_PROXY) {#vertrauenswürdige-proxys-trust_proxy}

A reverse proxy sends along the address of the actual visitor (`X-Forwarded-For`) and whether the request came over
https. Kaveyl Wiki only accepts this information from proxies it trusts – set with the environment variable
`TRUST_PROXY` in the `docker-compose.yml`. The addresses in the [log](#protokoll), the sign-in brake
“Too many failed attempts” (the limit per device) and the detection of https depend on it.

- **Without a setting (default):** Kaveyl Wiki trusts every device in your own network (private addresses and the
  computer itself). This way every proxy in your own network works without any further setting.
- **Recommended:** enter the address of the proxy, several separated by commas – for example a Nginx Proxy Manager in
  your own network and a Newt for access from outside: `TRUST_PROXY=<Adresse des NPM>,<Adresse des Newt>`. Then restart
  the container (`docker compose up -d`).
- **One below the other:** in the `docker-compose.yml` the list can also be written line by line, each address with
  a comment; `#` up to the end of the line does not count, so you can also prepare an address and uncomment it later.
  Spaces and commas also separate entries. A value in `environment:` takes precedence over a `TRUST_PROXY` from a
  `.env` file.

  ```yaml
      environment:
        TRUST_PROXY: |
          <Adresse des NPM>      # Nginx Proxy Manager
          # <Adresse des Newt>   # Pangolin/Newt – uncomment later
  ```

  Allowed are single addresses (IPv4/IPv6), ranges such as `192.168.1.0/24` as well as `loopback`, `linklocal` and
  `uniquelocal`; `true` and `false` only on their own. If anything else is there, Kaveyl Wiki does not start and names
  the entry in the container log (`docker logs kaveyl-wiki`).
- `TRUST_PROXY=false` ignores the information from all proxies; `TRUST_PROXY=true` trusts every one – only sensible if
  Kaveyl Wiki can be reached exclusively via the proxy.

**Finding the right address:** if a request comes via a proxy while `TRUST_PROXY` is not set, Kaveyl Wiki writes a
warning once to the container log (`docker logs kaveyl-wiki`) and to the app's [log](#protokoll); the address is
shown there under Details. It comes from the first such request and is probably the proxy – compare it with the
address of the proxy before entering it. If the proxy runs as a container on the same computer, Kaveyl Wiki often does
not see its address in your own network but one from the Docker network. If direct requests also arrive via this
address, you trust them too with the entry.

**Without an entry**, any device in your own network can pretend to be a proxy and send along any visitor address it
likes: the addresses in the log are then not correct, and the sign-in brake per device can be bypassed (the limit per
e-mail address still applies). A wrong entry shows itself in that the log only contains the address of the proxy and
signing in via the domain does not count as https.

### Nginx Proxy Manager {#nginx-proxy-manager}

A Proxy Host in the Nginx Proxy Manager (NPM), example:

- **Details:** under “Domain Names” the domain, “Scheme” `http`, “Forward Hostname / IP” `<LAN-IP>`, “Forward Port”
  `<Port>`. **Switch on “Websockets Support”** – the live updates come through it (`/api/events`): changes by others,
  the state of the sync and messages appear immediately. Without websockets they are missing. NPM passes on the host
  name of the domain by itself; a proxy that replaces it must send it along as `X-Forwarded-Host` (and be listed in
  `TRUST_PROXY`) – otherwise Kaveyl Wiki rejects the live connection because it appears to come from a foreign site.
- **SSL:** request a certificate (e.g. Let's Encrypt) or choose an existing one and switch on “Force SSL”.
- **Large files:** if Kaveyl Wiki reports “Too large for the server” (HTTP 413) when uploading, a proxy has usually
  rejected the request. The Nginx Proxy Manager allows up to 2000 MB by default; if this has been lowered, raise the
  limit under “Advanced” → “Custom Nginx Configuration”, e.g. `client_max_body_size 100m;` – at least as large as
  “Largest allowed file” under Settings → [Attachments](#anhänge). If the traffic goes via Cloudflare, its limit
  applies as well (100 MB on the Free and Pro plans).

### From outside: Pangolin with Newt {#von-außen-pangolin-mit-newt}

Pangolin is a reverse proxy on a server that can be reached from the internet – self-hosted or as Pangolin Cloud; no
port has to be open at home for it. For Kaveyl Wiki, Pangolin is a reverse proxy like any other, with its own sign-in
in front.

- **Newt** runs in your own network (e.g. as a container) and keeps a tunnel to Pangolin. In Pangolin it is registered
  as a **Site**.
- In Pangolin, create a **Resource** (HTTP) for the domain, target via this site `<LAN-IP>:<Port>` (http). Pangolin
  takes care of the certificate and https. Here too, `/api/events` must get through as a WebSocket.
- **Signing in to Pangolin:** Pangolin protects the resource with its own sign-in (Pangolin account, optionally via an
  identity provider such as Authentik, or PIN, password, e-mail code). Then only those who have signed in there get
  through to Kaveyl Wiki.
- **After that you sign in to Kaveyl Wiki** – with e-mail and password, with “Stay signed in” only every 30 days.
  If you want to sign in only once, put [Authentik](#authentik) (Forward Auth) or
  [Cloudflare Access](#cloudflare-access) in front.
- For Kaveyl Wiki, Newt is the proxy: its address, as Kaveyl Wiki sees it, belongs in `TRUST_PROXY` (see
  [Trusted proxies](#vertrauenswürdige-proxys-trust_proxy)). The [Reverse proxy](#reverse-proxy) tab
  shows whether that is correct.
- Webhooks from the Git servers as well as the REST API and MCP cannot sign in to Pangolin. For them, create rules in
  the resource with the action **Bypass Auth** and the match **Path**: `/api/v1/*` (the asterisk is part of it –
  `/api/v1` alone only matches exactly this path), `/mcp` and `/api/webhooks/git`. Or call them directly in your own
  network via `http://<LAN-IP>:<Port>`. Kaveyl Wiki protects these paths itself (token or
  signature).

## Data, log and backups {#daten-protokoll-und-sicherungen}

**What is stored where?**

Kaveyl Wiki runs as a Docker container; everything that is meant to stay is in mounted folders. Where they point to
on the server is set in the `docker-compose.yml` (example: `./kaveyl-wiki/…` next to the `docker-compose.yml`).

| What | In the container |
|---|---|
| Notes | in your repositories or folders – as `.md` files |
| Local working copies of the repositories | `/data/repos` |
| Local folders (with versions: their own `.git` in the folder) | `/docs` |
| Kaveyl Wiki database (users, sources, encrypted tokens, settings, log, AI chats, search index) | `/config/kaveyl-wiki.db` |
| Key for encrypting the tokens | `/config/secret.key` |
| Database backups | `/config/backups` |
| Local [backup targets](#ziele) | `/backup` (a separate mounted folder, ideally on another disk) |
| Git backups of deleted repositories and cleaned-up copies | `/config/backups/repos` |
| Trash of folders without auto-commit | `.kaveyl-wiki/trash/` in the respective source |
| Technical container log | with Docker (at most 5 × 10 MB, rotated) |

**Log** (Settings → Tools → Log, per source also “History” in the sync overview):

- *Sync:* pushed/pulled, conflict and resolution, renames from outside, link repairs.
- *Error:* sync errors (repeated identical errors only once), index, check and backup errors.
- *Security* (only visible to administrators): sign-in (including failed ones, with
  IP address), sign-out, password change, sources, connections (created, changed, deleted), deleting and
  restoring, rejected webhooks.
- *System:* start, nightly check, backups, clean-up.
- **Never in the log:** passwords, tokens, cookies, note contents. Changes to content
  are in the Git history (versions).
- **Folder permissions apply here too:** anyone who may not read every note named sees entries without the
  file lists; entries whose text itself names file names (conflict, conflict resolved, commit,
  restore) are then missing entirely. Likewise, the conflict notice of a source only names files you are allowed to read.
  Users without administrator rights only see errors (sync, index, file watching, backup …) as a general
  text such as “Sync failed” – the messages from Git and the file system can name paths. This also applies to
  the sync status of a source. Server maintenance (clean-up, database backups, old copies) only appears in the log
  for administrators. Administrators see everything.
- **Per person** (admins): the “Person” filter in the log, or in Settings → Users & permissions → Users the
  clock icon next to an account – shows what this person has done (sign-ins, changes to
  sources and permissions, AI requests, their commits).

![Log](handbuch/26-protokoll.webp)

**Retention** (can be changed): normal entries 30 days, warnings and errors 90 days,
security 365 days. Clean-up runs every night at 3 am.

**Backups:** every night a backup of the database (the last 7 are kept), on Sundays additionally
a weekly one (the last 4); “Back up now” at the push of a button. Other `.db` files in the folder
(e.g. a backup made by hand before an update) count as **by hand** and are kept for 90 days.
All three numbers can be set (Settings → Backup → Database). These backups are on
the same disk. For copies of your sources and the database to a NAS or another disk
there is the [Backup](#backup) area.

### What is in the database? {#was-steht-in-der-datenbank}

The file `/config/kaveyl-wiki.db` (SQLite) holds everything that is **not** in your notes:

| In the database | Note |
|---|---|
| Users, groups, permissions, guests | passwords only as a hash (scrypt) |
| Sign-ins, links from e-mails, API tokens | tokens only as a hash – nobody can read them out again |
| Added sources, connections, all settings | credentials (tokens, SMTP keys, Pushover keys, AI API keys) **encrypted** with `secret.key` |
| Log | without passwords, tokens and note contents; retention according to the [deletion rules](#löschregeln) |
| AI chats, AI access, AI proposals, memory per source | chats according to the deletion rules |
| Repository trash, custom icons, personal preferences (open tabs, editor width) | |
| Search index and links between notes | is rebuilt from the notes if it is missing |

**Not in the database:** the notes and attachments themselves – they are in your repositories or
folders and are versioned with Git. Kaveyl Wiki fetches the local copies under `/data/repos` again when needed.
So for a complete restore you need: a database backup **and** `secret.key`
(without it the stored credentials are unusable and have to be entered again) – and your
repositories or folders.

### Deletion rules {#löschregeln}

So that nothing in the container grows without limit, everything that Kaveyl Wiki stores itself has a deletion rule
with a default value. All of them are under **Settings → Tools → Clean-up** (with the current state and
**Clean up now**), most of them also where they belong. They are applied **every night
at 3 am** (before the database backup) or immediately with “Clean up now”. **None of these rules deletes your notes or
the Git history.**

| What grows | Rule (default) | 0 = never? | Can also be set under |
|---|---|---|---|
| Log: normal entries | 30 days | – | Tools → Log |
| Log: warnings and errors | 90 days | – | Tools → Log |
| Log: security | 365 days | – | Tools → Log |
| Trash of notes (`.kaveyl-wiki/trash`; Git sources: only hide) | 30 days | yes | – |
| AI chats (from the last message) | 90 days, **can differ per source** | yes | AI; edit source → “Keep AI chats” |
| Repositories in the repository trash | 30 days, then deleted for good | yes | Sources → Added sources |
| Git backups (bundles) | 30 days | yes | Sources → Added sources |
| Daily database backups | the last 7 | – | Backup → Database |
| Weekly database backups | the last 4 | – (0 = none) | Backup → Database |
| Other backups (`.db` placed there by hand) | 90 days | yes | Backup → Database |
| History of backup runs (Backup → Backups) | 180 days | yes | – |
| Orphaned local copies in `/data/repos` | 30 days | yes | Sources → Added sources |

**Orphaned local copies** are working copies of repositories that no source uses any more: from
removed sources and `.alt-…` copies that Kaveyl Wiki puts aside when the same repository is added
again. Counting starts on the day Kaveyl Wiki first finds them orphaned. Before
deleting, anything uncommitted in them is committed and everything is stored as a Git backup
(`/config/backups/repos/clone__…bundle`, after which its rule applies). A copy that is needed again
loses its mark.

**Fixed rules** (cannot be set): the **database file** is shrunk at night as soon as at least a
quarter (and 1 MB) is free – otherwise deleted entries do not make it smaller. Expired
**sign-ins** disappear immediately (they are valid for 30 days or one day), **links from e-mails** one week
after expiry or use, **expired API tokens** after 30 days, **temporary folders** after a
crash after one day. Docker itself limits the **technical container log** (`logging` in the
`docker-compose.yml`: 5 × 10 MB).

The backups at the [backup targets](#ziele) are not covered by these rules: how many are kept is set by
their [schedule](#zeitpläne).

Every clean-up that removes something is recorded in the log (System: “… deleted”, “Database compacted”), every changed rule
under Security.

## AI assistant {#ki-assistent}

The assistant helps with writing, answers questions from the wiki and, on request, carries out
tasks (“create an overview”, “add the new appointment”). The principle: it sees **nothing**
until an admin grants access to something, and it **never changes** anything **itself** – every result is a
proposal that you apply or discard.

### Setting up AI {#ki-einrichten}

**Setting up (admins):** Settings → **AI** → the provider's button (“+ Ollama”, “+ Ollama Cloud” …): **Ollama** (local, the data
stays in-house), **Ollama Cloud** (`https://ollama.com`, API key under ollama.com → Settings →
Keys; always counts as a cloud provider), **Anthropic** (API key), **OpenRouter** (API key) or
**OpenAI-compatible** (Azure AI Foundry, LM Studio, vLLM …). Enter the address, key and model;
“Test connection” saves the provider and lists the models (while the test is running, a loading spinner turns
in the button): the arrow in the **Model** field shows all of them to choose from, typing filters, any
other name remains possible. Several providers at the same time are possible (e.g. a
local Ollama and Ollama Cloud).

You do not set **local or cloud** – Kaveyl Wiki detects it and shows the notice
“☁ Cloud provider” for cloud providers: Ollama Cloud, Anthropic and OpenRouter are always cloud; Ollama and
OpenAI-compatible services are local if the address is in your own network (`localhost`,
`192.168.…`, `10.…`, a Docker name such as `ollama`), otherwise cloud (e.g. `…openai.azure.com`). A
cloud model in the local Ollama (name ends in `-cloud`, e.g. `gpt-oss:120b-cloud`) also
counts as cloud, because Ollama forwards it to ollama.com. One provider is the **Default**; every
user can choose a different one under Settings → AI and store **personal instructions**
(sent along with every request). There you can also delete your own chat histories;
the admin decides how long histories are kept ([Chats and retention](#chats-und-aufbewahrung)).
Keys are stored encrypted and never shown again.

![AI providers](handbuch/60-ki-anbieter.webp)

### AI access {#ki-freigaben}

**Granting access (admins):** without access the AI sees **nothing** – that is the default. Right-click
a source, a folder or a note → **AI access …**:

| Choice | Meaning |
|---|---|
| **Same as above** (for a source: **No rule**) | No rule of its own; below it you see what currently applies and where from, e.g. “currently: not allowed (default)” or “currently: allowed (from the source)”. |
| **Allowed** | The AI may read the content (questions, summarising) and **propose** changes – only what you confirm is applied. The dialogue names which providers the content goes to for this. |
| **Not allowed (exception)** | Blocks here, even if something above is allowed – e.g. the whole source allowed, only the folder “Tagebuch” not. A block always wins. |

**Local or cloud – only if you have both:** if you only have cloud providers (e.g. only Ollama Cloud),
“Allowed” means: goes to Ollama Cloud. If you only have an AI in your own network, everything stays in-house.
Only when **both** kinds are set up is there additionally **“Allowed – only for AI in your own
network”**: the local AI sees the content, the cloud AI never does (e.g. for a diary). Whatever you allow
while there is no cloud provider applies to your own network only – if a cloud provider is added
later, nothing goes to the cloud by itself because of it. In addition: `ai: false` in the front matter blocks
a note, encrypted notes are always off-limits, and the AI never gets more than the asking
user is allowed to read.

![AI access](handbuch/61-ki-freigabe.webp)

### Overview of all access rules {#überblick-über-alle-freigaben}

**Overview of all access rules (admins):** as soon as there is an access rule, the section **✦ AI access**
appears in the sidebar under “Recent” (expandable/collapsible like the favourites). Each row is a
rule: source, folder or note (with the source in brackets), on the right **allowed** or **not allowed**
(red); with local and cloud AI also **own network only**. An orange **no effect** means: allowed only for your own
network, but there is no AI in your own network – the cloud AI does not see it (Edit access →
“Allowed”). At the top you filter by **all**, **active** (allowed), **blocked** and – if there are such rules –
**local** (a collapsed section expands when you do so). A click shows the place in the tree (a note is opened);
right-click (on a phone: long press): **Edit access …**, **Show in tree**, **Remove
access**. Rules shown in grey with “orphaned” are rules whose note no longer exists – they apply nowhere and
can go. In the tree itself, every source, folder and note with its own rule carries a small
**✦** (red for a block, orange if the access currently has no effect); hovering over it with the mouse shows what applies. A **click on the ✦** opens a
small menu: **Ask AI …** (with exactly this source, this folder or this note as the context) and
**Edit AI access …**; for a block only the latter. The ✦ is always at the right edge of the
row and does not shift when further buttons appear on hover.

![AI access in the sidebar](handbuch/69-ki-freigaben.webp)

### AI in the editor {#ki-im-editor}

Select text → **AI** in the selection menu: Rephrase, Shorten, Expand,
Fix spelling and grammar, Translate, Custom instruction and **Ask AI …**. Without a selection
(AI button in the toolbar): **Summarise**, **Continue writing** and **Ask AI …** (see
below, with this note as the context). The note menu “…” only shows the AI items where there is no
toolbar – for notes you may only read, and in the Markdown view.

The proposal appears in a window: for selected text **Replace** or **Insert
below**, for Summarise **Insert at the beginning** or **Insert at the end**, for Continue writing
**Insert at the end** – plus always **Copy** and **Discard**.

- **Summarise** delivers a few short bullet points in the language of the note. Code and tables
  are not copied out but described in one sentence; open, planned and undecided
  items remain marked as such.
- **Continue writing** starts at the end of the note. If it breaks off in the middle of a sentence (or after a
  number such as “3.”), the sentence is continued in the same paragraph, without repetition. What does not follow
  from the text – dates, names, prices, a further piece of news – the AI does not invent, but
  inserts **placeholders in square brackets** such as [Datum]; the window then points this out. Please
  fill them in and check the facts: Continue writing is a help with wording, not a source of knowledge.

![AI proposal](handbuch/62-ki-vorschlag.webp)

### Ask the knowledge base {#frag-die-wissensbasis}

Open it via ✦ at the top of the sidebar, (for admins) ✦ at a place in the tree with access, “Ask AI …” in the editor's AI menu
(or in the note menu “…” where there is no toolbar) or in the command palette. Choose the context – this note, this folder, this source, everything with access or
general (without wiki). Here the AI works as an **agent**: it searches by itself, looks at folders
and reads notes until it can answer – you see the steps live (“Searches …”, “Reads …”),
after which the answer appears word by word. Above the answer, the “n steps” can be expanded;
below it are **only the sources the answer is based on** ([1], [2] …), together with the provider and
model.

Answers appear **formatted like a note** – headings, lists, tables, code with
highlighting, formulas. The answer only shows images from Kaveyl Wiki itself; an image from another
website appears as a link and only loads when you click it. Below every answer:

- **Copy** – pasted into a Kaveyl Wiki note (Ctrl+V), the answer arrives formatted exactly the same
  (including callout boxes, formulas, tables); formatted in Word or an e-mail, as Markdown in a text
  editor.
- **Markdown** / **Formatted** – switches the view, for example to select only part of it as Markdown
  and copy it.
- **Save as note …** – choose a title (prefilled with the question) and folder; the answer becomes a
  new note, its sources are listed as links at the end. It is saved in your name, not as the AI;
  in encrypted folders this does not work (copy and paste there instead).

### Chats and retention {#chats-und-aufbewahrung}

Earlier chats are listed on the left: **New chat** starts a
new one, the trash can on an entry deletes it after a confirmation (always visible on touch devices). **Clear
history …**, fixed below the list, deletes – as in the browser – the chats of the **last hour**, the **last
24 hours**, **7** or **30 days** or **all** – after a confirmation. Deleted is deleted: questions,
answers and proposals disappear from the database, the file is overwritten in those places;
the log only records *which notes* went to which provider, not the questions. (Only
older database backups still contain them until these expire.) **Ctrl+Enter** sends the question. In
a running chat the context stays fixed and is shown as text; **“Other context: new chat”** next to it starts a
new chat in which you choose the context again (the previous one remains among the earlier chats). On narrow
screens (phone) the earlier chats are shown as a selection above the chat, next to it buttons for **New chat**, for
deleting the selected chat and for **Clear history …** (clock icon).

Chats that have not been used for longer than **90 days** (default, Settings → AI →
“Keep unused chats”, 0 = never) are **deleted automatically** – counted from the last message. For
chats about a particular source (context: a note, a folder or the source) each source can have its
**own period**: edit source → **“Keep AI chats”** (e.g. 7 days for a diary
or “never delete” for a project); “As in Settings → AI” uses the general rule. Chats with
the context “everything with access” or “general” always follow the general rule.

### Context, sources and accuracy {#bezug-quellen-und-genauigkeit}

**Context “General (without wiki)”:** a free question to the language model, as in a normal
AI chat. **No note** goes to the provider, so no access rule is needed for it; the
answer comes from the model's knowledge, has no sources and may be outdated or wrong. The AI
says when it is unsure, does not invent sources and, for questions about your notes, refers you to
a different context. Your personal instructions (Settings → AI) apply here too.

When answering questions, the AI sticks strictly to the notes: it only reproduces what is written there, quotes
ideas, wishes and conditions word for word instead of reinterpreting them, searches multi-part questions part by part
and says explicitly when something – or an assumption in the question – is not in the notes.
With language models this is no guarantee: check important things via the linked sources.

- **Click** on a source opens the note and closes the window.
- **Right-click** (touch: long press) → **Open in new tab** – the window stays open, so
  you can open several sources one after another; also “Open and close dialogue”, “Open to the
  right” (closes the window) and “Copy path”. The middle mouse button also opens in the
  background.
- **Open all n in tabs** (with several sources) opens each one in its own tab (the first one
  in front) and closes the window. Notes that are already open do not get a second tab.

![Ask the knowledge base](handbuch/63-ki-fragen.webp)

### Tasks and proposals {#aufträge-und-vorschläge}

If you ask the AI for a change, it creates **proposals** instead of
writing itself: a new note, changing the text of a note, moving a note/folder or remembering
something. Each proposal appears as a card below the answer – **Preview** shows the new text
or the changes (red/green), **Apply** carries it out, ✕ discards it. It is applied with
the author **“Kaveyl Wiki KI (im Auftrag von …)”** – on your behalf, with your name – and a commit message `ai(…): …`; the
change is a separate commit and can be brought back at any time via “Versions”. There are proposals
only where the AI has access and you yourself may write – for a folder this applies to everything
in it, as when moving in the tree; if the note has been changed in the meantime, Kaveyl Wiki overwrites nothing (then ask the AI again). The AI cannot
delete.

So that proposals work as normal notes, Kaveyl Wiki tidies them up: source numbers such as “[1]” from
the chat do not end up in the note, and links that the AI writes from the root of the source
(`Besprechungen/…`) are converted to match the note's folder (`../Besprechungen/…`). All
AI answers get normal hyphens and spaces instead of typographic special characters that
some models scatter in – otherwise a search for “Eis-Angebot” would not find them. A correction of a
single paragraph remains one paragraph.

![Proposal from the AI](handbuch/64-ki-agent-vorschlag.webp)

**Models without tools:** small local models often cannot call tools. In that case
Kaveyl Wiki searches for matching notes itself, as before, and the AI answers from them (without steps and without
proposals).

### Memory per source {#gedächtnis-pro-quelle}

Right-click the source → AI access … → **AI memory of this
source**. You write the *instructions* (e.g. “Keep technical terms in English”) yourself; the
*memory* contains things the AI should remember – it proposes new entries (“remember …”),
you confirm them. Both are stored as Markdown in `.kaveyl-wiki/ai/` of the source (`anweisungen.md`,
`gedaechtnis.md`, plus a `README.md`), are versioned with the source and can also be read by Claude
Code or Hermes. They are sent along with every AI request about this source – provided the source
**itself** (not just a folder in it) has access. Switching off: edit source →
“AI memory”.

### AI log {#protokoll-der-ki}

Every request is recorded in the log (who, which provider and which model, which
notes with path and version, for the agent also the steps), as is every applied proposal –
but not the content itself.

## API and MCP (Claude, Hermes, scripts) {#api-und-mcp-claude-hermes-skripte}

> Detailed reference (all endpoints, examples in Bash/Python, setup for Claude Code,
> Claude Desktop, Cursor, VS Code, LM Studio, Hermes, troubleshooting): **[docs/API.md](API.md)**.

Kaveyl Wiki can be read and changed from outside – with the same permissions as in the app (what you
are not allowed to see does not exist there; read access only means: no changes). Every change is
committed to Git with you as the author and noted in the log (“API: …” or “MCP: …”).

**Create a token:** Settings → AI & APIs → **API tokens**. Choose the permissions: **read**, **write**,
**MCP** (for AI tools). After it is created, the token is shown once – with “MCP”, the
ready-made command for Claude Code is shown as well, for copying.

**Claude Code / Claude Desktop (MCP):** a token with “MCP” (and “write” if Claude is to change
notes), then in the terminal:

```
claude mcp add --transport http kaveyl-wiki https://wiki.example.org/mcp --header "Authorization: Bearer kw_…"
```

Claude Desktop connects through the small bridge `mcp-remote` – its settings are in the
[API reference](API.md#mcp-clients-einrichten).

Claude can then list sources, search (also within just one source), look at the tree, read,
write, create, copy, move and delete notes, see who is editing a note right now, ask what has changed since last time
and by whom ([Agents in the team](#agenten-im-team)), create folders, upload images and files
(they end up in the `assets` folder next to the note, as when pasting in the editor), fetch backlinks and versions,
view the sync status and start a sync. Before writing, it reads the
note; if someone has changed it in the meantime, it gets a conflict instead of overwriting anything.
Deleted items go to the [Trash](#versionen-und-papierkorb) and can be brought back from there.
It sees encrypted notes only by their name and cannot change them. Changes
are – as in the app – bundled into one Git version after a short pause; only then do they appear
in the versions (“Sync now” does it immediately). Adding or removing sources and
changing settings is deliberately not possible via MCP – that stays in the app.
MCP is an open standard – not just Claude: Cursor, VS Code, LM Studio, Hermes and other
MCP clients connect in the same way (HTTP, address `…/mcp`, header `Authorization: Bearer kw_…`).
For this, the API tokens page also shows a JSON configuration for copying after the token is created;
setup per client in [docs/API.md](API.md#mcp-clients-einrichten).

![Token with MCP](handbuch/59-mcp-token.webp)

**REST API for scripts:** `https://<deine Adresse>/api/v1/…` with the same header. The complete
description (OpenAPI) is at `/api/v1/openapi.json`, e.g. for importing into Postman or
Bruno. Examples: `GET /api/v1/sources`, `GET /api/v1/search?q=wort`,
`GET /api/v1/notes/<Quelle>/<Pfad>` (returns Markdown and `hash`), `PUT` to the same address with
`{"markdown": "…", "baseHash": "<hash>"}`.

## Keyboard shortcuts {#tastenkürzel}

| Shortcut | Effect |
|---|---|
| F1 | Help – in a settings area or dialog, exactly on that |
| Ctrl+K | Command palette (notes and commands) |
| Ctrl+P | Instant search in the sidebar |
| Ctrl+S | Save and commit immediately |
| Ctrl+B / Ctrl+I / Ctrl+E | bold / italic / code |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| `/` at the start of a line or after a space | Slash commands |
| `[[` | Search for a note and link it |
| `:` + word | Insert emoji |
| Middle mouse button (under Favorites and Recent also Ctrl+click) | open in a new tab |
| Ctrl+click / Shift+click (in the tree) | [mark](#mehrere-markieren) one row / a range; Esc clears |
| Ctrl+C / Ctrl+X / Ctrl+V (in the tree) | copy / cut / paste note/folder |
| ↑ / ↓ (in the tree) | previous / next visible row; Home / End jump to the first / last |
| → / ← (in the tree) | expand a source or folder or go to the first row in it / collapse it or go to the parent folder |
| Enter (in the tree, under Favourites and Recent) | open – like a click |
| Shift+F10 or context menu key | context menu of the row in the tree, under Favourites or Recent |
| ← / → (on a tab) | open the previous / next tab; Home / End open the first / last |

With Tab you reach the tree of sources as a single stop – on the last used or
the open note –, after that the arrow keys move. The headers “Favourites”, “Recent” and
“AI access” and the entries below them can also be reached with Tab; Enter or Space
expands and collapses a header.

## Troubleshooting {#fehlerbehebung}

**The sync icon shows an error.** Open the sync overview – the message is shown there.
Common causes: server not reachable or token invalid (Settings → Sources → Connections → **Check**, then replace the token).
“Git server not responding … (time limit)”: the server accepted the connection but delivered nothing – Kaveyl Wiki aborts fetching
and pushing after 2 minutes (cloning after 5), so that saving and the sync of other sources do not wait indefinitely; the next sync
tries again. The log shows since when the error has existed.

**At the top right there is a red message instead of “Saved”.** The note could not be saved; the message names the
reason, and clicking it shows what to do. **No connection:** your changes stay in the tab, Kaveyl Wiki saves
by itself as soon as the server can be reached again – leave the tab open until then. **Signed out:** the session has
expired; sign in via **Sign in in a new tab**, after which Kaveyl Wiki saves in the original tab by itself.
**Note no longer there:** it was deleted or moved; the notice above the text offers
[“Save as a new note …”](#konflikte-auflösen). **Server error:** Kaveyl Wiki tries again by itself; if the
error persists, an administrator finds the cause in the server log. **Not saved** with a message (e.g. missing
write permission): the message names the reason.

**“This part of the app could not be loaded” or “… could not be shown”.** Usually the tab dates from before an
update, or the network was briefly gone. **Reload** loads the current version. If it affects a note with unsaved
changes, the message names it – first **Copy content** and paste the text somewhere else; the other tabs stay
open and save as usual.

**A note does not appear in the tree.** Only `.md` files are shown; hidden folders
(`.git`, `.obsidian` …) and `node_modules` are hidden; in addition, the content selection
of the source applies (right-click → “Edit source …”).

**Changes from VS Code do not appear.** Local folders: immediately (file watching).
Repositories: after the next sync (5 min), immediately with a webhook, or “Sync now”.

**Wiki.js does not show my change yet.** Check whether it was committed (sync icon
green, versions of the note); Wiki.js fetches at its own interval.

**“The file is not valid UTF-8”.** The file has a different character encoding and is not opened,
for protection – save it as UTF-8 in VS Code.

**A link points nowhere.** Settings → Tools → Check → “Check now” lists all broken
links with a jump to the note.

**Forgotten password.** On the sign-in page, **“Forgot password?”** – the link arrives by e-mail.
Without e-mail sending set up, an administrator sets a new initial password under Settings → Users & permissions → **Users** → pencil.

**No e-mail arrived** (reset, invitation). Check the spam folder. Admin: Settings →
Notifications → E-mail → **Send test e-mail**; the log (Security) shows whether Kaveyl Wiki sent it or why
not. The sender address must be allowed as a sender by the mail provider.

**“Link no longer valid”.** Reset links are valid for 30 minutes, invitations for 7 days, both only
once; with several requests, only the newest link is valid. Simply request a new one or invite again.

**Server storage is running low.** Settings → Tools → **Clean-up** shows what takes up how much space
(log, trash, AI chats, backups, local copies), with the [deletion rules](#löschregeln);
**Clean up now** applies them immediately. Notes and Git history grow with the content – large attachments
make a repository permanently larger (Git forgets nothing).

**A note with many images loads slowly.** Kaveyl Wiki shrinks new images when they are inserted
([Large images](#bearbeiten)). Older, very large images in the repository: download them once, shrink them
and insert them again – or drag the width on the image smaller (that only changes the display).

**Restoring from the trash does not work – “There is now another
file in this place”.** Kaveyl Wiki then offers **Save as** – with a different name, folder or in another source
([Trash](#versionen-und-papierkorb)).

**Sign-in fails although the password is correct.** You sign in with your **e-mail address**,
not with your user name.

## Export and print {#exportieren-und-drucken}

You export via **Export** – in the note menu “…”, by right-clicking a note, a folder
or the name of a source in the tree, and in the command palette (“Export note …”). There you choose
the format:

- **HTML** – for reading without Kaveyl Wiki. A note becomes a single **HTML file** with embedded
  images, for sending or archiving. A folder or a whole source becomes a **ZIP**: each
  note becomes an HTML file in the same place, links between them keep working, linked
  images and files are included, and an overview (`index.html`, or `inhalt.html` if the folder
  itself has an `index.md`) lists everything. Encrypted notes are left out.
- **Markdown** – the files themselves, for further use in another tool or as a
  copy. The notes come byte for byte as they are in the source, plus the images and files
  they refer to; the folder structure is kept. A folder or a source comes as a **ZIP**. A single note comes as a
  **`.md` file**; if it refers to pictures or files, as a ZIP with the note and its pictures. Encrypted notes are
  included for a folder – encrypted, as they are in the file.

  The quickest way is the **Download** button (arrow down) in the note's header, next to the width.

Several [marked](#mehrere-markieren) notes and folders of one source come together in **one ZIP**; the paths in it start
at the folder that holds them all.

For both formats: only what you are allowed to read is exported. Images and files outside the
exported folder are not included.

- **Print and PDF:** note menu “…” → **Print / as PDF …** opens the browser’s print dialog
  with a clean page (just the note, without the sidebar and menus). For a PDF,
  choose “Save as PDF” there. The print command in the browser’s menu also prints only the
  note (without the sidebar); this is how you print encrypted notes that are decrypted only in your
  browser. (In Kaveyl Wiki, Ctrl+P is the search.)
- Raw HTML in a note appears as text in the export and is never executed; formulas
  appear as LaTeX text, Mermaid diagrams as code. Links that would run code
  (`javascript:` and the like) stay as text without a target in the export – as in Kaveyl Wiki itself.

![HTML export](handbuch/66-html-export.webp)

## In the browser and as an app: phone, tablet, computer {#im-browser-und-als-app-handy-tablet-computer}

Kaveyl Wiki is a web app: it runs in the browser, on any device, without anything having to be installed. There is
no separate app from the App Store, the Play Store or for download, and none is needed – you sign in
the same way everywhere, and every change is on all devices immediately.

**Put it on your device like an app.** If you use Kaveyl Wiki often, put it on your device like an app via the browser. It
then starts with its own icon (on the home screen, in the Dock or in the taskbar), in its own window
without address and menu bars. This is how it works, depending on the device:

| Device and browser | How to put Kaveyl Wiki on it |
|---|---|
| iPhone, iPad (Safari) | Share → **Add to Home Screen** |
| Android (Chrome, Edge, Samsung Internet) | Menu ⋮ → **Install app** or **Add to Home screen** |
| Windows, Mac, Linux (Chrome, Edge) | Install icon on the right of the address bar, or menu → **Install Kaveyl Wiki** |
| Mac (Safari) | File → **Add to Dock** |
| Firefox on a computer | only partly – easiest with Chrome or Edge |

The Welcome page shows you the way for your device right away; if Kaveyl Wiki is already running as an app, the step
is ticked off there. You can remove the app again like any other (long-press the icon, or in the
browser’s settings); your notes are not affected, they are on the server.

**Requirement: https.** Kaveyl Wiki can only be put on a device as an app if it can be reached via an `https://` address.
Via `http://…`, most browsers create at most a bookmark icon. https is provided by the reverse proxy
that the admin sets up (see [Reverse proxy](#reverse-proxy)).

**Without a connection.** Notes are deliberately not stored on the device – because of permissions and data protection.
Without a network, the app starts with the notice “Offline” and the button “Try again”.

**On a phone and in narrow windows** the sidebar is a drawer: the sidebar icon on the left of the
tab bar (“Show sidebar”) opens it, and tapping a note or the area next to it closes it
again. On touch devices, “+” and expand/collapse are always shown on the source – hovering with the mouse is never
needed –, and on folders for the selected folder; a long press opens the context menu (e.g. “Arrange”). The
formatting bar can be swiped sideways.

![Phone: sidebar as a drawer](handbuch/67-mobil-baum.webp)

![Phone: note](handbuch/68-mobil-notiz.webp)

## Technology and components {#technik-und-komponenten}

**One language for everything.** Kaveyl Wiki is written entirely in **TypeScript** – the server, the
interface in the browser and a shared core that both use (reading and writing Markdown, resolving links,
password rules). The server runs on **Node.js 24**; Kaveyl Wiki is delivered as a
**Docker image** based on Debian (“bookworm-slim”) with the program `git`.

**Licences.** Kaveyl Wiki is free software under the [GNU Affero General Public License v3.0](/LICENSE.txt) – free to
use, change and run yourself; the source code is on [GitHub](https://github.com/kaveyl/wiki). The licence texts of all
libraries and fonts it ships are in the [licences of the components used](/THIRD-PARTY-NOTICES.txt). All three links are
also under [Settings → Help](#hilfe), right below the version. Every installation serves the files at its own address
(`/LICENSE.txt`, `/THIRD-PARTY-NOTICES.txt`); in the container they are at `/app/web/`.

**Design language.** The interface follows its own plain style, as known from modern
note apps: calm, light or dark surfaces, thin lines, a single accent colour (indigo) for
selection and primary buttons. Colours, spacing and fonts are defined as variables, so that light and
dark mode are built from the same building blocks; this is implemented with **Tailwind CSS**. Dialogs, menus
and context menus come from **Radix UI** and can therefore be fully operated with the keyboard, the
icons from **Lucide**. As fonts, Kaveyl Wiki uses Inter and JetBrains Mono for code if they are installed on the
device, otherwise the system font. Everything can also be operated by touch – nothing exists only
on mouse hover.

**Interface and editor.** The web app is built with **React 19** and bundled with **Vite**. The editor
with visible formatting is **TipTap** (on ProseMirror), the source view is **CodeMirror 6**.
Both work on the same Markdown file: it is read and written with **unified/remark**, so
that unchanged sections are kept byte for byte. Formulas are shown by **KaTeX**, diagrams by
**Mermaid**, drawings by **Excalidraw**, and code blocks are coloured with **highlight.js**.

**Server, data and search.** The server is **Fastify** with WebSockets for live messages. What Kaveyl Wiki
stores itself – users, permissions, settings, the log and the search index – is kept in an
**SQLite** database; the notes themselves remain files. Instant search uses SQLite’s full-text index
(FTS5) for word beginnings and a trigram index for parts of words. Kaveyl Wiki works with Git repositories
through the perfectly normal `git` program, and it notices changes to files through file watching.

**Security.** Passwords are stored with scrypt, stored credentials (tokens, SMTP,
AI keys) are encrypted with AES-256-GCM – both with Node.js’s built-in tools. Encrypted
notes use the open **age** format and are decrypted and encrypted only in the browser.

**AI and interfaces.** The AI assistant speaks two widely used protocols: the OpenAI-compatible
interface (Ollama, Ollama Cloud, OpenRouter, OpenAI and similar) and the Anthropic interface.
The REST API and MCP server are part of Kaveyl Wiki itself – see [API and MCP](#api-und-mcp-claude-hermes-skripte).

**Testing is done** with **Vitest** (individual building blocks) and **Playwright** (the whole interface in a real
browser); the images in this manual are created automatically along the way.

### List of components {#verzeichnis-der-komponenten}

All components are open source. The table gives the name, what Kaveyl Wiki needs them for, the
package names and the licence.

**Interface**

| Component | Used for | Packages | Licence |
|---|---|---|---|
| React | the web app | `react`, `react-dom` | MIT |
| TanStack Query | loading data from the server and keeping it up to date | `@tanstack/react-query` | MIT |
| Zustand | interface state (tabs, dialogs, help) | `zustand` | MIT |
| Radix UI | dialogs, menus, context menus, pop-overs | `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-context-menu`, `@radix-ui/react-popover` | MIT |
| Tailwind CSS | styling, colours, light/dark | `tailwindcss`, `@tailwindcss/vite` | MIT |
| Lucide | icons in the interface and for notes | `lucide-react` | ISC |
| Vite | builds the web app | `vite`, `@vitejs/plugin-react` | MIT |

**Editor and content**

| Component | Used for | Packages | Licence |
|---|---|---|---|
| TipTap / ProseMirror | editor with visible formatting | `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extensions`, `@tiptap/extension-code`, `@tiptap/extension-code-block-lowlight`, `@tiptap/extension-details`, `@tiptap/extension-image`, `@tiptap/extension-list`, `@tiptap/extension-table`, `@tiptap/suggestion` | MIT |
| CodeMirror 6 | Markdown source | `@codemirror/view`, `@codemirror/lang-markdown`, `@codemirror/language-data`, `@uiw/react-codemirror` | MIT |
| unified / remark | reading and writing Markdown (tables, tasks, formulas, front matter) | `unified`, `remark-parse`, `remark-stringify`, `remark-gfm`, `remark-math`, `remark-frontmatter`, `mdast-util-gfm`, `mdast-util-math`, `mdast-util-frontmatter`, `mdast-util-to-markdown` | MIT |
| lowlight / highlight.js | colours in code blocks | `lowlight` | MIT / BSD-3-Clause |
| KaTeX | formulas | `katex` | MIT |
| Mermaid | diagrams from text | `mermaid` | MIT |
| Excalidraw | drawings | `@excalidraw/excalidraw` | MIT |
| YAML | front matter and templates | `yaml` | ISC |
| age | encrypted notes | `age-encryption` | BSD-3-Clause |

**Server**

| Component | Used for | Packages | Licence |
|---|---|---|---|
| Fastify | web server, REST API, live messages | `fastify`, `@fastify/compress`, `@fastify/cookie`, `@fastify/static`, `@fastify/websocket` | MIT |
| better-sqlite3 | database and search index (SQLite) | `better-sqlite3` | MIT |
| @parcel/watcher | notices changes made to files from outside | `@parcel/watcher` | MIT |
| Nodemailer | e-mails (forgotten password, invitations, notifications) | `nodemailer` | MIT-0 |
| hast / mdast | HTML export | `mdast-util-to-hast`, `hast-util-to-html` | MIT |
| fflate | ZIP export | `fflate` | MIT |
| node-html-markdown | import: HTML notes (Joplin web clipper) → Markdown | `node-html-markdown` | MIT |
| zip.js | backups as ZIP, AES-256-encrypted with a password; reading backups when restoring | `@zip.js/zip.js` | BSD-3-Clause |
| picomatch | patterns for included and excluded files | `picomatch` | MIT |
| ULID | time-sortable IDs | `ulid` | MIT |

**Runtime and delivery**

| Component | Used for | Licence |
|---|---|---|
| Node.js 24 | runs the server | MIT |
| Debian “bookworm-slim” | basis of the Docker image | various free licences |
| Git | cloning repositories, syncing, commits | GPL-2.0 |
| tini | clean start and stop in the container | MIT |
| smbclient (Samba) | backups to SMB shares (Windows, NAS) | GPL-3.0 |

**Development and tests** (not part of the delivered program)

| Component | Used for | Packages | Licence |
|---|---|---|---|
| TypeScript | programming language, type checking | `typescript` | Apache-2.0 |
| esbuild | builds the server | `esbuild` | MIT |
| Vitest | tests of individual building blocks | `vitest` | MIT |
| oxlint | checks the source code for typical mistakes (including React hooks) | `oxlint` | MIT |
| Playwright | tests of the interface in the browser, manual images | `@playwright/test` | Apache-2.0 |

