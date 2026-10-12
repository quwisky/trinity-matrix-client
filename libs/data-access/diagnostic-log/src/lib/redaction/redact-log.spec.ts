import { describe, expect, it } from 'vitest';
import { createLogRedactor } from './redact-log';
import {
  ALICE,
  BOB,
  CORPUS_CONTEXT,
  EVENT,
  OWN_DEVICE,
  REDACTION_CORPUS,
} from './redaction-corpus';

/** Any Matrix-ID shape left after redaction that is not a placeholder. */
const LEFTOVER_IDS =
  /[@!#][A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+|\$[A-Za-z0-9+/_-]{43}|![A-Za-z0-9_-]{43}/g;
const PLACEHOLDER = /^(?:@me\d*|@user\d+|!room\d+|#alias\d+):server\d+$/;

/** Decode %XX escapes so encoded identifiers are swept too. */
function decodeEscapes(text: string): string {
  return text.replace(/%[0-9A-Fa-f]{2}/g, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
  );
}

describe('createLogRedactor', () => {
  it.each(REDACTION_CORPUS.map((entry) => [entry.name, entry] as const))(
    'redacts the %s format',
    (_name, entry) => {
      const redacted = createLogRedactor(CORPUS_CONTEXT).redact(entry.line);

      expect(redacted).toBe(entry.expected);
      for (const secret of entry.secrets) {
        expect(decodeEscapes(redacted)).not.toContain(secret);
      }
    },
  );

  it('no identifier survives the whole corpus', () => {
    const redactor = createLogRedactor(CORPUS_CONTEXT);
    const text = decodeEscapes(
      REDACTION_CORPUS.map((entry) => redactor.redact(entry.line)).join('\n'),
    );

    const leftovers = (text.match(LEFTOVER_IDS) ?? []).filter(
      (match) => !PLACEHOLDER.test(match),
    );
    expect(leftovers).toEqual([]);
  });

  it('keeps one placeholder per identifier across a file', () => {
    const redactor = createLogRedactor(CORPUS_CONTEXT);

    expect(
      redactor.redact(`Updated state entry m.room.member ${BOB} to ${EVENT}`),
    ).toBe('Updated state entry m.room.member @user1:server3 to $event1');
    expect(
      redactor.redact(
        `Incoming verification event ${EVENT} type m.key.verification.request from ${BOB}`,
      ),
    ).toBe(
      'Incoming verification event $event1 type m.key.verification.request from @user1:server3',
    );
    expect(
      redactor.redact(
        `[trinity] push hand-off stored for ${ALICE} (${OWN_DEVICE}) via https://push.example.net`,
      ),
    ).toBe(
      '[trinity] push hand-off stored for @me:server1 (DEVICE1) via https://server4',
    );
  });

  it('numbers every signed-in account as me and replaces bare server names', () => {
    const redactor = createLogRedactor({
      selfUserIds: [ALICE, '@alice:work.example'],
      selfDeviceIds: [OWN_DEVICE, 'ASDFGHJKLZ'],
      homeserverUrls: [
        CORPUS_CONTEXT.homeserverUrls[0],
        'https://work.example',
      ],
    });

    expect(
      redactor.redact(
        `switching from ${ALICE} to @alice:work.example on https://work.example`,
      ),
    ).toBe('switching from @me:server1 to @me2:server2 on https://server2');
    expect(
      redactor.redact(
        'device ASDFGHJKLZ of @alice:work.example and example.org mentioned plainly; matrix.example.org too',
      ),
    ).toBe(
      'device DEVICE2 of @me2:server2 and server1 mentioned plainly; server3 too',
    );
  });

  it('handles a test homeserver on localhost with a mixed-case device ID', () => {
    const redactor = createLogRedactor({
      selfUserIds: ['@keyexp-run1:localhost'],
      selfDeviceIds: ['aB3dE9xYz1'],
      homeserverUrls: ['http://localhost:8008'],
    });

    expect(
      redactor.redact(
        'FetchHttpApi: --> GET http://localhost:8008/_matrix/client/v3/rooms/%21abcDEF%3Alocalhost/messages and device aB3dE9xYz1, user @keyexp-run1:localhost',
      ),
    ).toBe(
      'FetchHttpApi: --> GET http://server1/_matrix/client/v3/rooms/%21room1%3Aserver1/messages and device DEVICE1, user @me:server1',
    );
  });

  it('also redacts an event ID printed in a request path', () => {
    expect(
      createLogRedactor(CORPUS_CONTEXT).redact(
        'GET /rooms/%21abc%3Aexample.org/event/%24' + EVENT.slice(1),
      ),
    ).not.toContain(EVENT.slice(1));
  });

  describe('adversarial 64 KB inputs', () => {
    const SIZE = 64 * 1024;
    const inputs: readonly (readonly [string, string])[] = [
      ['at signs', '@'.repeat(SIZE)],
      ['bangs', '!'.repeat(SIZE)],
      ['colons', ':'.repeat(SIZE)],
      ['dots', '.'.repeat(SIZE)],
      ['encoded colons', '%3A'.repeat(SIZE / 3)],
      ['encoded at', '%40'.repeat(SIZE / 3)],
      ['hyphens', '-'.repeat(SIZE)],
      ['dotted labels', 'a.'.repeat(SIZE / 2)],
      ['user then dots', '@a:' + 'a.'.repeat(SIZE / 2)],
      ['user with long local part', '@' + 'a'.repeat(SIZE) + ':'],
      ['repeated users', '@a:b.'.repeat(SIZE / 5)],
      ['bang runs', '!a:'.repeat(SIZE / 3)],
      ['bang opaque', '!' + 'a.'.repeat(SIZE / 2)],
      ['encoded bangs', '!a%3A'.repeat(SIZE / 5)],
      ['alias runs', '#a:'.repeat(SIZE / 3)],
      ['dollar runs', '$a'.repeat(SIZE / 2)],
      ['hyphenated words', 'ab-'.repeat(SIZE / 3)],
      ['device fields', 'deviceId:'.repeat(SIZE / 9)],
      ['urls', 'https://a.'.repeat(SIZE / 10)],
      ['mxc', 'mxc://a/'.repeat(SIZE / 8)],
    ];

    it.each(inputs)('redacts %s in under 200 ms', (_name, input) => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      const start = performance.now();
      redactor.redact(input);
      expect(performance.now() - start).toBeLessThan(200);
    });
  });
});
