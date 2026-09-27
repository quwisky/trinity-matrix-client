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
  hasMatrixCredential,
  hasMatrixIdentifier,
  redactMatrixCredentials,
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

// Synthetic credentials in the shapes the debug APK's Capacitor bridge and
// Matrix clients log; none is a real token.
const synapseToken = `syt_${'dGVzdA'}_${'AbCdEfGhIjKlMnOpQrSt'}_0a1B2c`;
const masToken = `mat_${'Q'.repeat(30)}_1a2B3c`;
const secureStoragePut = `V Capacitor: callback: 1, pluginId: SecureStorage, methodName: internalSetItem, methodData: {"prefixedKey":"capacitor-storage_matrix.refreshToken:@u:localhost","data":"\"opaque-refresh-${'r'.repeat(24)}\"","sync":false}`;

describe('Matrix credential redaction', () => {
  it.each([
    [
      'a Synapse access token',
      `token ${synapseToken} end`,
      'token [REDACTED] end',
    ],
    ['a Synapse refresh token', `syr_${'x'.repeat(20)}_AbCdEf`, '[REDACTED]'],
    ['a MAS access token', `mas ${masToken}`, 'mas [REDACTED]'],
    [
      'a bearer header',
      'Authorization: Bearer abcdefghij.KLM-0123',
      'Authorization: Bearer [REDACTED]',
    ],
    [
      'a percent-encoded bearer header',
      'Authorization%3A%20Bearer%20abcdefghij0123',
      'Authorization%3A%20Bearer%20[REDACTED]',
    ],
    [
      'a JSON access_token field',
      '{"access_token":"opaque0123456789"}',
      '{"access_token":"[REDACTED]"}',
    ],
    [
      'a JSON-escaped accessToken field',
      '{\\"accessToken\\":\\"opaque0123456789\\"}',
      '{\\"accessToken\\":\\"[REDACTED]\\"}',
    ],
    [
      'a query refresh_token',
      '/token?refresh_token=opaque0123456789&x=1',
      '/token?refresh_token=[REDACTED]&x=1',
    ],
    [
      'a percent-encoded field',
      'body=%7B%22refresh_token%22%3A%22opaque0123456789%22%7D',
      'body=%7B%22refresh_token%22%3A%22[REDACTED]%22%7D',
    ],
    [
      'a secure-storage payload',
      secureStoragePut,
      secureStoragePut.replace(/methodData: .*$/u, 'methodData: [REDACTED]'),
    ],
  ])('redacts %s and flags it before redaction', (_name, text, expected) => {
    expect(hasMatrixIdentifier(text)).toBe(true);
    expect(redactMatrixIdentifiers(text)).toBe(expected);
    expect(hasMatrixIdentifier(expected)).toBe(false);
    expect(hasMatrixCredential(text)).toBe(true);
    expect(redactMatrixCredentials(text)).toBe(expected);
    expect(hasMatrixCredential(expected)).toBe(false);
  });

  it.each([
    [
      'a texture format name',
      'GL_EXT_texture_format_BGRA8888 GL_OES_rgb8_rgba8',
    ],
    [
      'a secure-storage key without a value',
      'methodName: internalRemoveItem, prefixedKey:"capacitor-storage_matrix.refreshToken:@u:localhost"',
    ],
    [
      'a token lifetime setting',
      'refresh_token_lifetime: 5m access_token: null',
    ],
    [
      'a Gboard password IME line',
      'imeDef=kyj{stringId=password, PasswordIme.onActivate()',
    ],
    [
      'a public key id',
      'created_keys=["curve25519:AAAAAAAAAAB"] device_id=QIXNPFVWIO',
    ],
  ])('leaves %s alone', (_name, text) => {
    expect(hasMatrixIdentifier(text)).toBe(false);
    expect(redactMatrixIdentifiers(text)).toBe(text);
    expect(hasMatrixCredential(text)).toBe(false);
    expect(redactMatrixCredentials(text)).toBe(text);
  });

  it('redacts only credentials for browser and desktop reports', () => {
    // The Playwright step title that leaked: a serialized Synapse login.
    const login = `{"user_id":"@link-user:localhost","access_token":"${synapseToken}","home_server":"caddy:9448"}`;
    const text = `${login} in ${roomId} at ${eventId}`;
    expect(hasMatrixCredential(text)).toBe(true);
    expect(redactMatrixCredentials(text)).toBe(
      `{"user_id":"@link-user:localhost","access_token":"[REDACTED]","home_server":"caddy:9448"} in ${roomId} at ${eventId}`,
    );
    expect(hasMatrixCredential(`${roomId} ${eventId}`)).toBe(false);
  });

  it('redacts a token split by colour sequences, raw or JSON-escaped', () => {
    for (const escape of ['\u001b', '\\u001b']) {
      const split = [...synapseToken]
        .map((character) => `${escape}[31m${character}${escape}[39m`)
        .join('');
      expect(hasMatrixCredential(`Received: ${split}`)).toBe(true);
      const redacted = redactMatrixCredentials(`Received: ${split}`);
      expect(redacted).toBe('Received: [REDACTED]');
      expect(hasMatrixCredential(redacted)).toBe(false);
    }
  });

  it('withholds nothing once a published logcat is scrubbed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-credentials-'));
    directories.push(directory);
    const logcat = join(directory, 'logcat.txt');
    writeFileSync(
      logcat,
      `${secureStoragePut.replace('opaque-refresh', synapseToken)}\n`,
    );
    const result = await enforceMatrixIdentifierFreeArtifacts(directory);
    expect(result).toEqual({ redacted: ['logcat.txt'], unsafe: [] });
    const published = readFileSync(logcat, 'utf8');
    expect(published).not.toContain('syt_');
    expect(published).not.toContain('opaque');
  });
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
