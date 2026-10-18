import { scrypt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attemptAllowed,
  checkPin,
  createPinRecord,
  decodePinRecord,
  encodePinRecord,
  isValidPin,
  nextAttemptAt,
  waitSecondsAfter,
  type PinClock,
  type PinRecord,
} from './app-lock-pin';

// A pass-through spy, so tests can prove which attempts reach the key derivation.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

interface Cases {
  readonly formats: readonly { name: string; pin: string; valid: boolean }[];
  readonly delays: readonly { failures: number; waitSeconds: number }[];
  readonly attempts: readonly {
    name: string;
    failures: number;
    wallElapsedSeconds: number;
    uptimeElapsedSeconds: number;
    rebooted: boolean;
    allowed: boolean;
  }[];
}

const cases = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../native/app-lock/pin-policy-cases.json'),
    'utf8',
  ),
) as Cases;

const FAILURE_AT = 1_700_000_000_000;
const FAILURE_UPTIME = 5_000;
// Fast parameters for tests only; production uses PRODUCTION_SCRYPT.
const FAST = { N: 1024, r: 8, p: 1 } as const;
const clock = (nowMs = FAILURE_AT, uptimeS = FAILURE_UPTIME): PinClock => ({
  nowMs,
  uptimeS,
});

// Records hold a salt and a hash: compare them as booleans so a failure prints neither.
const sameRecord = (actual: PinRecord | null, expected: PinRecord): boolean =>
  isDeepStrictEqual(actual, expected);
