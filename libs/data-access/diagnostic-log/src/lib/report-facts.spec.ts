import { EMPTY, NEVER, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticAccountSource } from './diagnostic-log.tokens';
import {
  KNOWN_NAMES_TIMEOUT_MS,
  readKnownNames,
  type DiagnosticNameGroup,
} from './report-facts';

const GARDEN: DiagnosticNameGroup = {
  roomNames: ['Garden Club'],
  roomTopics: [],
  displayNames: ['Alice Liddell'],
};

function source(
  knownNames: DiagnosticAccountSource['knownNames'],
): DiagnosticAccountSource {
  return { accounts: () => of([]), knownNames };
}

describe('readKnownNames', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the names the source emits', async () => {
    const names = await firstValueFrom(
      readKnownNames(source(() => of([GARDEN]))),
    );

    expect([...names]).toEqual([GARDEN]);
  });

  it('reads none when there is no source', async () => {
    expect([...(await firstValueFrom(readKnownNames(null)))]).toEqual([]);
  });

  it('fails closed when the source errors', async () => {
    const names = await firstValueFrom(
      readKnownNames(source(() => throwError(() => new Error('gone')))),
    );

    expect(() => [...names]).toThrow('gone');
  });

  it('fails closed when the source completes without names', async () => {
    const names = await firstValueFrom(readKnownNames(source(() => EMPTY)));

    expect(() => [...names]).toThrow();
  });

  it('fails closed when the source never answers', async () => {
    vi.useFakeTimers();
    const read = firstValueFrom(readKnownNames(source(() => NEVER)));

    await vi.advanceTimersByTimeAsync(KNOWN_NAMES_TIMEOUT_MS);

    const names = await read;
    expect(() => [...names]).toThrow();
  });
});
