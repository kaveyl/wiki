// Parts of the app that load later or fail while rendering – one way for all of them (code-004): instead of a blank
// page they show a message with „Neu laden“, and notes not saved yet can be copied out first.
import { Component, lazy, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { Button } from './ui';
import { copyText } from './clipboard';
import { t, tn } from './i18n';
import { formatUnsaved, unsavedSnapshot, type UnsavedNote } from './unsaved';

/**
 * A component loaded on first use. When it cannot be loaded (a tab opened before an update asks for files the new
 * build no longer has, a moment without network) `Fallback` shows instead – the standard message unless given.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, Fallback: ComponentType<P> = PartUnavailable): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => load().then((C) => ({ default: C }), () => ({ default: Fallback })));
}

/** The standard message for a part that could not be loaded. */
export function PartUnavailable() {
  return <PartFailed text={t('Dieser Teil der App konnte nicht geladen werden. Bitte die Seite neu laden.')} />;
}

interface BoundaryState {
  failed: boolean;
  unsaved: UnsavedNote[];
}

/**
 * Catches what its part throws while rendering, so the rest of the app stays. `note` (`mountId:path`): the part is
 * that note's tab – only its own unsaved text is offered; without it all of them (the whole app failed).
 */
export class PartBoundary extends Component<{ note?: string; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false, unsaved: [] };

  static getDerivedStateFromError(): BoundaryState {
    // Read now: the failed part is still mounted – once it unmounts, its editors forget what they held.
    return { failed: true, unsaved: unsavedSnapshot() };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { note } = this.props;
    return (
      <PartFailed
        text={t('Dieser Teil der App konnte nicht angezeigt werden. Bitte die Seite neu laden.')}
        unsaved={note ? this.state.unsaved.filter((u) => u.note === note) : this.state.unsaved}
      />
    );
  }
}

function PartFailed({ text, unsaved = [] }: { text: string; unsaved?: UnsavedNote[] }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const count = new Set(unsaved.map((u) => u.note)).size;
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-sm text-fg-muted">
      <p>{text}</p>
      {count > 0 && (
        <p>
          {tn(
            count,
            '{n} Notiz war noch nicht gespeichert. Kopiere sie vor dem Neuladen heraus.',
            '{n} Notizen waren noch nicht gespeichert. Kopiere sie vor dem Neuladen heraus.',
          )}
        </p>
      )}
      {copied !== null && <p>{copied ? tn(count, '{n} Notiz in die Zwischenablage kopiert', '{n} Notizen in die Zwischenablage kopiert') : t('Nicht kopiert')}</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {count > 0 && (
          <Button size="sm" variant="primary" onClick={() => void copyText(formatUnsaved(unsaved)).then(setCopied)}>
            {t('Inhalte kopieren')}
          </Button>
        )}
        <Button size="sm" variant={count > 0 ? 'default' : 'primary'} onClick={() => location.reload()}>
          {t('Neu laden')}
        </Button>
      </div>
    </div>
  );
}
