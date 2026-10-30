# Installing Kaveyl Wiki

Kaveyl Wiki is a wiki whose only storage is Git: notes are Markdown files in repositories (Gitea, GitHub, GitLab, any
Git server) or in folders. It runs as a single Docker container. Once it is running, the full manual is inside
Kaveyl Wiki under **Help** (key F1), in English and German.

## Requirements

- A Linux machine or NAS with an x86-64 processor (amd64), Docker and Docker Compose.
- About 1 GB of space for the image, plus space for your notes.

## 1. Get the image

The image is published on the GitHub Container Registry. In `docker-compose.yml`, `image:` already names it, e.g.
`ghcr.io/kaveyl/wiki:0.2.10`; `docker compose up -d` (or `docker compose pull`) downloads it.

Alternatively, each release on GitHub carries the file `kaveyl-wiki-<version>.tar.gz`:

```sh
sha256sum -c --ignore-missing SHA256SUMS   # optional: check the downloaded files
docker load -i kaveyl-wiki-0.2.10.tar.gz
```

Then set `image: kaveyl-wiki:0.2.10` in `docker-compose.yml` – a name without a registry is only looked up on your own
machine.

## 2. Create the folders and start

Put `docker-compose.yml` into an empty folder, then in that folder:

```sh
mkdir -p kaveyl-wiki/config kaveyl-wiki/data kaveyl-wiki/docs kaveyl-wiki/backup
sudo chown -R 1000:1000 kaveyl-wiki       # Kaveyl Wiki runs as user 1000 inside the container
docker compose up -d
```

Should the folders belong to another user – for example your own user on a NAS, so that you can also reach them through
a share – leave them as they are and set that user in `docker-compose.yml` instead: `user: "<uid>:<gid>"`, the numbers
from `id <user>` (e.g. `uid=1000(anna) gid=100(users)` → `user: "1000:100"`). Kaveyl Wiki then runs as this user.

Check the time zone (`TZ`) in `docker-compose.yml`: the nightly run and backup schedules follow it.

## 3. First-run setup

1. Get the **setup code** from the log: `docker logs kaveyl-wiki` – it is framed by equals signs, e.g.
   `K7QF-M2XD-9HPA`. (It is also in `kaveyl-wiki/config/setup-code`.)
2. Open `http://localhost:8093` in a browser, enter the code and create the administrator account
   (name, e-mail, a password of at least 15 characters).
3. Then **Add source**: a repository through a connection (Gitea, GitHub, GitLab, Git URL) or a subfolder of
   `kaveyl-wiki/docs`.

The code is only valid until setup is done. It prevents someone else from taking over the fresh instance first – so
set up Kaveyl Wiki right after starting it.

The interface follows the browser's language (English or German; English for any other language). Each person can
change it under Settings → Appearance → Language.

## On your network and over HTTPS

In detail, with examples: in Kaveyl Wiki under **Help → Access over the network**.

- On your own network: with `ports: "8093:8000"` (as in the template) Kaveyl Wiki is reachable at
  `http://<LAN-IP>:8093` – best set it up like this first. If the reverse proxy runs on the same Docker host, you can
  use `"127.0.0.1:8093:8000"` instead: then only this machine (and the proxy) reaches port 8093.
- Then through a domain: in your reverse proxy (e.g. Nginx Proxy Manager), add an entry for the domain pointing to
  `http://<LAN-IP>:8093`. No change to `docker-compose.yml` is needed. A sign-in applies per address – sign in once
  more through the domain. Over https it automatically applies to https only (cookie with `Secure`); direct access on
  your own network (http, e.g. port 8093) keeps working. In Kaveyl Wiki, enter the “Public address of Kaveyl Wiki” under
  Settings → Notifications → E-mail (used for links in e-mails and for webhooks).
- In Nginx Proxy Manager, switch on **“Websockets Support”** for the proxy host (live updates through `/api/events`) and
  choose a certificate with “Force SSL”. If Kaveyl Wiki reports “Too large for the server” (HTTP 413) when uploading and
  the proxy's limit was lowered (NPM allows 2000 MB by default), raise it under “Advanced”, e.g.
  `client_max_body_size 100m;` – at least as large as “Largest allowed file” (Settings → Attachments). Through
  Cloudflare, its own limit applies as well (100 MB on the Free and Pro plans).
- `TRUST_PROXY`: the proxies from which Kaveyl Wiki accepts the forwarded visitor address and the “https” hint (log,
  sign-in throttling, https detection). Without it, this applies to every device on your own network – then any device
  there can pose as a proxy, put a false visitor address into the log and get around the per-device sign-in throttling.
  Recommended: enter the proxy's address, several separated by commas (e.g.
  `TRUST_PROXY=<address of the proxy>,<address of a second proxy>`), then `docker compose up -d`. In
  `docker-compose.yml` you can also list them one per line with a comment (`#` to the end of the line does not count) –
  the example is already there under `environment:`: uncomment it and replace the example addresses with those of your
  own proxies:

  ```yaml
      environment:
        TRUST_PROXY: |
          192.168.1.10   # Nginx Proxy Manager
          172.18.0.5     # Pangolin/Newt
  ```

  Allowed are addresses, ranges (e.g. `192.168.1.0/24`), `loopback`, `linklocal` and `uniquelocal`. With an invalid
  entry Kaveyl Wiki does not start and names it in the container log. `TRUST_PROXY=false` ignores forwarded addresses
  altogether. If a request comes through a proxy while `TRUST_PROXY` is not set, a warning appears once in the container
  log and in the app's log (Tools → Log). The address in it comes from the first such request and is probably the proxy –
  compare it with your reverse proxy's address before entering it. If the proxy runs as a container on the same
  machine, this is often an address from the Docker network.
- From outside without an open port, e.g. with Pangolin (self-hosted or Pangolin Cloud): **Newt** runs on your own
  network and is added in Pangolin as a site; the resource for the domain points through this site to
  `<LAN-IP>:8093`. Pangolin protects access with its own sign-in; after that you sign in to Kaveyl Wiki (Kaveyl Wiki does
  not take over Pangolin's sign-in – Pangolin has no sign-out address). Webhooks, REST API and MCP need “Bypass Auth”
  rules (match: Path) in the resource for `/api/v1/*`, `/mcp` and `/api/webhooks/git`. Newt's address belongs in
  `TRUST_PROXY`.

## Backing up

What matters is **`kaveyl-wiki/config`**: the database (accounts, settings, search, log), the key `secret.key` that
encrypts stored credentials, and Kaveyl Wiki's own backups. Without `secret.key`, stored tokens can no longer be read.
Notes in repositories are in the repository anyway; folders under `kaveyl-wiki/docs` need a backup of their own (Kaveyl
Wiki's backup takes their versions along).
Kaveyl Wiki can create backups itself (Settings → Backup), also to a NAS over SMB.

## Updating

What a new version changes is in `CHANGES.md` and in the release notes on GitHub. Admins also see a hint at the top
right of Kaveyl Wiki when a new version is out (can be switched off under Settings → Notifications → Updates).

1. Back up `kaveyl-wiki/config` (see above).
2. Change the version under `image:` in `docker-compose.yml`, then `docker compose pull` (or `docker load …` for the
   file).
3. `docker compose up -d` – the database is migrated automatically on start.

Going back to an older version only works together with the backup from before the update, if the database changed.

## Removing

`docker compose down` stops and removes the container. The data stays in the `kaveyl-wiki` folder until you delete it
yourself.
