import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { editorExtensions, shouldAutoLink } from './schema.js';

type A11y = { checkboxLabel?: (node: PMNode, checked: boolean) => string } | undefined;
const labelOf = (opts: Parameters<typeof editorExtensions>[0], text: string) => {
  const task = editorExtensions(opts).find((e) => e.name === 'taskItem');
  const a11y = (task?.options as { a11y?: A11y } | undefined)?.a11y;
  return a11y?.checkboxLabel?.({ textContent: text } as PMNode, false);
};

describe('task list checkboxes', () => {
  it('take their screen reader name from the app (its language), with the task text', () => {
    expect(labelOf({ taskCheckboxLabel: (text) => `Aufgabe: ${text}` }, 'Brot backen')).toBe('Aufgabe: Brot backen');
  });
});

describe('automatic links', () => {
  it('note and file names stay text, web addresses become links', () => {
    for (const name of ['Unterhaltung.md', 'notes.zip', 'Plan.MD', 'run.sh', 'Rezepte/Strudel.md']) expect(shouldAutoLink(name), name).toBe(false);
    for (const url of ['example.com', 'www.kaveyl.app', 'https://example.md', 'http://notes.zip', 'me@kaveyl.app', 'mailto:me@kaveyl.app', 'www.example.md']) expect(shouldAutoLink(url), url).toBe(true);
  });
});
