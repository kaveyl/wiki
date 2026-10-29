// Settings → Darstellung → Schriftgröße: four sliders (interface, sidebar, note, code). Every change
// applies at once to the whole app (CSS variables, prefs.ts) – the app around the dialog is the preview.
import { FileText, Folder } from 'lucide-react';
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, usePrefs, type FontScale } from '../prefs';
import { Button, fillNodes } from '../ui';
import { t } from '../i18n';

const ROWS: { key: keyof FontScale; label: string; hint: string }[] = [
  { key: 'ui', label: t('Oberfläche'), hint: t('Menüs, Knöpfe, Dialoge, Tabs – alles rund um die Notiz (auch die Seitenleiste)') },
  { key: 'tree', label: t('Seitenleiste'), hint: t('Baum, Favoriten, Zuletzt und KI-Freigaben – zusätzlich zur Oberfläche') },
  { key: 'doc', label: t('Notiztext'), hint: t('der Text in Notizen, in der Leseansicht und in der Hilfe') },
  { key: 'mono', label: t('Code'), hint: t('Codeblöcke, `Code` im Text und die Ansicht „Markdown“') },
];

function Sample({ k }: { k: keyof FontScale }) {
  if (k === 'tree')
    return (
      <div className="space-y-0.5 text-fg-muted">
        <div className="flex min-h-7 items-center gap-1.5 text-tree">
          <Folder className="h-4 w-4 shrink-0" /> {t('Projekte')}
        </div>
        <div className="flex min-h-7 items-center gap-1.5 pl-5 text-tree">
          <FileText className="h-4 w-4 shrink-0" /> {t('Besprechung Montag')}
        </div>
      </div>
    );
  if (k === 'doc')
    return (
      <div className="prose-note">
        <p className="!my-0">
          {fillNodes(t('So sieht der Text in einer Notiz aus, mit {fett} und {kursiv} Stellen.'), {
            fett: <strong>{t('fetten')}</strong>,
            kursiv: <em>{t('kursiven')}</em>,
          })}
        </p>
      </div>
    );
  if (k === 'mono')
    return (
      <pre className="!my-0 rounded-md border border-line bg-subtle px-3 py-2 font-mono text-code">{t('const gruss = "Hallo";')}</pre>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
      <span>{t('Menüeintrag')}</span>
      <Button size="sm">{t('Knopf')}</Button>
      <span className="text-xs text-fg-muted">{t('kleiner Hinweis')}</span>
    </div>
  );
}

export function FontSizesPanel() {
  const { fontScale, set } = usePrefs();
  const change = (k: keyof FontScale, v: number) => set({ fontScale: { ...fontScale, [k]: v } });
  const changed = (Object.keys(FONT_DEFAULT) as (keyof FontScale)[]).some((k) => fontScale[k] !== FONT_DEFAULT[k]);
  return (
    <div className="space-y-5 text-sm">
      <p className="text-fg-muted">
        {t('Jede Änderung wirkt sofort in ganz Kaveyl Wiki – auch hinter diesem Fenster. Gespeichert wird für dein Konto, also auf jedem Gerät gleich.')}
      </p>
      {ROWS.map(({ key, label, hint }) => (
        <section key={key} aria-label={label} className="space-y-2 rounded-lg border border-line p-3">
          <div className="flex items-center gap-3">
            <label htmlFor={`fs-${key}`} className="w-28 shrink-0 font-medium">
              {label}
            </label>
            <input
              id={`fs-${key}`}
              type="range"
              min={FONT_MIN}
              max={FONT_MAX}
              step={5}
              value={fontScale[key]}
              aria-label={t('Schriftgröße {label}', { label })}
              aria-valuetext={`${fontScale[key]} %`}
              className="min-w-0 flex-1 accent-[var(--accent)]"
              onChange={(e) => change(key, Number(e.target.value))}
            />
            <span className="w-12 shrink-0 text-right tabular-nums text-fg-muted">{fontScale[key]} %</span>
          </div>
          <p className="text-xs text-fg-faint">{hint}</p>
          <Sample k={key} />
        </section>
      ))}
      <Button size="sm" disabled={!changed} onClick={() => set({ fontScale: FONT_DEFAULT })}>
        {t('Alle auf 100 % zurücksetzen')}
      </Button>
    </div>
  );
}
