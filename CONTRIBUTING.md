# Contributing to Kaveyl Wiki

Thank you for helping! Kaveyl Wiki is maintained by a small core team, so here is how to make your contribution count.

## Bugs and ideas

Open an [issue](https://github.com/kaveyl/wiki/issues/new/choose) – the forms ask for what we need (version, steps,
what you expected). Please search first whether it already exists, and never post passwords, tokens or private note
contents. Security issues go through **Security → Report a vulnerability** instead (see [SECURITY.md](SECURITY.md)).

## Code changes

Please **open an issue before you start** and describe what you want to change. We agree on the approach there first –
that saves you work on a pull request we could not take (for example because it conflicts with a design decision).

When we have agreed:

1. Fork, create a branch from `main`, keep the change focused on one thing.
2. Run the checks locally (Node.js 24):
   ```sh
   npm ci
   npm run typecheck && npm run lint && npm test
   ```
   The Playwright end-to-end tests run against the built app: `npm run build`, then `npm run e2e`.
3. Open the pull request and link the issue. The template has a short checklist.

## Conventions

- **Notes stay plain files.** Kaveyl Wiki never keeps note content in its database and never rewrites what the user
  did not change – keep it that way.
- **Visible texts** are written in German in `t('…')` / `tn(…)` and get an English entry in the dictionaries
  (`apps/web/src/i18n/en/`, server: `apps/server/src/i18n/en.ts`); `i18n.test.ts` checks this.
- **The manual is the in-app help.** If users see a difference, update `docs/BENUTZERHANDBUCH.md` and
  `docs/i18n/en/BENUTZERHANDBUCH.md` – headings are help anchors, `help.test.ts` checks both.
- **Permissions everywhere.** New note routes go through the existing access checks; public and MCP operations live in
  `apps/server/src/api/ops.ts`.
- **Commit messages:** `type(scope): short description` – `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
- Do not reformat files you do not otherwise change.

## License

By contributing you agree that your contribution is licensed under the
[GNU Affero General Public License v3.0](LICENSE), like the rest of Kaveyl Wiki.

## Code of conduct

Please be kind and constructive – see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
