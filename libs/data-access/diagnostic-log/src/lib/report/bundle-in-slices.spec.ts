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
import type { DiagnosticNameGroup } from '../report-facts';
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

/** Enough entries for the build to take many slices at {@link SLICE_MS}, and no more. */
const LARGE_LOG_ENTRIES = 2_500;
const SLICE_MS = 100;
const MIN_SLICES = 20;

/**
 * A deterministic log of about 300 KB: the corpus over and over with varying users, rooms,
 * servers and devices, and some multi-line messages, so placeholders keep being assigned.
 */
function largeLog(): DiagnosticEntry[] {
  const lines = REDACTION_CORPUS.map((entry) => entry.line);
  const entries: DiagnosticEntry[] = [];
  for (let n = 0; n < LARGE_LOG_ENTRIES; n += 1) {
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

/** Names that occur in {@link largeLog}, so the sliced build replaces them too. */
const LARGE_LOG_NAMES: readonly DiagnosticNameGroup[] = [
  { roomNames: ['second line'], roomTopics: [], displayNames: [] },
  { roomNames: [], roomTopics: [], displayNames: ['FetchHttpApi'] },
];

function input(
  entries: readonly DiagnosticEntry[],
  knownNames: DiagnosticBundleInput['knownNames'] = [],
): DiagnosticBundleInput {
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
    knownNames,
    snapshot: { entries, dropped: true, storage: 'indexeddb' },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The files the synchronous builder produced before the export was split into slices,
 * pinned so the sliced build can be checked byte for byte against them. Re-pinned when the
 * header's placeholder note began to list names and email addresses, and when placeholders
 * stopped being read as device IDs (`@user10` had become `@DEVICE441` after "device … of").
 */
const PINNED = {
  corpus: '8b897c8b864abd8a48794c4da244e43c7f94ad75d7f8a95041303419fbcb666a',
  large: '3c7611959b87ffbe6518970e9dd5dd3422495428caddabcf476a68023a6584c5',
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
function steppingClock(): { now: () => number; reads: () => number } {
  let now = 0;
  return { now: () => (now += 1), reads: () => now };
}

describe('building the diagnostic file in slices', () => {
  it.each([
    ['the redaction corpus', corpusEntries, () => PINNED.corpus],
    ['a large generated log', largeLog, () => PINNED.large],
  ] as const)(
    'produces exactly the synchronous file for %s',
    async (_name, entries, pinned) => {
      const clock = steppingClock();
      const sliced = await firstValueFrom(
        buildDiagnosticBundleInSlices(input(entries()), {
          sliceMs: SLICE_MS,
          now: clock.now,
        }),
      );

      expect(sha256(sliced.text)).toBe(pinned());
      expect(sliced).toEqual(buildDiagnosticBundle(input(entries())));
      if (entries === largeLog) {
        // One clock read per step and per slice start: this many reads is many slices.
        expect(clock.reads() / (SLICE_MS + 1)).toBeGreaterThan(MIN_SLICES);
      }
    },
  );

  it('produces exactly the synchronous file when names are replaced', async () => {
    const sliced = await firstValueFrom(
      buildDiagnosticBundleInSlices(input(largeLog(), LARGE_LOG_NAMES), {
        sliceMs: SLICE_MS,
        now: steppingClock().now,
      }),
    );

    expect(sliced).toEqual(
      buildDiagnosticBundle(input(largeLog(), LARGE_LOG_NAMES)),
    );
    expect(sliced.text).not.toContain('second line');
    expect(sliced.text).toContain('Room 1');
  });

  it('yields to the event loop between slices', async () => {
    const order: string[] = [];
    const built = firstValueFrom(
      buildDiagnosticBundleInSlices(input(largeLog()), {
        sliceMs: SLICE_MS,
        now: steppingClock().now,
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
      now: steppingClock().now,
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
