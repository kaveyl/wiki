// Checking a folder passphrase (code-001): when the notes to check it against cannot be loaded, the passphrase is
// not accepted as "nothing to check" – a typo would otherwise seal the rest of the folder.
import { describe, expect, it, vi } from 'vitest';
import { sealNote } from './crypto';

const api = vi.hoisted(() => ({ encryptedNotes: vi.fn(), note: vi.fn() }));
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), api }));

import { ApiError } from '../api';
import { checkFolderPassphrase } from './Encryption';

const PASS = 'richtig-lange-passphrase';

describe('checkFolderPassphrase', () => {
  it('fails instead of accepting the passphrase when the notes cannot be loaded', async () => {
    api.encryptedNotes.mockResolvedValue([{ path: 'Tresor/a.md', encrypted: true, empty: false }]);
    api.note.mockRejectedValue(new ApiError(503, 'Server nicht erreichbar', {}));
    await expect(checkFolderPassphrase('m', 'Tresor', 'vertippt')).rejects.toThrow(/ließ sich nicht prüfen – Server nicht erreichbar/);
  });

  it('still tells a right from a wrong passphrase', async () => {
    const raw = await sealNote(PASS, '# Geheim\n\nText\n');
    api.encryptedNotes.mockResolvedValue([{ path: 'Tresor/a.md', encrypted: true, empty: false }]);
    api.note.mockResolvedValue({ raw });
    expect(await checkFolderPassphrase('m', 'Tresor', PASS)).toBe(true);
    expect(await checkFolderPassphrase('m', 'Tresor', 'vertippt')).toBe(false);
  });
});
