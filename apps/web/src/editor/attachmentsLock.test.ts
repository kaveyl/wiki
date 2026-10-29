// Locked while a dropped file is still being prepared (checklist 105): the file never goes to the server in plain –
// locking unmarks the note, so the decision is taken before anything is awaited.
import { describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import type { QueryClient } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  uploaded: [] as string[],
  toasts: [] as { kind: string; text?: string }[],
  meanwhile: () => {},
}));
vi.mock('../api', () => ({
  api: {
    attachmentLimits: async () => ({ imageMaxPx: 2400 }),
    upload: async (_mountId: string, _path: string, file: File) => {
      mocks.uploaded.push(file.name);
      return { name: file.name, href: `assets/${file.name}`, image: false };
    },
  },
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../toast', () => ({ toast: (t: { kind: string; text?: string }) => mocks.toasts.push(t) }));
vi.mock('./images', () => ({
  shrinkImage: async (file: File) => {
    mocks.meanwhile();
    return { file, info: null };
  },
}));

import { uploadFiles } from './Attachments';
import { lockAll, markSealed, remember } from './crypto';

const qc = { fetchQuery: async ({ queryFn }: { queryFn: () => unknown }) => queryFn(), invalidateQueries: async () => {} } as unknown as QueryClient;
const editor = {} as Editor;
const mount = { id: 'm1' } as Parameters<typeof uploadFiles>[2];

describe('uploadFiles into an encrypted note', () => {
  it('locked meanwhile: nothing is uploaded, the note says why', async () => {
    remember('m1', 'tresor/geheim.md', 'eine lange Passphrase');
    markSealed('m1', 'tresor/geheim.md', true);
    // What locking does: passphrases forgotten, the open note no longer marked as sealed.
    mocks.meanwhile = () => {
      lockAll();
      markSealed('m1', 'tresor/geheim.md', false);
    };
    await uploadFiles(editor, qc, mount, 'tresor/geheim.md', [new File(['geheim'], 'race.webp', { type: 'image/webp' })]);
    expect(mocks.uploaded).toEqual([]);
    expect(mocks.toasts).toMatchObject([{ kind: 'error', text: 'Die Notiz wurde gesperrt – entsperren und die Datei erneut hinzufügen.' }]);
  });
});
