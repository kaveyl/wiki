// Which errors are meant for the caller – their text is shown, with an HTTP status – and which are internal: those
// get a general text, the details stay in the server log (sec-008, CWE-209). One rule for the web app, REST v1, MCP
// and the AI agent (audit sec2-003): internal texts (file system, git) can name server paths and closed folders.
import { AuthError } from './auth/auth.js';
import { MailError } from './mail/mailer.js';
import { PathError } from './mounts/model.js';
import { HostError } from './mounts/hosts.js';
import { ConflictError, ForbiddenError, NotFoundError } from './notes/service.js';
import { AiProviderError } from './ai/providers.js';
import { AiRuleError } from './ai/rules.js';
import { AiAccessError } from './ai/assistant.js';
import { IconError } from './icons/icons.js';
import { AclError } from './acl/acl.js';
import { AttachmentError } from './notes/attachments.js';
import { StaleConflictError } from './git/conflict.js';
import { UnsafeRepoError } from './git/git.js';
import { NotifyError } from './notify/notifier.js';
import { TargetError } from './backups/targets.js';
import { BackupError } from './backups/service.js';
import { ArchiveError } from './backups/archive.js';

/** Status and text for the caller, or null for an internal error (answer „Interner Fehler“, log the details). */
export function publicError(err: unknown): { status: number; message: string; code?: string } | null {
  if (!(err instanceof Error)) return null;
  const is = (...classes: (abstract new (...args: never[]) => Error)[]) => classes.some((c) => err instanceof c);
  if (err instanceof ConflictError || err instanceof StaleConflictError || err instanceof UnsafeRepoError) return { status: 409, message: err.message };
  if (err instanceof NotFoundError) return { status: 404, message: 'Nicht gefunden' };
  if (is(ForbiddenError, AiAccessError)) return { status: 403, message: err.message };
  if (is(BackupError, ArchiveError)) {
    const code = (err as BackupError | ArchiveError).code;
    return { status: 400, message: err.message, ...(code && { code }) };
  }
  if (is(PathError, AuthError, NotifyError, AttachmentError, IconError, AclError, AiRuleError, TargetError)) return { status: 400, message: err.message };
  if (is(MailError, AiProviderError)) return { status: 502, message: err.message };
  if (err instanceof HostError) return { status: err.status === 409 || err.status === 403 ? err.status : err.status === 422 ? 400 : 502, message: err.message };
  const code = (err as Error & { statusCode?: number }).statusCode;
  return code && code < 500 ? { status: code, message: err.message } : null;
}
