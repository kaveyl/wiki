// Incoming push webhook of Gitea/GitHub/GitLab: syncs the matching sources at once. Moved out of buildApp (code-002).
import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { repoDir } from '../mounts/model.js';
import type { AppContext } from './context.js';

export function registerGitWebhook(server: FastifyInstance, ctx: AppContext) {
  const { config, manager, record, settings, webhookSeen } = ctx;
  // ── Webhook (Gitea/GitHub push) ───────────────────────────────────────────────────
  server.post('/api/webhooks/git', async (req, reply) => {
    const secret = settings.get('webhook_secret')!;
    // Gitea and GitHub sign the body (HMAC-SHA256); GitLab sends the secret itself as a token.
    const gitlabToken = req.headers['x-gitlab-token'];
    const provider = gitlabToken !== undefined ? 'GitLab' : req.headers['x-gitea-signature'] ? 'Gitea' : req.headers['x-hub-signature-256'] ? 'GitHub' : '?';
    // Compare bytes, not characters: a non-ASCII header has more bytes than characters, and timingSafeEqual throws then (sec-003).
    const same = (a: string, b: string) => {
      const x = Buffer.from(a);
      const y = Buffer.from(b);
      return x.length === y.length && timingSafeEqual(x, y);
    };
    const valid =
      gitlabToken !== undefined
        ? same(String(gitlabToken), secret)
        : same(
            String(req.headers['x-gitea-signature'] ?? req.headers['x-hub-signature-256'] ?? '').replace(/^sha256=/, ''),
            createHmac('sha256', secret).update(req.rawBody ?? '').digest('hex'),
          );
    if (!valid) {
      record({ category: 'audit', level: 'warn', action: 'webhook-rejected', message: `Webhook (${provider}) mit ungültiger Signatur abgelehnt`, detail: { ip: req.ip } });
      return reply.code(401).send({ error: 'Signatur ungültig' });
    }
    // GitHub's „ping“ when a hook is created: nothing to sync.
    if (req.headers['x-github-event'] === 'ping') return { ok: true, ping: true };
    const body = req.body as {
      ref?: string;
      repository?: { clone_url?: string; html_url?: string; ssh_url?: string; git_http_url?: string; homepage?: string };
      project?: { git_http_url?: string; web_url?: string; path_with_namespace?: string };
    };
    const branch = body.ref?.startsWith('refs/heads/') ? body.ref.slice('refs/heads/'.length) : null;
    const r = body.repository;
    const urls = [r?.clone_url, r?.html_url, r?.ssh_url, r?.git_http_url, r?.homepage, body.project?.git_http_url, body.project?.web_url].filter((u): u is string => !!u);
    const targets = manager.findBySource(urls, branch);
    const seen = new Set<string>();
    for (const m of targets) {
      const dir = repoDir(m, config.dataPath);
      if (seen.has(dir)) continue;
      seen.add(dir);
      void manager.sync(m);
    }
    const repo = body.project?.path_with_namespace ?? (urls[0] ? urls[0].replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '') : '?');
    if (targets.length) {
      const at = new Date().toISOString();
      settings.set('webhook_seen', JSON.stringify({ ...webhookSeen(), ...Object.fromEntries(targets.map((m) => [m.id, at])) }));
    }
    record({
      category: 'sync',
      action: 'webhook-received',
      message: `Webhook von ${provider}: ${repo}${branch ? ` (${branch})` : ''} → ${targets.length ? targets.map((m) => m.name).join(', ') : 'keine passende Quelle'}`,
    });
    return { ok: true, mounts: targets.length };
  });
}
