// When a backup plan runs and which archives it keeps (AD-038). Pure functions, local time.
// Runs: daily → every day; weekly → Sundays; monthly → on the 1st; yearly → on 1 January — at
// the plan's time, the finest chosen rhythm wins. A slot missed while Kaveyl Wiki was down runs at
// the next start. Keeping works like restic's --keep-daily/weekly/monthly/yearly: per tier the
// newest archive of each of the last N days/weeks/months/years; the newest archive always stays.
// SEE-DOC: DECISIONS.md AD-038

import { isoWeek } from '../backup.js';

export interface Keep {
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}

export const TIERS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type Tier = (typeof TIERS)[number];

export const MAX_KEEP: Keep = { daily: 366, weekly: 260, monthly: 240, yearly: 50 };

export function cleanKeep(k: Partial<Keep> | undefined): Keep {
  const n = (v: unknown, max: number) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(0, Math.round(Number(v)))) : 0);
  const keep = { daily: n(k?.daily, MAX_KEEP.daily), weekly: n(k?.weekly, MAX_KEEP.weekly), monthly: n(k?.monthly, MAX_KEEP.monthly), yearly: n(k?.yearly, MAX_KEEP.yearly) };
  return keep;
}

export const anyTier = (k: Keep) => TIERS.some((t) => k[t] > 0);

/** "HH:MM" → minutes after midnight (invalid → 02:00). */
export function minutesOf(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return 120;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function cleanTime(time: string | undefined): string {
  const min = minutesOf(time ?? '02:00');
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** Whether the plan runs on this calendar day. */
export function runsOn(day: Date, keep: Keep): boolean {
  if (keep.daily > 0) return true;
  if (keep.weekly > 0 && day.getDay() === 0) return true;
  if (keep.monthly > 0 && day.getDate() === 1) return true;
  if (keep.yearly > 0 && day.getMonth() === 0 && day.getDate() === 1) return true;
  return false;
}

/** The latest planned start at or before `now` (null: nothing chosen, or none within ~13 months). */
export function lastSlot(keep: Keep, time: string, now: Date): Date | null {
  if (!anyTier(keep)) return null;
  const min = minutesOf(time);
  for (let back = 0; back <= 400; back++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, Math.floor(min / 60), min % 60, 0, 0);
    if (d.getTime() <= now.getTime() && runsOn(d, keep)) return d;
  }
  return null;
}

/** The next planned start after `now` (for the overview). */
export function nextSlot(keep: Keep, time: string, now: Date): Date | null {
  if (!anyTier(keep)) return null;
  const min = minutesOf(time);
  for (let ahead = 0; ahead <= 400; ahead++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, Math.floor(min / 60), min % 60, 0, 0);
    if (d.getTime() > now.getTime() && runsOn(d, keep)) return d;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const bucket: Record<Tier, (d: Date) => string> = {
  daily: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  weekly: (d) => isoWeek(d),
  monthly: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
  yearly: (d) => String(d.getFullYear()),
};

/** Ids of the archives to delete under `keep` (archives of one plan, target and source). */
export function toDelete<T extends { id: string; createdAt: string }>(archives: T[], keep: Keep): string[] {
  const sorted = [...archives].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!sorted.length) return [];
  const kept = new Set<string>([sorted[0]!.id]);
  for (const tier of TIERS) {
    const n = keep[tier];
    if (!n) continue;
    let last: string | null = null;
    let count = 0;
    for (const a of sorted) {
      if (count >= n) break;
      const b = bucket[tier](new Date(a.createdAt));
      if (b === last) continue;
      last = b;
      count++;
      kept.add(a.id);
    }
  }
  return sorted.filter((a) => !kept.has(a.id)).map((a) => a.id);
}
