// Minimal toast notifications (sync errors, conflicts, recovery).
import { create } from 'zustand';
import { X, AlertTriangle, CheckCircle2, AlertOctagon } from 'lucide-react';
import { t } from './i18n';
import { Button, cx } from './ui';

interface Toast {
  id: number;
  kind: 'error' | 'warn' | 'ok';
  title: string;
  text?: string;
  /** One button in the toast (e.g. „Wiederherstellen“); it closes the toast. */
  action?: { label: string; run: () => void };
}

const useToasts = create<{ items: Toast[] }>(() => ({ items: [] }));
let nextId = 1;

export function toast(msg: Omit<Toast, 'id'>) {
  const id = nextId++;
  useToasts.setState((s) => ({ items: [...s.items.slice(-3), { ...msg, id }] }));
  // With a button it stays longer: time to reach it by keyboard.
  if (msg.kind === 'ok') setTimeout(() => dismiss(id), msg.action ? 10_000 : 4000);
}

function dismiss(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
}

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2" role="status" aria-live="polite" data-print="hide" data-toaster="">
      {items.map((item) => (
        <div key={item.id} className="pointer-events-auto flex gap-2.5 rounded-lg border border-line bg-bg p-3 text-sm shadow-pop">
          {item.kind === 'error' ? (
            <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          ) : item.kind === 'warn' ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
          )}
          <div className="min-w-0 flex-1">
            <div className={cx('font-medium', item.kind === 'error' && 'text-danger')}>{item.title}</div>
            {item.text && <div className="mt-0.5 break-words text-xs text-fg-muted">{item.text}</div>}
            {item.action && (
              <Button
                size="sm"
                className="mt-2"
                onClick={() => {
                  dismiss(item.id);
                  item.action!.run();
                }}
              >
                {item.action.label}
              </Button>
            )}
          </div>
          <button className="h-5 w-5 shrink-0 text-fg-faint hover:text-fg" onClick={() => dismiss(item.id)} aria-label={t('Schließen')}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
