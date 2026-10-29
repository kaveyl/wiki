// The passphrase dialog of encrypted notes and folders (AD-021), imperative: `await askPassphrase(...)`. Its own
// module so the shell can host it without loading the encryption code (that comes with the first use).
import { useEffect, useId, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Button, Field, Input, MissingHint, Modal, useRepeatCheck } from '../ui';
import { t } from '../i18n';

interface Ask {
  title: string;
  text: ReactNode;
  confirm: boolean;
  resolve: (p: string | null) => void;
}
const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

export function askPassphrase(title: string, text: ReactNode, confirm: boolean): Promise<string | null> {
  return new Promise((resolve) => useAsk.setState({ ask: { title, text, confirm, resolve } }));
}

export function PassphraseHost() {
  const ask = useAsk((s) => s.ask);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const missingId = useId();
  const repeat = useRepeatCheck(a, b);
  useEffect(() => {
    setA('');
    setB('');
  }, [ask]);
  if (!ask) return null;
  const done = (p: string | null) => {
    useAsk.setState({ ask: null });
    ask.resolve(p);
  };
  const missing = [a.length < (ask.confirm ? 8 : 1) && t('Passphrase'), ask.confirm && a !== b && t('Passphrase wiederholen')].filter((x): x is string => !!x);
  const ok = missing.length === 0;
  return (
    <Modal help="verschlüsselte-notizen-und-ordner" open onOpenChange={(o) => !o && done(null)} title={ask.title}>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) done(a);
        }}
      >
        <div className="text-fg-muted">{ask.text}</div>
        <Field label={t('Passphrase')}>
          <Input type="password" autoFocus value={a} onChange={(e) => setA(e.target.value)} aria-label={t('Passphrase')} placeholder={t('Passphrase')} autoComplete="new-password" />
        </Field>
        {ask.confirm && (
          <Field label={t('Passphrase wiederholen')} error={repeat.error}>
            <Input type="password" value={b} onChange={(e) => setB(e.target.value)} onBlur={repeat.onBlur} aria-label={t('Passphrase wiederholen')} placeholder={t('Wiederholen')} autoComplete="new-password" />
          </Field>
        )}
        {ask.confirm && a.length > 0 && a.length < 8 && <p className="text-xs text-warn">{t('Mindestens 8 Zeichen.')}</p>}
        <div className="flex items-center justify-end gap-2">
          {/* Not a silent grey button: say what is missing. */}
          <MissingHint id={missingId} items={missing} className="mr-auto" />
          <Button type="button" variant="ghost" onClick={() => done(null)}>
            {t('Abbrechen')}
          </Button>
          <Button type="submit" variant="primary" disabled={!ok} aria-describedby={ok ? undefined : missingId}>
            {t('OK')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
