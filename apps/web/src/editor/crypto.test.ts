// Encrypted notes in the browser (AD-021): what stays readable when a note is sealed, that unsealing gives the text
// back, and how attachment links are rewritten when a note is encrypted or decrypted.
import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENTS_KEY, listedAttachments, readFrontmatter, splitFrontmatter } from '@kaveyl-wiki/core';
import { Damaged, WrongPassphrase, encryptedFolderOf, openNote, sealNote, unsealNote } from './crypto';
import { replaceAttachments } from './Encryption';

const PASS = 'richtig-lange-passphrase';
const front = (raw: string) => readFrontmatter(splitFrontmatter(raw).frontmatter);

describe('sealNote / unsealNote', () => {
  const plain = '---\ntags:\n  - geheim\n---\n# Kontodaten\n\nIBAN DE00 1234 und ![Scan](assets/scan.png), [PDF](assets/vertrag.pdf), [Notiz](andere.md)\n';

  it('round-trips the text, with and without a title', async () => {
    expect(await unsealNote(PASS, await sealNote(PASS, plain))).toBe(plain);
    const titled = plain.replace('tags:', 'title: Bank\ntags:');
    expect(await unsealNote(PASS, await sealNote(PASS, titled))).toBe(titled);
  });

  it('keeps tags and the list of files readable, not the body and no title from the heading (AD-048)', async () => {
    const sealed = await sealNote(PASS, plain);
    const fm = front(sealed);
    expect(fm.encrypted).toBe('age');
    expect(fm.title).toBeUndefined();
    expect(sealed).not.toContain('Kontodaten');
    expect(fm.tags).toEqual(['geheim']);
    expect(listedAttachments(sealed)).toEqual(['assets/scan.png', 'assets/vertrag.pdf']);
    const { body } = splitFrontmatter(sealed);
    expect(body).toContain('-----BEGIN AGE ENCRYPTED FILE-----');
    for (const secret of ['IBAN', 'DE00', 'Kontodaten\n', 'scan.png)']) expect(body).not.toContain(secret);
  });

  it('keeps a title that is set and lists no files when there are none', async () => {
    const sealed = await sealNote(PASS, '---\ntitle: Eigener Titel\n---\n# Überschrift\n\nText\n');
    expect(front(sealed).title).toBe('Eigener Titel');
    expect(front(sealed)[ATTACHMENTS_KEY]).toBeUndefined();
  });

  it('removes a title taken over from the heading by earlier versions when unsealing, keeps a different one (AD-048)', async () => {
    const sealed = await sealNote(PASS, plain);
    const old = sealed.replace('encrypted: age', 'title: Kontodaten\nencrypted: age');
    expect(front(old).title).toBe('Kontodaten');
    expect(await unsealNote(PASS, old)).toBe(plain);
    const own = sealed.replace('encrypted: age', 'title: Bank\nencrypted: age');
    expect(front(await unsealNote(PASS, own)).title).toBe('Bank');
  });

  it('removes the marker and the file list when unsealing', async () => {
    const back = await unsealNote(PASS, await sealNote(PASS, '# Nur Text\n\n![Bild](assets/a.png)\n'));
    expect(front(back).encrypted).toBeUndefined();
    expect(front(back)[ATTACHMENTS_KEY]).toBeUndefined();
    expect(splitFrontmatter(back).body).toContain('# Nur Text\n\n![Bild](assets/a.png)');
  });

  it('tells a wrong passphrase from a damaged file', async () => {
    const sealed = await sealNote(PASS, '# A\n\nText\n');
    await expect(unsealNote('falsch', sealed)).rejects.toBeInstanceOf(WrongPassphrase);
    const cut = sealed.replace(/-----END AGE ENCRYPTED FILE-----\s*$/, '');
    await expect(openNote(PASS, cut.slice(0, cut.length - 40))).rejects.toBeInstanceOf(Damaged);
  });

  it('opens a note with an empty body without a passphrase check', async () => {
    expect(await openNote('egal', '---\nencrypted: age\n---\n')).toEqual({ frontmatter: '---\nencrypted: age\n---\n', body: '' });
  });
});

describe('encryptedFolderOf', () => {
  it('finds the closest encrypted folder; the source root never counts (only folders can be encrypted, like the server)', () => {
    const folders = ['', 'privat', 'privat/konten'];
    expect(encryptedFolderOf(folders, 'privat/konten/bank.md')).toBe('privat/konten');
    expect(encryptedFolderOf(folders, 'privat/notiz.md')).toBe('privat');
    expect(encryptedFolderOf(folders, 'privat')).toBe('privat');
    expect(encryptedFolderOf(folders, 'privatsache.md')).toBeNull();
    expect(encryptedFolderOf(folders, 'offen.md')).toBeNull();
    expect(encryptedFolderOf([''], 'ordner/notiz.md')).toBeNull();
  });
});

describe('replaceAttachments', () => {
  const toAge = (path: string) => Promise.resolve(path.endsWith('.age') ? null : `assets/${path.split('/').pop()}.age`);

  it('converts each file once and rewrites every link to it', async () => {
    const convert = vi.fn(toAge);
    const raw = '![A](assets/a.png) Text ![A noch mal](assets/a.png)\n\n[B](assets/b.pdf)\n';
    const r = await replaceAttachments(raw, 'n.md', convert);
    expect(r.raw).toBe('![A](assets/a.png.age) Text ![A noch mal](assets/a.png.age)\n\n[B](assets/b.pdf.age)\n');
    expect(convert.mock.calls.map((c) => c[0]).sort()).toEqual(['assets/a.png', 'assets/b.pdf']);
    expect(r.replaced.sort()).toEqual(['assets/a.png', 'assets/b.pdf']);
  });

  it('rewrites <img src> and keeps the angle brackets of a link in <…>', async () => {
    const raw = '<img src="assets/a.png" width="200">\n\n[Datei](<assets/mein vertrag.pdf>)\n';
    const r = await replaceAttachments(raw, 'n.md', toAge);
    expect(r.raw).toBe('<img src="assets/a.png.age" width="200">\n\n[Datei](<assets/mein vertrag.pdf.age>)\n');
  });

  it('resolves links relative to the note', async () => {
    const convert = vi.fn(toAge);
    await replaceAttachments('![A](assets/a.png) ![B](../assets/b.png)', 'ordner/unter/n.md', convert);
    expect(convert.mock.calls.map((c) => c[0]).sort()).toEqual(['ordner/assets/b.png', 'ordner/unter/assets/a.png']);
  });

  it('leaves notes, web addresses, anchors, data URLs and files outside assets/ alone', async () => {
    const convert = vi.fn(toAge);
    const raw = '[N](andere.md) [W](https://example.org/assets/x.png) [S](#abschnitt) ![D](data:image/png;base64,AAAA) [F](dateien/x.pdf)\n';
    const r = await replaceAttachments(raw, 'n.md', convert);
    expect(r).toEqual({ raw, replaced: [] });
    expect(convert).not.toHaveBeenCalled();
  });

  it('keeps a link when convert returns null and does not count it as replaced', async () => {
    const raw = '![A](assets/a.png.age) ![B](assets/b.png)';
    const r = await replaceAttachments(raw, 'n.md', toAge);
    expect(r).toEqual({ raw: '![A](assets/a.png.age) ![B](assets/b.png.age)', replaced: ['assets/b.png'] });
  });
});
