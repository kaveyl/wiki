// The date of a task: a checklist item becomes a task when its text ends with `@YYYY-MM-DD`, optionally followed by
// ` HH:MM` (24 h, local time of the device) and a repeat ` +<n>d|w|m|y` – `- [ ] Steuer abgeben @2026-11-10 20:00 +1w`.
// Shared with Kaveyl Notes (its AD-019): plain text for the wiki, read and written only here. Anything that does not
// match exactly – an impossible date, a time like 24:00, `+0d`, more after it – stays text and is never rewritten.

export type RepeatUnit = 'd' | 'w' | 'm' | 'y';

export interface TaskRepeat {
  /** How many units between two dates, at least 1. */
  every: number;
  unit: RepeatUnit;
}

export interface TaskDue {
  /** `YYYY-MM-DD`, a real calendar day. */
  date: string;
  /** `HH:MM` (00:00–23:59), or null for a date without a time. */
  time: string | null;
  repeat: TaskRepeat | null;
}

export interface TaskText {
  /** The text before the date (without the space in front of `@`). */
  text: string;
  due: TaskDue | null;
  /** The date as written, with the space in front of it: `text + tail` is the item text, byte for byte. */
  tail: string;
}

// Tried only on the text from the last `@` on, without trailing spaces and tabs (cut off before, not matched – CodeQL
// 0.2.14), anchored at both ends: one pass, nothing to backtrack over.
const DUE = /^@(\d{4})-(\d{2})-(\d{2})(?: ([01]\d|2[0-3]):([0-5]\d))?(?: \+([1-9]\d{0,2})([dwmy]))?$/;
const NONE = (itemText: string): TaskText => ({ text: itemText, due: null, tail: '' });

/** Where `s` ends without its trailing spaces and tabs (not before `from`) – a loop, not a regex: `[ \t]+$` is quadratic. */
function trimmedEnd(s: string, from: number): number {
  let end = s.length;
  while (end > from && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return end;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const daysIn = (year: number, month: number) => new Date(year, month + 1, 0).getDate();

/** The date at the end of an item's text, or none – then `text` is the whole text and `tail` is empty. */
export function readDue(itemText: string): TaskText {
  const at = itemText.lastIndexOf('@');
  // The date stands alone: at the start or after a space (`name@2026-11-10` is no date).
  if (at < 0 || (at > 0 && !/[ \t]/.test(itemText[at - 1]!))) return NONE(itemText);
  const m = DUE.exec(itemText.slice(at, trimmedEnd(itemText, at)));
  if (!m) return NONE(itemText);
  const [, y, mo, d, h, mi, every, unit] = m;
  const year = Number(y);
  const month = Number(mo) - 1;
  // Month 00 and the years 0000–0999 stay text (`new Date` would read 0–99 as 1900–1999 – diff check 0.2.14).
  if (year < 1000 || month < 0 || month > 11 || Number(d) < 1 || Number(d) > daysIn(year, month)) return NONE(itemText);
  let start = at;
  while (start > 0 && /[ \t]/.test(itemText[start - 1]!)) start--;
  return {
    text: itemText.slice(0, start),
    due: { date: `${y}-${mo}-${d}`, time: h === undefined ? null : `${h}:${mi}`, repeat: every === undefined ? null : { every: Number(every), unit: unit as RepeatUnit } },
    tail: itemText.slice(start),
  };
}

/** The notation of a date: `@2026-11-10`, `@2026-11-10 20:00`, `@2026-11-10 +1w`, `@2026-11-10 20:00 +2w`. */
export function formatDue(due: TaskDue): string {
  return `@${due.date}${due.time ? ` ${due.time}` : ''}${due.repeat ? ` +${due.repeat.every}${due.repeat.unit}` : ''}`;
}

/**
 * An item's text with another date (null: without one). The text before the date stays as it is; with no date before,
 * trailing spaces go and one space separates the date.
 */
export function writeDue(itemText: string, due: TaskDue | null): string {
  const { text } = readDue(itemText);
  const base = text.slice(0, trimmedEnd(text, 0));
  if (!due) return base;
  return base ? `${base} ${formatDue(due)}` : formatDue(due);
}

/** The local moment of a date; a date without a time stands at `fallback` (`HH:MM`, default 00:00). */
export function dueAt(due: TaskDue, fallback = '00:00'): Date {
  const [y, mo, d] = due.date.split('-').map(Number) as [number, number, number];
  const [h, mi] = (due.time ?? fallback).split(':').map(Number) as [number, number];
  return new Date(y, mo - 1, d, h, mi);
}

/** The day `steps` repeats after `date` (a `YYYY-MM-DD`); months and years end on the last day where the day is missing. */
export function stepDate(date: string, repeat: TaskRepeat, steps: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const n = repeat.every * steps;
  let at: Date;
  if (repeat.unit === 'd' || repeat.unit === 'w') at = new Date(y, mo - 1, d + n * (repeat.unit === 'w' ? 7 : 1));
  else {
    const months = repeat.unit === 'm' ? n : n * 12;
    const year = y + Math.floor((mo - 1 + months) / 12);
    const month = (((mo - 1 + months) % 12) + 12) % 12;
    at = new Date(year, month, Math.min(d, daysIn(year, month)));
  }
  return `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The calendar day of a moment, `YYYY-MM-DD` in local time. */
export const dayOf = (at: Date): string => `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/**
 * The next date of a repeating task once it is done: whole repeats on from the old date (the weekday of a weekly task
 * stays, the 31st of a monthly one is the last day of a shorter month) until it lies after `now` – at least one step,
 * also when it was done early. A date without a time counts as due all day: the next one is after today. Without a
 * repeat, the date as it is.
 */
export function nextDue(due: TaskDue, now: Date): TaskDue {
  if (!due.repeat) return due;
  const today = dayOf(now);
  const after = (date: string) => (due.time ? dueAt({ ...due, date }) > now : date > today);
  // Close to the answer in one jump for dates long past (a daily task left for years) – never past it, a month counted
  // as 31 days – then step by step.
  const per = { d: 1, w: 7, m: 31, y: 366 }[due.repeat.unit] * due.repeat.every;
  const behind = Math.floor((now.getTime() - dueAt(due).getTime()) / 86_400_000 / per);
  let steps = Math.max(1, behind - 1);
  while (!after(stepDate(due.date, due.repeat, steps))) steps++;
  return { ...due, date: stepDate(due.date, due.repeat, steps) };
}
