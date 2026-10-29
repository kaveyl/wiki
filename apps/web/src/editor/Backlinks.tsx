// "Verlinkt von": notes in the same mount that link to this one (from the server's link
// index). Shown below the note, Outline-style. SEE-DOC: docs/PLAN.md §2.5
import { useQuery } from '@tanstack/react-query';
import { FileText, Link2 } from 'lucide-react';
import { api, type Mount } from '../api';
import { useWorkspace } from '../store';
import { noteName } from '../names';
import { t } from '../i18n';

export function Backlinks({ mount, path }: { mount: Mount; path: string }) {
  const openNote = useWorkspace((s) => s.openNote);
  const links = useQuery({ queryKey: ['backlinks', mount.id, path], queryFn: () => api.backlinks(mount.id, path) });
  if (!links.data?.length) return null;
  return (
    <section className="mt-12 border-t border-line pt-4" aria-label={t('Verlinkt von')} data-print="hide">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        <Link2 className="h-3.5 w-3.5" /> {t('Verlinkt von ({n})', { n: links.data.length })}
      </h2>
      <ul className="space-y-0.5">
        {links.data.map((b) => (
          <li key={b.path}>
            <button className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-hover" onClick={() => openNote(mount.id, b.path, b.title)} title={b.path}>
              <FileText className="h-4 w-4 shrink-0 text-fg-faint" />
              <span className="truncate">{noteName(b.path, mount.options.folderNote)}</span>
              {b.count > 1 && <span className="text-xs text-fg-faint">{b.count}×</span>}
              <span className="ml-auto truncate text-xs text-fg-faint">{b.path}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
