// Around the notes, not the note itself: custom icons (AD-018), files of notes, note meta (tags, icon,
// readonly), recently changed, tags (colours, rename) and search. Moved out of buildApp (code-002).
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isTagColor, tagKey, TAG_COLOR_NAMES, type TagColor } from '@kaveyl-wiki/core';
import { search, searchFull, type SearchHit } from '../index/search.js';
import { PathError, absPath } from '../mounts/model.js';
import { NotFoundError } from '../notes/service.js';
import { readTagColors, writeTagColors } from '../notes/order.js';
import { IconError } from '../icons/icons.js';
import { atLeast } from '../acl/acl.js';
import { INLINE_TYPES, isServable } from '../notes/attachments.js';
import type { AppContext } from './context.js';

export function registerLibraryRoutes(server: FastifyInstance, ctx: AppContext) {
  const { access, audit, author, canRead, config, db, icons, levelIn, manager, mountRef, mountVisible, notes, requireAdmin } = ctx;
  // ── Custom icons (AD-018): global, any user may add; delete own (admins: all) ────────────
  server.get('/api/icons', async () => icons.list());

  server.post<{ Querystring: { name?: string }; Body: Buffer }>('/api/icons', { bodyLimit: 1024 * 1024 }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new IconError('Erwartet: Bilddatei (application/octet-stream)');
    const icon = icons.add(String(req.query.name ?? ''), req.body, req.user!.id);
    audit(req, 'icon-added', `Icon hochgeladen: ${icon.name} (${icon.mime}, ${Math.ceil(icon.size / 1024)} KB)`);
    return icon;
  });

  server.get<{ Params: { id: string } }>('/api/icons/:id', async (req, reply) => {
    const icon = icons.get(req.params.id);
    if (!icon) throw new NotFoundError(req.params.id);
    // Ids never change their content: cache for good. An SVG opened directly runs no script.
    return reply
      .header('content-type', icon.mime)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(icon.data);
  });

  server.delete<{ Params: { id: string } }>('/api/icons/:id', async (req) => {
    const owner = icons.owner(req.params.id);
    if (owner === undefined) throw new NotFoundError(req.params.id);
    if (owner !== req.user!.id) requireAdmin(req);
    const name = icons.list().find((i) => i.id === req.params.id)?.name;
    icons.remove(req.params.id);
    audit(req, 'icon-removed', `Icon gelöscht: ${name}`);
    return { ok: true };
  });

  // Files referenced from notes. Images/PDF inline; other files only inside `assets/` folders
  // (attachments) and only as download. Always nosniff + sandbox CSP so an SVG or HTML file in
  // a repo can never run script in the app's origin; never dotfiles (.env …).
  server.get<{ Params: { mountId: string; '*': string }; Querystring: { download?: string } }>('/api/files/:mountId/*', async (req, reply) => {
    const rel = req.params['*'];
    const mount = access(req, req.params.mountId, rel, 'read', false);
    const ext = extname(rel).slice(1).toLowerCase();
    const inline = Object.hasOwn(INLINE_TYPES, ext) ? INLINE_TYPES[ext] : undefined;
    if (!isServable(rel)) throw new NotFoundError(rel);
    const abs = absPath(mount, config.dataPath, rel);
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile()) throw new NotFoundError(rel);
    const name = rel.split('/').pop()!;
    const download = !inline || req.query.download === '1';
    reply
      .header('content-type', inline ?? 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'private, no-cache');
    if (download) reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(createReadStream(abs));
  });

  server.put<{ Params: { mountId: string; '*': string }; Body: { tags?: string[]; icon?: string | null; readonly?: boolean; baseHash: string } }>('/api/meta/:mountId/*', async (req) => {
    const mount = access(req, req.params.mountId, req.params['*'], 'write', false);
    const { tags, icon, readonly, baseHash } = req.body;
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) throw new PathError('tags: Liste von Texten erwartet');
    if (icon !== undefined && icon !== null && typeof icon !== 'string') throw new PathError('icon: Text erwartet');
    return notes.setMeta(mount, req.params['*'], { tags, icon, readonly: readonly === undefined ? undefined : !!readonly }, String(baseHash ?? ''), author(req));
  });

  /** Recently changed notes (file mtime — covers app edits, VS Code and git pulls). */
  server.get<{ Querystring: { limit?: string } }>('/api/recent', async (req) => {
    const active = manager.list().filter((m) => !m.paused).map((m) => m.id);
    if (!active.length) return [];
    const limit = Math.min(50, Number(req.query.limit ?? 15) || 15);
    const rows = db
      .prepare(
        `SELECT mount_id AS mountId, path, title, icon, mtime FROM entries WHERE kind = 'file' AND mount_id IN (${active.map(() => '?').join(',')}) ORDER BY mtime DESC LIMIT ?`,
      )
      .all(...active, limit * 4) as { mountId: string; path: string }[];
    return rows.filter((r) => canRead(req, r.mountId, r.path)).slice(0, limit);
  });

  /** Notes per tag (lower-case key) the user may read, per source: tag browser, colors, renaming. */
  const tagIndex = (req: FastifyRequest) => {
    const active = new Map(manager.list().filter((m) => !m.paused).map((m) => [m.id, m]));
    const tags = new Map<string, { tag: string; byMount: Map<string, string[]> }>();
    for (const r of db.prepare("SELECT mount_id, path, tags_json FROM entries WHERE kind = 'file' AND tags_json != '[]'").all() as { mount_id: string; path: string; tags_json: string }[]) {
      if (!active.has(r.mount_id) || !canRead(req, r.mount_id, r.path)) continue;
      for (const t of JSON.parse(r.tags_json) as string[]) {
        const key = tagKey(String(t));
        const e = tags.get(key) ?? { tag: String(t), byMount: new Map<string, string[]>() };
        e.byMount.set(r.mount_id, [...(e.byMount.get(r.mount_id) ?? []), r.path]);
        tags.set(key, e);
      }
    }
    return { active, tags };
  };
  /** Tag colors of every visible source (AD-040): mountId → tag (lower-case) → color. */
  const tagColorsOf = async (req: FastifyRequest) => {
    const out: Record<string, Record<string, TagColor>> = {};
    for (const m of manager.list()) if (!m.paused && mountVisible(req, m.id)) out[m.id] = await readTagColors(m, config.dataPath);
    return out;
  };

  /** All tags with their note counts and color (tag browser, autocomplete). The color is the one most of its notes have. */
  server.get('/api/tags', async (req) => {
    const { tags } = tagIndex(req);
    const colors = await tagColorsOf(req);
    return [...tags.entries()]
      .map(([key, e]) => {
        const votes = new Map<TagColor, number>();
        let count = 0;
        for (const [mountId, paths] of e.byMount) {
          count += paths.length;
          const c = colors[mountId]?.[key];
          if (c) votes.set(c, (votes.get(c) ?? 0) + paths.length);
        }
        const color = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        return { tag: e.tag, count, color, mixed: votes.size > 1 };
      })
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'de'));
  });

  server.get('/api/tag-colors', async (req) => tagColorsOf(req));

  /**
   * Colors a tag (AD-040) in every source it occurs in (or has a color in) — saved in that source's
   * `.kaveyl-wiki.yml`, so it travels with the repository. Needs write access to the source; sources
   * without it keep their color and are named in the answer.
   */
  server.put<{ Body: { tag?: string; color?: string | null } }>('/api/tags/color', async (req) => {
    const key = tagKey(String(req.body?.tag ?? ''));
    const color = req.body?.color ?? null;
    if (!key) throw new PathError('Bitte ein Tag angeben');
    if (color !== null && !isTagColor(color)) throw new PathError('Unbekannte Farbe');
    const { active, tags } = tagIndex(req);
    const colors = await tagColorsOf(req);
    const mounts = [...active.values()].filter((m) => tags.get(key)?.byMount.has(m.id) || colors[m.id]?.[key]);
    const saved: string[] = [];
    const skipped: string[] = [];
    const label = color ? TAG_COLOR_NAMES[color] : 'keine Farbe';
    for (const m of mounts) {
      if (m.options.readonly || !atLeast(levelIn(req, m.id, '', true), 'write')) {
        skipped.push(m.name);
        continue;
      }
      await writeTagColors(manager, config.dataPath, m, { [key]: color }, author(req), `Tag-Farbe #${key}: ${label} (Kaveyl Wiki)`);
      saved.push(m.name);
      audit(req, 'tag-color', `Tag #${key}: ${label}`, { mount: mountRef(m) });
    }
    return { saved, skipped };
  });

  /**
   * Renames a tag in every note the user may change (AD-040) — into an existing tag merges both.
   * The color moves along when the new tag has none yet. Notes without write access stay as they are.
   */
  server.post<{ Body: { from?: string; to?: string } }>('/api/tags/rename', async (req) => {
    const from = String(req.body?.from ?? '').trim().replace(/^#/, '');
    const to = String(req.body?.to ?? '').trim().replace(/^#/, '').replace(/,/g, ' ').trim();
    if (!from || !to) throw new PathError('Bitte alten und neuen Namen angeben');
    const { active, tags } = tagIndex(req);
    const entry = tags.get(tagKey(from));
    let count = 0;
    let skipped = 0;
    const sources: string[] = [];
    for (const [mountId, paths] of entry?.byMount ?? []) {
      const m = active.get(mountId)!;
      const writable = m.options.readonly ? [] : paths.filter((p) => atLeast(levelIn(req, m.id, p, false), 'write'));
      skipped += paths.length - writable.length;
      if (!writable.length) continue;
      const changed = await notes.renameTag(m, writable, from, to, author(req));
      count += changed.length;
      if (changed.length) sources.push(m.name);
      // The color follows the tag (unless the target already has its own).
      const colors = await readTagColors(m, config.dataPath);
      const old = colors[tagKey(from)];
      if (old && tagKey(from) !== tagKey(to) && atLeast(levelIn(req, m.id, '', true), 'write')) {
        await writeTagColors(manager, config.dataPath, m, { [tagKey(from)]: null, ...(colors[tagKey(to)] ? {} : { [tagKey(to)]: old }) }, author(req), `Tag-Farbe #${tagKey(from)} → #${tagKey(to)} (Kaveyl Wiki)`);
      }
      audit(req, 'tag-renamed', `Tag #${from} → #${to} in ${changed.length} Notiz(en)`, { mount: mountRef(m) });
    }
    return { notes: count, skipped, sources };
  });

  server.get<{ Querystring: { q?: string; limit?: string } }>('/api/search/full', async (req) => {
    const mounts = manager.list().filter((m) => !m.paused && mountVisible(req, m.id)).map((m) => ({ id: m.id, name: m.name }));
    const limit = Math.min(200, Number(req.query.limit ?? 100) || 100);
    const result = searchFull(db, req.query.q ?? '', { limit: req.user!.isAdmin ? limit : 200, mounts });
    return { ...result, hits: result.hits.filter((h) => canRead(req, h.mountId, h.path)).slice(0, limit) };
  });

  server.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', async (req) => {
    const active = manager.list().filter((m) => !m.paused && mountVisible(req, m.id)).map((m) => m.id);
    const limit = Math.min(50, Number(req.query.limit ?? 8) || 8);
    const r = search(db, req.query.q ?? '', { limit: req.user!.isAdmin ? limit : limit * 4, mountIds: active });
    const keep = (list: SearchHit[]) => list.filter((h) => canRead(req, h.mountId, h.path, h.kind === 'dir')).slice(0, limit);
    return { folders: keep(r.folders), notes: keep(r.notes), content: keep(r.content) };
  });
}
