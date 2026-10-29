// „Teilen → Zugriff per E-Mail geben …“ (AD-030): access to a note, a folder or a whole source (owner 21.10.) for an address – read,
// or read and write. An existing account gets access at once and a notice; anyone else an invitation that creates a
// guest account.
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Send } from 'lucide-react';
import { api, errorText, type AclTarget } from '../api';
import { t, tn } from '../i18n';
import { toast } from '../toast';
import { Button, Field, Input, Modal, Spinner, fillNodes, FormError } from '../ui';

const ACCESS: Record<AclTarget, Record<'read' | 'write', string>> = {
  note: { read: t('Leserecht auf diese eine Notiz'), write: t('Lese- und Schreibrecht auf diese eine Notiz') },
  folder: { read: t('Leserecht auf diesen Ordner mit allem darin'), write: t('Lese- und Schreibrecht auf diesen Ordner mit allem darin') },
  mount: { read: t('Leserecht auf diese ganze Quelle'), write: t('Lese- und Schreibrecht auf diese ganze Quelle') },
};

/** Further notes and folders of the same source (several marked in the tree), shared in one go. */
export interface ShareMore {
  target: 'note' | 'folder';
  path: string;
  title: string;
}

export function ShareDialog({ mountId, target, path, title, more = [], onClose }: { mountId: string; target: AclTarget; path: string; title: string; more?: ShareMore[]; onClose: () => void }) {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [level, setLevel] = useState<'read' | 'write'>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.share({ mountId, target, path, level, email, displayName: name, more: more.map(({ target, path }) => ({ target, path })) });
      const who = { email: email.trim(), title, n: String(more.length + 1) };
      setDone([
        ...done,
        more.length
          ? r.existing
            ? t('{email} hat ein Konto und hat jetzt Zugriff auf die {n} Einträge – eine Hinweis-Mail ist unterwegs.', who)
            : t('Einladung an {email} verschickt. Nach dem Annehmen sieht die Person als Gast nur diese {n} Einträge.', who)
          : r.existing
          ? level === 'write'
            ? t('{email} hat ein Konto und kann „{title}“ jetzt lesen und bearbeiten – eine Hinweis-Mail ist unterwegs.', who)
            : t('{email} hat ein Konto und kann „{title}“ jetzt lesen – eine Hinweis-Mail ist unterwegs.', who)
          : target === 'note'
            ? t('Einladung an {email} verschickt. Nach dem Annehmen sieht die Person als Gast nur diese Notiz.', who)
            : t('Einladung an {email} verschickt. Nach dem Annehmen sieht die Person als Gast nur „{title}“ mit allem darin.', who),
      ]);
      setEmail('');
      setName('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const mail = session.data?.mail ?? true;
  return (
    <Modal
      help="konten-einladungen-und-teilen-per-e-mail"
      open
      onOpenChange={(o) => !o && onClose()}
      title={more.length ? t('Zugriff auf {n} Einträge per E-Mail geben', { n: String(more.length + 1) }) : t('Zugriff auf „{title}“ per E-Mail geben', { title })}
    >
      <div className="space-y-3 text-sm">
        <p className="text-fg-muted">
          {fillNodes(
            t(
              'Die Person bekommt {access}. Hat sie noch kein Konto, legt sie über den Link in der Mail eines an und ist dann Gast: Sie sieht nur, was ihr ausdrücklich freigegeben ist. Wer hier schon mehr darf, behält seine Rechte.',
            ),
            {
              access: (
                <strong className="font-medium text-fg">
                  {more.length ? (level === 'write' ? t('Lese- und Schreibrecht auf diese Einträge') : t('Leserecht auf diese Einträge')) : ACCESS[target][level]}
                </strong>
              ),
            },
          )}
        </p>
        {more.length > 0 && <p className="text-xs text-fg-muted">{[title, ...more.map((m) => m.title)].map((x) => `„${x}“`).join(', ')}</p>}
        {!mail ? (
          <p className="text-warn">
            {session.data?.user?.isAdmin
              ? t('E-Mail-Versand ist nicht eingerichtet (Einstellungen → Benachrichtigungen → E-Mail).')
              : t('E-Mail-Versand ist nicht eingerichtet – bitte den Administrator fragen.')}
          </p>
        ) : (
          <form className="space-y-3" onSubmit={submit}>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label={t('E-Mail')}>
                <Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </Field>
              <Field label={t('Name (optional)')}>
                <Input maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1" role="radiogroup" aria-label={t('Recht')}>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="share-level" checked={level === 'read'} onChange={() => setLevel('read')} /> {t('lesen')}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="share-level" checked={level === 'write'} onChange={() => setLevel('write')} /> {t('lesen & schreiben')}
              </label>
            </div>
            <FormError>{error}</FormError>
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={onClose}>
                {t('Schließen')}
              </Button>
              <Button variant="primary" disabled={busy || !email.includes('@')}>
                {busy ? <Spinner /> : <Send className="h-3.5 w-3.5" />} {t('Einladen')}
              </Button>
            </div>
          </form>
        )}
        {done.map((msg) => (
          <p key={msg} className="text-ok" role="status">
            {msg}
          </p>
        ))}
      </div>
    </Modal>
  );
}

/**
 * „Teilen → Per Mail versenden …“ (owner 28.10.): the notes as .md attachments (with pictures or files as ZIP) to any
 * address – for people without an account, so no links. Answers go to the sender.
 */
export function MailNotesDialog({ mountId, notes, onClose }: { mountId: string; notes: { path: string; title: string }[]; onClose: () => void }) {
  const session = useQuery({ queryKey: ['session'], queryFn: api.session });
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addresses = to.split(/[\s,;]+/).filter(Boolean);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.mailNotes(mountId, notes.map((n) => n.path), addresses);
      toast({ kind: 'ok', title: tn(r.sent, 'An {n} Adresse verschickt', 'An {n} Adressen verschickt'), text: addresses.join(', ') });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const mail = session.data?.mail ?? true;
  const one = notes.length === 1;
  return (
    <Modal
      help="per-mail-versenden"
      open
      onOpenChange={(o) => !o && onClose()}
      title={one ? t('„{title}“ per Mail versenden', { title: notes[0]!.title }) : t('{n} Notizen per Mail versenden', { n: String(notes.length) })}
    >
      <div className="space-y-3 text-sm">
        <p className="text-fg-muted">
          {one
            ? t('Die Notiz geht als Markdown-Datei (.md) im Anhang an jede Adresse – mit Bildern oder Dateien als ZIP. Ohne Link: Die Empfänger brauchen kein Konto. Antworten gehen an dich.')
            : t('Die Notizen gehen als Markdown-Dateien (.md) im Anhang an jede Adresse – mit Bildern oder Dateien als ZIP. Ohne Link: Die Empfänger brauchen kein Konto. Antworten gehen an dich.')}
        </p>
        {!one && <p className="text-xs text-fg-muted">{notes.map((n) => `„${n.title}“`).join(', ')}</p>}
        {!mail ? (
          <p className="text-warn">
            {session.data?.user?.isAdmin
              ? t('E-Mail-Versand ist nicht eingerichtet (Einstellungen → Benachrichtigungen → E-Mail).')
              : t('E-Mail-Versand ist nicht eingerichtet – bitte den Administrator fragen.')}
          </p>
        ) : (
          <form className="space-y-3" onSubmit={submit}>
            <Field label={t('An')} hint={t('eine oder mehrere Adressen, mit Komma getrennt (höchstens 10)')}>
              <Input type="text" inputMode="email" autoFocus value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" placeholder="name@example.org" />
            </Field>
            <FormError>{error}</FormError>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('Abbrechen')}
              </Button>
              <Button variant="primary" disabled={busy || !addresses.length || !addresses.every((a) => a.includes('@'))}>
                {busy ? <Spinner /> : <Mail className="h-3.5 w-3.5" />} {t('Senden')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
