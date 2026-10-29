// Dialogs chosen from a menu open only after the menu is gone (ux.spec „dialogs from the tree menu“: „bc“ for „abc“).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { afterMenus } from './afterMenus';

function frames() {
  const queue: (() => void)[] = [];
  const timers: (() => void)[] = [];
  return {
    nextFrame: (f: () => void) => void queue.push(f),
    later: (f: () => void) => void timers.push(f),
    tick: () => queue.splice(0).forEach((f) => f()),
    pending: () => queue.length + timers.length,
    /** Runs the timers; returns how many there were. */
    runLater: () => timers.splice(0).map((f) => f()).length,
  };
}

describe('afterMenus', () => {
  it('opens at once when no menu is open', () => {
    let opened = 0;
    afterMenus(() => opened++, { menuOpen: () => false, nextFrame: () => expect.unreachable() });
    expect(opened).toBe(1);
  });

  it('waits while a menu is open, then for the focus to go back, then opens', () => {
    let menu = true;
    let opened = 0;
    const f = frames();
    afterMenus(() => opened++, { menuOpen: () => menu, nextFrame: f.nextFrame, later: f.later });
    f.tick();
    f.tick();
    expect(opened).toBe(0);
    menu = false;
    f.tick();
    // The menu is gone; Radix still gives the focus back in a timer – open after that one.
    expect(opened).toBe(0);
    expect(f.runLater()).toBe(1);
    expect(opened).toBe(1);
    expect(f.pending()).toBe(0);
  });

  it('gives up waiting after the given number of frames', () => {
    let opened = 0;
    const f = frames();
    afterMenus(() => opened++, { menuOpen: () => true, nextFrame: f.nextFrame, later: f.later, frames: 3 });
    for (let i = 0; i < 3; i++) f.tick();
    expect(opened).toBe(1);
    expect(f.pending()).toBe(0);
  });

  it('is used where tree and other menus open dialogs with input fields', () => {
    const src = (p: string) => readFileSync(resolve(import.meta.dirname, p), 'utf8');
    expect(src('shell/actions.tsx')).toMatch(/open: \(action\) => afterMenus\(/);
    expect(src('ui.tsx')).toMatch(/afterMenus\(\(\) => useInput\.setState/);
  });
});