const outcomeOf = (pending: Promise<PinRecord>): Promise<string> =>
  pending.then(
    () => 'stored',
    (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
  );

describe('PIN policy (shared fixture)', () => {
  it.each(cases.formats)('format: $name', ({ pin, valid }) => {
    expect(isValidPin(pin)).toBe(valid);
  });

  it.each(cases.delays)(
    'waits $waitSeconds s after $failures failures',
    ({ failures, waitSeconds }) => {
      expect(waitSecondsAfter(failures)).toBe(waitSeconds);
    },
  );

  it.each(cases.attempts)(
    'attempt: $name',
    ({
      failures,
      wallElapsedSeconds,
      uptimeElapsedSeconds,
      rebooted,
      allowed,
    }) => {
      expect(
        attemptAllowed(
          {
            failures,
            failureAtMs: failures > 0 ? FAILURE_AT : null,
            failureUptimeS: failures > 0 ? FAILURE_UPTIME : null,
          },
          clock(
            FAILURE_AT + wallElapsedSeconds * 1000,
            rebooted ? 3 : FAILURE_UPTIME + uptimeElapsedSeconds,
          ),
        ),
      ).toBe(allowed);
    },
  );
});

describe('PIN records', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stores a salted hash, never the PIN', async () => {
    const first = await createPinRecord('482913', FAST);
    const second = await createPinRecord('482913', FAST);
    const text = encodePinRecord(first);
    expect(text.includes('482913')).toBe(false);
    expect(first.salt === second.salt).toBe(false);
    expect(first.hash === second.hash).toBe(false);
    expect(sameRecord(decodePinRecord(text), first)).toBe(true);
  });

  it('verifies the right PIN and resets the count', async () => {
    let record: PinRecord = {
      ...(await createPinRecord('482913', FAST)),
      failures: 3,
      failureAtMs: FAILURE_AT,
      failureUptimeS: FAILURE_UPTIME,
    };
    const result = await checkPin(record, '482913', clock());
    record = result.record;
    expect(result.check).toEqual({ kind: 'verified' });
    expect(record.failures).toBe(0);
    expect(record.failureAtMs).toBeNull();
  });

  it('counts failures and starts a wait after the fifth', async () => {
    let record = await createPinRecord('482913', FAST);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await checkPin(record, '000000', clock());
      record = result.record;
      expect(result.check).toEqual({ kind: 'failed', nextAttemptAt: null });
    }
    const fifth = await checkPin(record, '000000', clock());
    expect(fifth.check).toEqual({
      kind: 'failed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    const during = await checkPin(
      fifth.record,
      '482913',
      clock(FAILURE_AT + 5_000, FAILURE_UPTIME + 5),
    );
    expect(during.check).toEqual({
      kind: 'delayed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    expect(sameRecord(during.record, fifth.record)).toBe(true);
    expect(nextAttemptAt(fifth.record)).toBe(FAILURE_AT + 30_000);
  });

  it('refuses a malformed PIN without counting it or hashing it', async () => {
    const record = await createPinRecord('482913', FAST);
    for (const pin of ['12', '١٢٣٤', 4829, null]) {
      const result = await checkPin(record, pin, clock());
      expect(result.check).toEqual({ kind: 'invalid' });
      expect(result.record === record).toBe(true);
    }
  });

  it.each(cases.formats.filter(({ valid }) => !valid))(
    'refuses the $name format before the key derivation',
    async ({ pin }) => {
      const record = await createPinRecord('482913', FAST);
      vi.mocked(scrypt).mockClear();
      const result = await checkPin(record, pin, clock());
      expect(result.check).toEqual({ kind: 'invalid' });
      expect(result.record === record).toBe(true);
      expect(scrypt).not.toHaveBeenCalled();
    },
  );

  it('hashes a well-formed attempt, but not one made during a wait', async () => {
    const record = await createPinRecord('482913', FAST);
    vi.mocked(scrypt).mockClear();
    await checkPin(record, '000000', clock());
    expect(scrypt).toHaveBeenCalledTimes(1);

    const waiting: PinRecord = {
      ...record,
      failures: 5,
      failureAtMs: FAILURE_AT,
      failureUptimeS: FAILURE_UPTIME,
    };
    vi.mocked(scrypt).mockClear();
    const result = await checkPin(
      waiting,
      '482913',
      clock(FAILURE_AT - 3_600_000, FAILURE_UPTIME + 60),
    );
    expect(result.check).toEqual({
      kind: 'delayed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    expect(result.record === waiting).toBe(true);
    expect(scrypt).not.toHaveBeenCalled();
  });

  it.each(cases.formats.filter(({ valid }) => !valid))(
    'will not store the $name format',
    async ({ pin }) => {
      vi.mocked(scrypt).mockClear();
      expect(await outcomeOf(createPinRecord(pin, FAST))).toBe('pin-invalid');
      expect(scrypt).not.toHaveBeenCalled();
    },
  );

  it('reports a key-derivation failure without detail', async () => {
    expect(
      await outcomeOf(createPinRecord('482913', { N: 3, r: 8, p: 1 })),
    ).toBe('pin-kdf-failed');
  });

  it.each([
    ['r of zero', { params: { N: 1024, r: 0, p: 1 } }],
    ['p of zero', { params: { N: 1024, r: 8, p: 0 } }],
    ['N above 32 bits', { params: { N: 2 ** 32 + 1024, r: 8, p: 1 } }],
    ['N beyond the memory cap', { params: { N: 2 ** 21, r: 8, p: 1 } }],
    ['a short hash', { hash: Buffer.alloc(16).toString('base64') }],
    ['a short salt', { salt: Buffer.alloc(8).toString('base64') }],
    [
      'failures without their instants',
      { failures: 5, failureAtMs: null, failureUptimeS: null },
    ],
    [
      'failures without the uptime',
      { failures: 5, failureAtMs: FAILURE_AT, failureUptimeS: null },
    ],
    [
      'instants without failures',
      { failures: 0, failureAtMs: FAILURE_AT, failureUptimeS: 1 },
    ],
    [
      'a fractional count',
      { failures: 1.5, failureAtMs: FAILURE_AT, failureUptimeS: 1 },
    ],
  ])('rejects a record with %s', async (_name, change) => {
    const record = await createPinRecord('482913', FAST);
    expect(
      decodePinRecord(JSON.stringify({ ...record, ...change })) === null,
    ).toBe(true);
  });

  it('keeps a record with a running wait', async () => {
    const record: PinRecord = {
      ...(await createPinRecord('482913', FAST)),
      failures: 6,
      failureAtMs: FAILURE_AT,
      failureUptimeS: FAILURE_UPTIME,
    };
    expect(sameRecord(decodePinRecord(encodePinRecord(record)), record)).toBe(
      true,
    );
  });

  it('rejects a damaged record', () => {
    expect(decodePinRecord('{')).toBeNull();
    expect(decodePinRecord(JSON.stringify({ v: 2 }))).toBeNull();
    expect(
      decodePinRecord(
        JSON.stringify({
          v: 1,
          kdf: 'scrypt',
          params: { N: 3, r: 8, p: 1 },
          salt: 'x',
          hash: 'y',
          failures: 0,
          failureAtMs: null,
          failureUptimeS: null,
        }),
      ),
    ).toBeNull();
  });

  it('never logs the PIN', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const record = await createPinRecord('482913', FAST);
    await checkPin(record, '000000', clock());
    await checkPin(record, '482913', clock());
    const logged = spies
      .flatMap((spy) => spy.mock.calls.flat())
      .map(String)
      .join('\n');
    expect(logged.includes('482913')).toBe(false);
    expect(logged.includes(record.hash)).toBe(false);
  });
});
