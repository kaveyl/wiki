# Incident agent – an example

An agent that works **together with people** in Kaveyl Wiki: warnings from a server become incident notes, people
release the suggested actions by ticking a checkbox, and the agent answers questions in the note.

```
syslog warning ──▶ agent ──create_note──▶  Incidents/Incident 09.10.02 – nginx upstream timed out.md
                                            - [ ] Restart nginx
person ticks the box ──▶ Kaveyl Wiki records who ──list_changes──▶ agent checks: may this person release it?
                                                                   yes → run the fixed action, write the result
                                                                   no  → untick, write why
```

What it shows:

- **Who ticked comes from Kaveyl Wiki** (`by`/`byId` in `list_changes`), never from the note text. A change from
  outside (a Git push) has no person and never releases anything.
- **Only fixed actions** (the `ACTIONS` list in `agent.mjs`), run without a shell, and only those suggested for that
  incident. Text in a note is never a command.
- **Nothing gets lost:** the cursor is kept in a file, so a restart of the agent catches up. When the cursor is too old
  (`reset`), nobody can tell who ticked – the agent unticks and asks again instead of acting.
- **Writing safely:** read → change → write with `base_hash`, re-read on a conflict, a short pause while someone is
  typing in the note (`editingNow`).

Requires Node.js 22 or newer; no packages to install.

## Set up Kaveyl Wiki

1. **An account for the agent** – Settings → Users & permissions → tab Users → **New user** (e.g. “Server agent
   web-01”), role **User** (guests cannot create tokens).
2. **Permissions** – right-click on the folder the agent reports into (e.g. `Incidents`) → **Permissions …** → the
   account with **read & write**. With the default permission (tab Permissions) at “see nothing”, it sees nothing else.
3. **A token** – sign in as the agent (private window), set its password, then Settings → AI & APIs → API tokens:
   a token with **read**, **write** and **MCP**.
4. **The team follows the folder** – right-click on the folder → **Follow …** (dot, e-mail or Pushover).
5. **Optional: an event webhook** (admins: Settings → AI & APIs → Event webhooks) with the agent’s permissions, limited
   to the folder, pointing at the agent: `http://<agent's machine, as Kaveyl Wiki reaches it>:<HOOK_PORT>/`. Kaveyl
   Wiki runs in Docker, so set `HOOK_HOST` to an address the container can reach (e.g. `0.0.0.0` behind a firewall, or
   the Docker bridge `172.17.0.1` when both run on the same machine) – the default `127.0.0.1` only works for programs
   on the same machine outside Docker. Create the webhook first: its secret (`HOOK_SECRET`) is shown only then. Without it the agent waits for changes itself (long polling) –
   just as fast, but it keeps a connection open.

More in the manual: “Agents in the team”, and in the API reference: “Events for agents”.

## Run it

```sh
export KAVEYL_URL=https://wiki.example.org
export KAVEYL_TOKEN=kw_…            # the agent's token – keep it in a file with chmod 600, not in your shell history
export SOURCE_ID=01J…               # from GET /api/v1/sources (or the MCP tool list_sources)
export FOLDER=Incidents
export APPROVERS=                   # empty at first – see below

journalctl -f -p warning -o cat | node agent.mjs
```

Any line on stdin is a warning, so you can try it without a server: `echo "nginx: upstream timed out" | node agent.mjs`
(the agent keeps running and waits for answers; stop it with Ctrl+C).

**Who may release?** `APPROVERS` is a comma-separated list of account ids. An administrator copies them in Kaveyl Wiki
under Settings → Users & permissions → Users (the fingerprint button of each account); the agent also logs the id of
everyone who changes an incident (`change by Maria Chen (user id 01J…)`). Put the ids into `APPROVERS` and restart.
Until then every tick is refused. These rules are this agent's – Kaveyl Wiki only says reliably who changed a note.

**Dry run first.** By default the agent only writes what it would run (`dry run – would run: systemctl restart nginx`).
When the actions in `ACTIONS` are the ones you want, set `DRY_RUN=0`. Run the agent as a user that may do exactly these
actions and nothing more (e.g. a `sudoers` entry for one command).

| Setting | Meaning |
|---|---|
| `KAVEYL_URL` | Address of Kaveyl Wiki (the agent talks to `<address>/mcp`) |
| `KAVEYL_TOKEN` | API token of the agent's own account (read, write, MCP) |
| `SOURCE_ID`, `FOLDER` | Where the incident notes go |
| `APPROVERS` | User ids whose ticks release actions (comma-separated) |
| `DRY_RUN` | `0` runs the actions; anything else only describes them (default) |
| `HOST_LABEL` | Host name shown in the incident notes (default: this machine's name) |
| `STATE` | File for the cursor and the open incidents (default `agent-state.json`) |
| `HOOK_PORT`, `HOOK_HOST`, `HOOK_SECRET` | Optional webhook receiver (default host `127.0.0.1`); the secret is shown once when the webhook is created |

## Make it yours

- **Actions:** edit `ACTIONS` – a label (the checkbox text), a pattern for the warnings it fits, and the command as a
  list of arguments. Keep them few and harmless; every action is something a ticked box can trigger.
- **Facts for answers:** `FACTS` – read-only commands whose output answers “Question: …” lines.
- **An AI instead of fixed answers:** let an AI (e.g. Claude with Kaveyl Wiki's MCP server) answer the questions, but
  give it only reading tools for the server and leave running actions to this agent. A tick by the AI is then no
  release – the agent refuses it like any other tick from someone not in `APPROVERS`.
- **Read first, then check:** the agent reads the note and only then asks who changed it since the last check. If
  you change how releases are decided, keep this order – checking first and reading afterwards would let a tick that
  arrives in between run under the name of the person who changed the note before.
