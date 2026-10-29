import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailureLimit, type AuthService } from './auth.js';
import { AccountMail } from './accountmail.js';
import type { DB } from '../db/db.js';
import type { Acl } from '../acl/acl.js';
import type { Mailer } from '../mail/mailer.js';

describe('FailureLimit (login brake) stays bounded', () => {
  afterEach(() => vi.useRealTimers());

  it('expired keys are swept, so many different keys do not pile up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const limit = new FailureLimit(3, 60_000);
    for (let i = 0; i < 500; i++) limit.fail(`guess${i}@example.test`);
    expect(limit.size).toBe(500);
    vi.setSystemTime(new Date('2026-10-15T12:01:01Z'));
    limit.fail('later@example.test');
    expect(limit.size).toBe(1);
  });

  it('holds at most maxKeys keys; the least recently failed goes first, the brake still works', () => {
    const limit = new FailureLimit(3, 60_000, 100);
    for (let i = 0; i < 3; i++) limit.fail('victim@example.test');
    expect(limit.blocked('victim@example.test')).toBe(true);
    for (let i = 0; i < 1000; i++) limit.fail(`guess${i}@example.test`);
    expect(limit.size).toBe(100);
    expect(limit.blocked('guess999@example.test')).toBe(false);
    for (let i = 0; i < 2; i++) limit.fail('guess999@example.test');
    expect(limit.blocked('guess999@example.test')).toBe(true);
  });

  it('a blocked key is never pushed out by failures of other keys', () => {
    const limit = new FailureLimit(3, 60_000, 100);
    for (let i = 0; i < 3; i++) limit.fail('victim@example.test');
    for (let i = 0; i < 1000; i++) limit.fail(`guess${i}@example.test`);
    expect(limit.size).toBe(100);
    expect(limit.blocked('victim@example.test')).toBe(true);
  });

  it('all held keys blocked: a new key is not held and counts as blocked until the blocks run out', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:10Z'));
    const limit = new FailureLimit(2, 60_000, 2);
    for (const k of ['a@example.test', 'b@example.test']) for (let i = 0; i < 2; i++) limit.fail(k);
    vi.setSystemTime(new Date('2026-10-15T12:00:20Z'));
    expect(limit.blocked('new@example.test')).toBe(true);
    limit.fail('new@example.test');
    expect(limit.size).toBe(2);
    expect(limit.blocked('a@example.test')).toBe(true);
    expect(limit.blocked('b@example.test')).toBe(true);
    expect(limit.blocked('new@example.test')).toBe(true);
    vi.setSystemTime(new Date('2026-10-15T12:01:11Z'));
    expect(limit.blocked('new@example.test')).toBe(false);
    limit.fail('new@example.test');
    expect(limit.blocked('new@example.test')).toBe(false);
  });

  it('very long keys are cut, so one entry stays small', () => {
    const limit = new FailureLimit(2, 60_000);
    const long = 'x'.repeat(100_000);
    limit.fail(long);
    limit.fail(long + 'y');
    expect(limit.size).toBe(1);
    expect(limit.blocked(long)).toBe(true);
  });
});

describe('FailureLimit.hit (rate limit: counts allowed requests)', () => {
  afterEach(() => vi.useRealTimers());

  it('allows max hits per key and window, then refuses until the oldest falls out', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const limit = new FailureLimit(3, 60_000);
    expect([1, 2, 3, 4].map(() => limit.hit('1.2.3.4'))).toEqual([true, true, true, false]);
    expect(limit.hit('5.6.7.8')).toBe(true);
    vi.setSystemTime(new Date('2026-10-15T12:01:00Z'));
    expect(limit.hit('1.2.3.4')).toBe(true);
  });

  it('expired keys are swept and at most maxKeys are held', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const limit = new FailureLimit(3, 60_000, 100);
    for (let i = 0; i < 1000; i++) expect(limit.hit(`10.0.${i >> 8}.${i & 255}`)).toBe(true);
    expect(limit.size).toBe(100);
    vi.setSystemTime(new Date('2026-10-15T12:01:01Z'));
    limit.hit('later');
    expect(limit.size).toBe(1);
  });
});

describe('AccountMail brakes stay bounded', () => {
  afterEach(() => vi.useRealTimers());

  it('„Passwort vergessen“ from many addresses: the keys go again once the hour is over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const auth = { userByEmail: () => null } as unknown as AuthService;
    const mail = new AccountMail(null as unknown as DB, auth, null as unknown as Acl, null as unknown as Mailer, () => {});
    for (let i = 0; i < 200; i++) await mail.requestReset(`user${i}@example.test`, `10.0.0.${i}`);
    const perIp = mail['resetPerIp'] as unknown as FailureLimit;
    const perEmail = mail['resetPerEmail'] as unknown as FailureLimit;
    expect(perIp.size).toBe(200);
    expect(perEmail.size).toBe(200);
    vi.setSystemTime(new Date('2026-10-15T13:00:01Z'));
    await mail.requestReset('later@example.test', '10.0.1.1');
    expect(perIp.size).toBe(1);
    expect(perEmail.size).toBe(1);
  });
});
