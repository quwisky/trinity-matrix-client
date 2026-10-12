import { createHash } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDiagnosticBundle,
  buildDiagnosticBundleInSlices,
  type DiagnosticBundleInput,
} from '../diagnostic-bundle';
import { runInSlices } from './run-in-slices';
import type { DiagnosticEntry } from '../diagnostic-entry.model';
import {
  ALICE,
  CORPUS_CONTEXT,
  HOMESERVER,
  OWN_DEVICE,
  REDACTION_CORPUS,
} from '../redaction/redaction-corpus';

const T0 = Date.UTC(2026, 9, 11, 8);

/** The redaction corpus as stored entries, in order. */
function corpusEntries(): DiagnosticEntry[] {
  return REDACTION_CORPUS.map((entry, index) => ({
    ts: T0 + index * 1000,
    level: 'debug',
    source: 'sdk',
    logger: 'matrix',
    message: entry.line,
  }));
}

/**
 * A deterministic log of about 1.5 MB: the corpus over and over with varying users, rooms,
 * servers and devices, and some multi-line messages, so placeholders keep being assigned.
 */
function largeLog(): DiagnosticEntry[] {
  const lines = REDACTION_CORPUS.map((entry) => entry.line);
  const entries: DiagnosticEntry[] = [];
  for (let n = 0; n < 12_000; n += 1) {
    const server = `server${n % 7}.example.net`;
    const variable = [
      `sync for @user${n % 113}:${server} in !room${n % 89}x:${server}`,
      `GET https://matrix.${server}/_matrix/client/v3/rooms/%21r${n % 31}%3A${server}/messages`,
      `device DEV${String(n % 47).padStart(7, '0')} of @user${n % 113}:${server}\nsecond line ${n}`,
      lines[n % lines.length],
    ][n % 4];
    entries.push({
      ts: T0 + n * 10,
      level: (['debug', 'info', 'warn', 'error'] as const)[n % 4],
      source: n % 3 === 0 ? 'console' : 'sdk',
      logger: n % 3 === 0 ? 'trinity' : 'matrix',
      message: variable,
    });
  }
  return entries;
}

function input(entries: readonly DiagnosticEntry[]): DiagnosticBundleInput {
  return {
    now: new Date(2026, 9, 11, 9, 30),
    build: {
      version: '0.4.0',
      commit: 'abc1234',
      builtAt: '',
      dependencies: { matrixJsSdk: '43.0.0', cryptoWasm: '18.9.0' },
    },
    platform: 'Web, Chrome 141 on macOS',
    accounts: [
      {
        userId: ALICE,
        deviceId: OWN_DEVICE,
        homeserverUrl: HOMESERVER,
        software: { name: 'Synapse', version: '1.140.0' },
      },
    ],
    snapshot: { entries, dropped: true, storage: 'indexeddb' },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The files the synchronous builder produced before the export was split into slices,
 * pinned so the sliced build can be checked byte for byte against them.
 */
const PINNED = {
  corpus: 'f84f6aa2b4a67ae98c41860a867686cbaef1982f1d0b6170c9e8e3a3ad347b23',
  large: 'a53675548fea49be6f16220231368ffeb7b229b525483495074e8892efa3710d',
};

describe('the diagnostic file', () => {
  it('matches the pinned synchronous output', () => {
    expect(CORPUS_CONTEXT.selfUserIds).toEqual([ALICE]);
    expect(sha256(buildDiagnosticBundle(input(corpusEntries())).text)).toBe(
      PINNED.corpus,
    );
    expect(sha256(buildDiagnosticBundle(input(largeLog())).text)).toBe(
      PINNED.large,
    );
  });
});

/**
 * A clock that moves one millisecond each time it is read, so a slice of `sliceMs` runs
 * about that many steps and the build takes many slices, whatever the machine's speed.
 */
function steppingClock(): () => number {
  let now = 0;
  return () => (now += 1);
}

describe('building the diagnostic file in slices', () => {
  it.each([
    ['the redaction corpus', corpusEntries, () => PINNED.corpus],
    ['a large generated log', largeLog, () => PINNED.large],
  ] as const)(
    'produces exactly the synchronous file for %s',
    async (_name, entries, pinned) => {
      const sliced = await firstValueFrom(
        buildDiagnosticBundleInSlices(input(entries()), {
          sliceMs: 500,
          now: steppingClock(),
        }),
      );

      expect(sha256(sliced.text)).toBe(pinned());
      expect(sliced).toEqual(buildDiagnosticBundle(input(entries())));
    },
  );

  it('yields to the event loop between slices', async () => {
    const order: string[] = [];
    const built = firstValueFrom(
      buildDiagnosticBundleInSlices(input(largeLog()), {
        sliceMs: 500,
        now: steppingClock(),
      }),
    ).then(() => order.push('built'));
    setTimeout(() => order.push('timer'), 0);

    await built;

    expect(order).toEqual(['timer', 'built']);
  });

  it('stops working once unsubscribed', async () => {
    let steps = 0;
    function* work(): Generator<void, string> {
      for (let n = 0; n < 1_000; n += 1) {
        steps += 1;
        yield;
      }
      return 'done';
    }
    const next = vi.fn();
    const subscription = runInSlices(work, {
      sliceMs: 5,
      now: steppingClock(),
    }).subscribe(next);

    // The first slice ran on subscription; the rest wait for later tasks.
    const stepsAtUnsubscribe = steps;
    subscription.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stepsAtUnsubscribe).toBeGreaterThan(0);
    expect(stepsAtUnsubscribe).toBeLessThan(1_000);
    expect(steps).toBe(stepsAtUnsubscribe);
    expect(next).not.toHaveBeenCalled();
  });

  it('reports a failing step as an error', async () => {
    function* work(): Generator<void, string> {
      throw new Error('redactor failed');
    }

    await expect(firstValueFrom(runInSlices(work))).rejects.toThrow(
      'redactor failed',
    );
  });
});
