import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MatrixIdentifierLineRedactor,
  enforceMatrixIdentifierFreeArtifacts,
  hasMatrixIdentifier,
  redactMatrixIdentifiers,
} from './matrix-identifiers.mts';
import {
  publicErrorMessage,
  publicFailureLines,
  publicFailureText,
  publicStageFailure,
} from './public-failure.mts';

const eventId = `$${'aB3_-'.repeat(8)}xyz`;
const roomId = '!AbCdEfGhIjKlMnOpQr:localhost';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Matrix identifier redaction', () => {
  it.each([
    [
      `Event ${eventId} already in timeline`,
      'Event [REDACTED] already in timeline',
    ],
    [`.msg[data-mid="${eventId}"]`, '.msg[data-mid="[REDACTED]"]'],
    [encodeURIComponent(eventId), '[REDACTED]'],
    [encodeURIComponent(encodeURIComponent(eventId)), '[REDACTED]'],
    [eventId.replace('$', '%24').toLowerCase(), '[REDACTED]'],
    [roomId, '[REDACTED]'],
    [`${roomId}:8448/x`, '[REDACTED]/x'],
    [encodeURIComponent(roomId), '[REDACTED]'],
    [encodeURIComponent(encodeURIComponent(roomId)), '[REDACTED]'],
    [
      `/rooms/${Buffer.from(roomId).toString('base64url')}?x=1`,
      '/rooms/[REDACTED]?x=1',
    ],
  ])('redacts %s', (input, expected) => {
    expect(hasMatrixIdentifier(input)).toBe(true);
    expect(redactMatrixIdentifiers(input)).toBe(expected);
    expect(hasMatrixIdentifier(expected)).toBe(false);
  });

  it.each([
    '.scroll .msg[data-mid^="$"]',
    'if (!document.querySelector(selector)) return',
    'color: red !important;',
    '${ROOM_NAME}',
    '/rooms/IAmNotARoomSegmentAtAll',
    '@alice:localhost',
  ])('keeps id-free text %s', (input) => {
    expect(hasMatrixIdentifier(input)).toBe(false);
    expect(redactMatrixIdentifiers(input)).toBe(input);
  });

  it('redacts an identifier split by colour sequences, raw or JSON-escaped', () => {
    const coloured = [...eventId]
      .map((character) => `\u001b[31m${character}\u001b[39m`)
      .join('');
    const escaped = JSON.stringify({ error: `diff ${coloured}` });
    for (const text of [`diff ${coloured}`, escaped]) {
      expect(hasMatrixIdentifier(text)).toBe(true);
      const redacted = redactMatrixIdentifiers(text);
      expect(hasMatrixIdentifier(redacted)).toBe(false);
      expect(redacted).toContain('[REDACTED]');
    }
    const plainColour = '\u001b[32mpassed\u001b[39m';
    expect(redactMatrixIdentifiers(plainColour)).toBe(plainColour);
  });

  it('redacts an identifier split across stream chunks and bounds a long line', () => {
    const lines = new MatrixIdentifierLineRedactor(100);
    let output = '';
    for (const character of `Event ${eventId} already\n`)
      output += lines.write(character);
    expect(output).toBe('Event [REDACTED] already\n');

    const long = new MatrixIdentifierLineRedactor(100);
    let released = long.write(`${'x'.repeat(700)} ${eventId}`);
    released += long.write(` ${roomId}`);
    released += long.flush();
    expect(hasMatrixIdentifier(released)).toBe(false);
    expect(released).toBe(`${'x'.repeat(700)} [REDACTED] [REDACTED]`);
  });

  it('scrubs text diagnostics and withholds what it cannot verify', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-identifiers-'));
    directories.push(directory);
    mkdirSync(join(directory, 'stage'), { recursive: true });
    writeFileSync(join(directory, 'stage', 'process.log'), `row ${eventId}\n`);
    writeFileSync(join(directory, 'stage', 'shot.png'), Buffer.from([0x89, 0]));
    writeFileSync(join(directory, 'stage', 'publication-safe'), 'scanned\n');
    const clean = await enforceMatrixIdentifierFreeArtifacts(directory);
    expect(clean).toEqual({ redacted: ['stage/process.log'], unsafe: [] });
    expect(readFileSync(join(directory, 'stage', 'process.log'), 'utf8')).toBe(
      'row [REDACTED]\n',
    );
    expect(existsSync(join(directory, 'stage', 'publication-safe'))).toBe(true);

    writeFileSync(
      join(directory, 'stage', 'trace.bin'),
      Buffer.from([1, 0, 2]),
    );
    const unsafe = await enforceMatrixIdentifierFreeArtifacts(directory);
    expect(unsafe.unsafe).toEqual(['stage/trace.bin']);
    expect(existsSync(join(directory, 'stage', 'trace.bin'))).toBe(false);
    expect(existsSync(join(directory, 'stage', 'publication-safe'))).toBe(
      false,
    );
    expect(existsSync(join(directory, 'stage', 'shot.png'))).toBe(true);
  });
});

