import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTrinityPushPayload } from './util-push-client';

// The Android instrumentation suite reads this same file as a test asset.
const fixtures: { name: string; data: unknown; expected: unknown }[] =
  JSON.parse(
    readFileSync(
      new URL('../../fixtures/payloads.json', import.meta.url),
      'utf8',
    ),
  );

describe('shared native push payload contract', () => {
  it.each(fixtures)('$name', ({ data, expected }) => {
    expect(parseTrinityPushPayload(data)).toEqual(expected);
  });
});
