import { describe, expect, it } from 'vitest';
import { loadMarkdown, saveMarkdown } from './document.js';
import type { PMNode } from './from-mdast.js';
import { dayOf, dueAt, formatDue, nextDue, readDue, stepDate, writeDue, type TaskDue } from './tasks.js';

const due = (date: string, time: string | null = null, repeat: TaskDue['repeat'] = null): TaskDue => ({ date, time, repeat });

describe('readDue', () => {
  it('reads date, time and repeat at the end of an item', () => {
    expect(readDue('Steuer abgeben @2026-11-10 20:00 +1w')).toEqual({
      text: 'Steuer abgeben',
      due: due('2026-11-10', '20:00', { every: 1, unit: 'w' }),
      tail: ' @2026-11-10 20:00 +1w',
    });
    expect(readDue('Arzt @2026-02-28').due).toEqual(due('2026-02-28'));
    expect(readDue('Gießen @2026-11-03 +2d').due).toEqual(due('2026-11-03', null, { every: 2, unit: 'd' }));
    expect(readDue('Miete @2026-12-01 08:05 +12m').due).toEqual(due('2026-12-01', '08:05', { every: 12, unit: 'm' }));
    expect(readDue('@2026-11-10').due).toEqual(due('2026-11-10'));
  });

  it('keeps the text before the date and the date as written: text + tail is the item', () => {
    for (const item of ['A  @2026-11-10', 'B\t@2026-11-10 09:00  ', '@2026-11-10 +1y', 'Mail an a@b.de @2026-11-10']) {
      const r = readDue(item);
      expect(r.due).not.toBeNull();
      expect(r.text + r.tail).toBe(item);
    }
    expect(readDue('Mail an a@b.de @2026-11-10').text).toBe('Mail an a@b.de');
  });

  it('spaces and tabs after the date belong to the tail; many of them before more text cost nothing (CodeQL 0.2.14)', () => {
    const r = readDue('Treffen @2026-11-10 \t ');
    expect(r).toMatchObject({ text: 'Treffen', due: { date: '2026-11-10' }, tail: ' @2026-11-10 \t ' });
    const long = `x @2026-11-10${'\t'.repeat(200_000)}y`;
    const t0 = performance.now();
    expect(readDue(long).due).toBeNull();
    expect(writeDue(`x${'\t'.repeat(200_000)}y`, null)).toHaveLength(200_002);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('leaves broken or unknown notation as text', () => {
    for (const item of [
      'Nur Text',
      'Treffen @2026-02-30',
      'Treffen @2026-13-01',
      'Treffen @2026-00-15',
      'Treffen @0024-01-31',
      'Treffen @2026-11-00',
      'Treffen @2026-11-10 24:00',
      'Treffen @2026-11-10 9:00',
      'Treffen @2026-11-10 +0d',
      'Treffen @2026-11-10 +1x',
      'Treffen @2026-11-10 danach',
      'Treffen @2026-11-10 +1w 20:00',
      'name@2026-11-10',
      'Treffen @26-11-10',
      'Treffen @2026-11-10 +1000d',
    ])
      expect(readDue(item)).toEqual({ text: item, due: null, tail: '' });
    expect(readDue('Schaltjahr @2028-02-29').due?.date).toBe('2028-02-29');
  });

  it('stays fast on long and odd text', () => {
    const long = `${' '.repeat(50_000)}@${'1'.repeat(50_000)}`;
    const start = performance.now();
    expect(readDue(long).due).toBeNull();
    expect(readDue(`x${' @2026-11-10'.repeat(5_000)}`).due).toEqual(due('2026-11-10'));
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('formatDue and writeDue', () => {
  it('writes the notation', () => {
    expect(formatDue(due('2026-11-10'))).toBe('@2026-11-10');
    expect(formatDue(due('2026-11-10', '20:00'))).toBe('@2026-11-10 20:00');
    expect(formatDue(due('2026-11-10', null, { every: 1, unit: 'w' }))).toBe('@2026-11-10 +1w');
    expect(formatDue(due('2026-11-10', '07:30', { every: 2, unit: 'w' }))).toBe('@2026-11-10 07:30 +2w');
  });

  it('sets, replaces and removes the date; the text before stays', () => {
    expect(writeDue('Steuer abgeben', due('2026-11-10', '20:00', { every: 1, unit: 'w' }))).toBe('Steuer abgeben @2026-11-10 20:00 +1w');
    expect(writeDue('Steuer abgeben  ', due('2026-11-10'))).toBe('Steuer abgeben @2026-11-10');
    expect(writeDue('Steuer abgeben @2026-11-10 20:00 +1w', due('2026-11-17', '20:00', { every: 1, unit: 'w' }))).toBe('Steuer abgeben @2026-11-17 20:00 +1w');
    expect(writeDue('Steuer abgeben @2026-11-10', null)).toBe('Steuer abgeben');
    expect(writeDue('', due('2026-11-10'))).toBe('@2026-11-10');
    // Broken notation is text: a new date goes after it.
    expect(writeDue('Treffen @2026-02-30', due('2026-03-01'))).toBe('Treffen @2026-02-30 @2026-03-01');
  });

  it('reads back what it writes', () => {
    const d = due('2027-01-31', '23:59', { every: 3, unit: 'm' });
    expect(readDue(writeDue('X', d))).toEqual({ text: 'X', due: d, tail: ' @2027-01-31 23:59 +3m' });
  });
});

describe('dates', () => {
  it('dueAt: the local moment, a date alone at the fallback time', () => {
    expect(dueAt(due('2026-11-10', '20:00'))).toEqual(new Date(2026, 10, 10, 20, 0));
    expect(dueAt(due('2026-11-10'))).toEqual(new Date(2026, 10, 10, 0, 0));
    expect(dueAt(due('2026-11-10'), '09:00')).toEqual(new Date(2026, 10, 10, 9, 0));
    expect(dayOf(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('stepDate: days, weeks, months and years; month ends clamp', () => {
    expect(stepDate('2026-12-30', { every: 3, unit: 'd' }, 1)).toBe('2027-01-02');
    expect(stepDate('2026-11-10', { every: 2, unit: 'w' }, 2)).toBe('2026-12-08');
    expect(stepDate('2026-01-31', { every: 1, unit: 'm' }, 1)).toBe('2026-02-28');
    expect(stepDate('2026-01-31', { every: 1, unit: 'm' }, 2)).toBe('2026-03-31');
    expect(stepDate('2028-01-31', { every: 1, unit: 'm' }, 1)).toBe('2028-02-29');
    expect(stepDate('2026-11-30', { every: 3, unit: 'm' }, 1)).toBe('2027-02-28');
    expect(stepDate('2028-02-29', { every: 1, unit: 'y' }, 1)).toBe('2029-02-28');
    expect(stepDate('2028-02-29', { every: 1, unit: 'y' }, 4)).toBe('2032-02-29');
  });

  it('stepDate keeps the day across a change of summer time', () => {
    expect(stepDate('2026-03-28', { every: 1, unit: 'd' }, 1)).toBe('2026-03-29');
    expect(stepDate('2026-10-24', { every: 1, unit: 'w' }, 1)).toBe('2026-10-31');
  });
});

describe('nextDue', () => {
  const now = new Date(2026, 10, 3, 21, 30); // Tue 3 Nov 2026, 21:30

  it('without a repeat the date stays', () => {
    expect(nextDue(due('2026-11-01'), now)).toEqual(due('2026-11-01'));
  });

  it('steps from the old date until after now, the weekday kept', () => {
    // Weekly on Tuesday at 20:00, last due a month ago: next Tuesday (today's 20:00 has passed).
    expect(nextDue(due('2026-10-06', '20:00', { every: 1, unit: 'w' }), now).date).toBe('2026-11-10');
    // Today at 22:00 is still ahead – but done now, so one step on.
    expect(nextDue(due('2026-11-03', '22:00', { every: 1, unit: 'w' }), now).date).toBe('2026-11-10');
    // Every two weeks from 13 Oct: 27 Oct, 10 Nov.
    expect(nextDue(due('2026-10-13', null, { every: 2, unit: 'w' }), now).date).toBe('2026-11-10');
  });

  it('a date without a time is due all day: the next one is after today', () => {
    expect(nextDue(due('2026-11-03', null, { every: 1, unit: 'd' }), now).date).toBe('2026-11-04');
    expect(nextDue(due('2026-11-01', null, { every: 1, unit: 'd' }), now).date).toBe('2026-11-04');
    expect(nextDue(due('2026-11-02', '20:00', { every: 1, unit: 'd' }), now).date).toBe('2026-11-04');
    expect(nextDue(due('2026-11-02', '22:00', { every: 1, unit: 'd' }), now).date).toBe('2026-11-03');
  });

  it('done early: one step on', () => {
    expect(nextDue(due('2026-12-24', null, { every: 1, unit: 'y' }), now).date).toBe('2027-12-24');
  });

  it('months and years from the old date, month ends clamped', () => {
    expect(nextDue(due('2026-08-31', null, { every: 1, unit: 'm' }), now).date).toBe('2026-11-30');
    expect(nextDue(due('2024-02-29', null, { every: 1, unit: 'y' }), now).date).toBe('2027-02-28');
  });

  it('dates long past, quickly and never past the answer', () => {
    expect(nextDue(due('2016-11-04', null, { every: 1, unit: 'd' }), now).date).toBe('2026-11-04');
    expect(nextDue(due('2016-11-30', null, { every: 1, unit: 'm' }), now).date).toBe('2026-11-30');
    expect(nextDue(due('1990-11-05', null, { every: 1, unit: 'y' }), now).date).toBe('2026-11-05');
    expect(nextDue(due('2016-11-01', '08:00', { every: 1, unit: 'w' }), now).date).toBe('2026-11-10');
  });

  it('keeps the time and the repeat', () => {
    const d = nextDue(due('2026-11-03', '20:00', { every: 1, unit: 'w' }), now);
    expect(d).toEqual(due('2026-11-10', '20:00', { every: 1, unit: 'w' }));
  });
});

describe('in a Markdown file', () => {
  const MD = '- [ ] Steuer abgeben @2026-11-10 20:00 +1w\n- [x] Blumen gießen @2026-11-03 +2d\n';
  const items = (doc: PMNode) => doc.content![0]!.content!;
  const textOf = (item: PMNode) => item.content![0]!.content!.map((n) => n.text).join('');

  it('loads and saves byte for byte', () => {
    const { doc, source } = loadMarkdown(MD);
    expect(items(doc).map(textOf)).toEqual(['Steuer abgeben @2026-11-10 20:00 +1w', 'Blumen gießen @2026-11-03 +2d']);
    expect(saveMarkdown(source, doc)).toBe(MD);
  });

  it('an edited item and a new date are written without escapes', () => {
    const { doc, source } = loadMarkdown(MD);
    const first = items(doc)[0]!.content![0]!;
    first.content = [{ type: 'text', text: writeDue('Steuer abgeben', due('2026-11-17', '20:00', { every: 1, unit: 'w' })) }];
    items(doc)[1]!.attrs = { ...items(doc)[1]!.attrs, checked: false };
    expect(saveMarkdown(source, doc)).toBe('- [ ] Steuer abgeben @2026-11-17 20:00 +1w\n- [ ] Blumen gießen @2026-11-03 +2d\n');
  });
});