describe('Public failure text', () => {
  const assertion = (run: () => void): Error => {
    try {
      run();
    } catch (error) {
      assert(error instanceof Error);
      return error;
    }
    throw new Error('Expected an assertion');
  };

  it('keeps only the first line of an assertion and names generated ones by operator', () => {
    const custom = assertion(() =>
      assert.equal('actual-value', eventId, 'row is bound'),
    );
    const generated = assertion(() =>
      assert.deepEqual({ id: 'actual-value' }, { id: eventId }),
    );
    expect(custom.message.split('\n').length).toBeGreaterThan(1);
    expect(publicErrorMessage(custom)).toBe('row is bound');
    expect(publicErrorMessage(generated)).toBe(
      'deepStrictEqual assertion failed',
    );
    expect(
      publicErrorMessage(new Error('Timed out waiting for one visible row')),
    ).toBe('Timed out waiting for one visible row');
  });

  it('flattens stage failures and redacts the rethrown error', () => {
    const custom = assertion(() =>
      assert.equal('actual-value', eventId, 'row is bound'),
    );
    const failures = [
      new AggregateError(
        [custom, new Error(`missing ${roomId}`)],
        'stage failed',
      ),
      'text',
    ];
    expect(publicFailureLines(failures)).toEqual([
      'AggregateError: stage failed',
      'AssertionError: row is bound',
      `Error: missing ${roomId}`,
      'string',
    ]);
    const rethrown = publicStageFailure(
      'Android example s1 failed',
      failures,
      (text) => text.replaceAll('missing', '[SECRET]'),
    );
    expect(rethrown.message).toBe(
      [
        'Android example s1 failed',
        'AggregateError: stage failed',
        'AssertionError: row is bound',
        'Error: [SECRET] [REDACTED]',
        'string',
      ].join('\n'),
    );
  });

  it('describes nested causes and serialized assertions without their values', () => {
    const custom = assertion(() =>
      assert.equal('actual-value', eventId, 'row is bound'),
    );
    const serialized = new Error(custom.message);
    serialized.stack = custom.stack;
    const wrapper = Object.assign(
      new Error(custom.message, {
        cause: new AggregateError(
          [serialized, new Error('flow failed')],
          'journey failed',
        ),
      }),
      { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure' },
    );
    const text = publicFailureText(wrapper);
    expect(text).not.toContain('actual-value');
    expect(text).not.toContain(eventId.slice(1));
    expect(text).toContain(
      'Error [ERR_TEST_FAILURE]: test failed (testCodeFailure)',
    );
    expect(text).toContain('[cause] AggregateError: journey failed');
    expect(text).toContain('[errors][0] AssertionError: row is bound');
    expect(text).toContain('[errors][1] Error: flow failed');
    expect(text).toMatch(/^\s+at /mu);
  });
});
