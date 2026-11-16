import { describe, expect, it } from 'vitest';
import { dateText, filterItems, timeText } from './SlashMenu';

const titles = (q: string) => filterItems(q).map((i) => i.title);

describe('slash commands', () => {
  it('match every word of the query: English keywords find the German heading (owner bug 25.10.)', () => {
    expect(titles('heading 2')).toEqual(['Überschrift 2']);
    expect(titles('Überschrift 2')).toEqual(['Überschrift 2']);
    expect(titles('h2')).toEqual(['Überschrift 2']);
    expect(titles('heading')).toEqual(['Überschrift 1', 'Überschrift 2', 'Überschrift 3']);
  });
  it('prose after a slash matches nothing, so the menu closes', () => {
    expect(titles('etc/hosts')).toEqual([]);
    expect(titles('heading und dann weiter')).toEqual([]);
  });
  it('/Datum, /Zeit, /Date, /Time find the date and time entries (owner 15.11.)', () => {
    expect(titles('Datum')).toEqual(['Datum', 'Datum und Uhrzeit']);
    expect(titles('Zeit')).toEqual(['Uhrzeit', 'Datum und Uhrzeit']);
    expect(titles('date')).toEqual(['Datum', 'Datum und Uhrzeit', 'Datei oder Bild']);
    expect(titles('time')).toEqual(['Uhrzeit', 'Datum und Uhrzeit']);
  });
  it('date as text: German 16.11.2026, other languages 2026-11-16; time 24 h', () => {
    const d = new Date(2026, 10, 6, 9, 5);
    expect(dateText(d, 'de')).toBe('06.11.2026');
    expect(dateText(d, 'en')).toBe('2026-11-06');
    expect(timeText(d)).toBe('09:05');
    expect(timeText(new Date(2026, 0, 1, 23, 59))).toBe('23:59');
  });
});
