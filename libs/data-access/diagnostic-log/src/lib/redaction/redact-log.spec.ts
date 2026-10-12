import { describe, expect, it } from 'vitest';
import { createLogRedactor } from './redact-log';
import {
  ALICE,
  BOB,
  CORPUS_CONTEXT,
  EVENT,
  OWN_DEVICE,
  REDACTION_CORPUS,
  ROOM,
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

  describe('device IDs in free text', () => {
    const redact = (text: string): string =>
      createLogRedactor(CORPUS_CONTEXT).redact(text);

    it.each([
      ['MAS device AB3DE9XYZ1 logged in', 'MAS device DEVICE2 logged in'],
      [
        'devices: QWERTYUIOP, CD4FG8HIJ2 in a list',
        'devices: DEVICE1, DEVICE2 in a list',
      ],
      ['{"deviceId":"abcdefghij"}', '{"deviceId":"DEVICE2"}'],
      ['device_id=abcdefghij', 'device_id=DEVICE2'],
      ['"device_id":"Abcdefghijkl"', '"device_id":"DEVICE2"'],
      ['device-id: abcdefghij', 'device-id: DEVICE2'],
      [
        'devices: ["abcdefghij", "Abcdefghijkl"]',
        'devices: ["DEVICE2", "DEVICE3"]',
      ],
      ['Device abcdefghijklmnop removed', 'Device DEVICE2 removed'],
      ['new device Phone_Pixel7 added', 'new device DEVICE2 added'],
      ['device AB3DE9XYZ1', 'device DEVICE2'],
      ['device abcdefghijklmnop', 'device DEVICE2'],
      ['{"device_id":"AB3DE9XYZ1"}', '{"device_id":"DEVICE2"}'],
      ['devices: [abcdefghij, ZXCVBNMASD]', 'devices: [DEVICE2, DEVICE3]'],
      [
        '"devices":["ABCDEFGHIJ","abcdefghij"]',
        '"devices":["DEVICE2","DEVICE3"]',
      ],
      ['devices: [ABCDEFGHIJ] updated', 'devices: [DEVICE2] updated'],
      ['session for deviceId=Zx9Kq2Lm4P ok', 'session for deviceId=DEVICE2 ok'],
    ])('redacts the ID in %s', (line, expected) => {
      expect(redact(line)).toBe(expected);
    });

    it.each([
      'CONNECTING ENCRYPTION KEYBACKUP started',
      'sendToDevice: sending m.room_key_request',
      'the device is fine',
      'device verification requested',
      'device tracking enabled',
      'device signing keys uploaded',
      'device information not available',
      'Upload device signatures failed',
      'device announcement received',
      'device deleted',
      'Ignoring unknown device initialising',
      'device notifications muted',
      'device registrations pending',
      'device list changes',
      'Got devices list from server',
      'devices: 3 updated',
      'devices tracked: 5, outdated: 2',
    ])('leaves ordinary words alone in %s', (line) => {
      expect(redact(line)).toBe(line);
    });

    it('keeps prose after a plural keyword and redacts only the user', () => {
      expect(redact('devices changed for @bob:x.org')).toBe(
        'devices changed for @user1:server3',
      );
    });

    it('keeps known own device IDs redacted anywhere', () => {
      expect(redact(`session ${OWN_DEVICE} started`)).toBe(
        'session DEVICE1 started',
      );
    });
  });

  describe('server names', () => {
    it('learns every identifier in a text without producing output', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      const result: void = redactor.learn(`first line\nupdate ${BOB} here`);

      expect(result).toBeUndefined();
      expect(redactor.redact('connecting to other.net now')).toBe(
        'connecting to server3 now',
      );
    });

    it('replaces a bare name seen before any identifier once the file was learned', () => {
      const lines = ['connecting to other.net now', `later ${BOB}`];
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      redactor.learn(lines.join('\n'));

      expect(lines.map((line) => redactor.redact(line))).toEqual([
        'connecting to server3 now',
        'later @user1:server3',
      ]);
    });

    it('redacts a sub-host of a known server as a whole', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);

      expect(redactor.redact(`${BOB} via sub.other.net and other.net`)).toBe(
        '@user1:server3 via server4 and server3',
      );
      expect(redactor.redact('again sub.other.net')).toBe('again server4');
    });

    it('does not treat an unrelated suffix as a known server', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      redactor.redact(BOB);

      expect(redactor.redact('notother.net and other.network')).toBe(
        'notother.net and other.network',
      );
    });

    it.each([
      ['https://user:pw@other.net/x', 'https://<redacted>@server3/x'],
      ['https://user@other.net/x', 'https://<redacted>@server3/x'],
      ['wss://u:p%40w@other.net:8448/x', 'wss://<redacted>@server3/x'],
    ])('removes userinfo from %s', (url, expected) => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      redactor.redact(BOB);

      expect(redactor.redact(url)).toBe(expected);
    });

    it('replaces internationalised server names whole', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);

      expect(
        redactor.redact('@bob:bücher.example visited bücher.example'),
      ).toBe('@user1:server3 visited server3');
      expect(redactor.redact('https://bücher.example/x')).toBe(
        'https://server3/x',
      );
    });

    it('maps a signed-in account with a port to the same placeholder', () => {
      const redactor = createLogRedactor({
        selfUserIds: ['@alice:example.org:8448'],
        selfDeviceIds: [],
        homeserverUrls: [],
      });

      expect(
        redactor.redact('@alice:example.org:8448 and @alice:example.org'),
      ).toBe('@me:server1 and @me:server1');
    });

    it('replaces IPv6 server names in user IDs', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);

      expect(redactor.redact('@bob:[2001:db8::1]:8448 joined')).toBe(
        '@user1:server3 joined',
      );
    });
  });

  describe('email addresses', () => {
    it('replaces each address with a stable placeholder', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);

      expect(
        redactor.redact(
          'threepid alice.smith+test@mail.example.com added; mailto:bob@other.net',
        ),
      ).toBe(
        'threepid email1@example.invalid added; mailto:email2@example.invalid',
      );
      expect(redactor.redact('again: Alice.Smith+test@MAIL.example.com')).toBe(
        'again: email1@example.invalid',
      );
    });

    it('leaves Matrix IDs and URLs with userinfo to their own rules', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);

      expect(
        redactor.redact(
          `${ALICE} invited ${BOB} via https://user:pw@other.net/x and ${ROOM}`,
        ),
      ).toBe(
        '@me:server1 invited @user1:server3 via https://<redacted>@server3/x and !room1:server1',
      );
    });

    it('keeps package versions and addresses without a top-level domain', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);

      expect(redactor.redact('rxjs@7.8.1 root@localhost')).toBe(
        'rxjs@7.8.1 root@localhost',
      );
    });
  });

  describe('known names', () => {
    const NAMES = {
      roomNames: ['Team Alpha Ops', 'Alpha', 'sync', 'Qa', 'Error'],
      roomTopics: ['Where the alpha team plans releases'],
      displayNames: ['Alice Liddell', 'Bob', 'alice', 'Charlie'],
    };

    function namedRedactor() {
      return createLogRedactor({ ...CORPUS_CONTEXT, knownNames: NAMES });
    }

    it('replaces room names, topics and display names with stable placeholders', () => {
      const redactor = namedRedactor();

      expect(
        redactor.redact(
          'Room "Alpha" topic "Where the alpha team plans releases" member Alice Liddell',
        ),
      ).toBe('Room "Room 1" topic "Topic 1" member Person 1');
      expect(redactor.redact('Alice Liddell left Alpha; Bob stayed')).toBe(
        'Person 1 left Room 1; Person 2 stayed',
      );
    });

    it('prefers the longest name at a position', () => {
      expect(namedRedactor().redact('in Team Alpha Ops and in Alpha')).toBe(
        'in Room 1 and in Room 2',
      );
    });

    it('takes the leftmost of overlapping names', () => {
      const redactor = createLogRedactor({
        ...CORPUS_CONTEXT,
        knownNames: {
          roomNames: ['Night Shift'],
          roomTopics: [],
          displayNames: ['Shift Lead'],
        },
      });

      expect(redactor.redact('Night Shift Lead; Shift Lead')).toBe(
        'Room 1 Lead; Person 1',
      );
    });

    it('skips short names and names that are log vocabulary', () => {
      expect(namedRedactor().redact('sync Error Qa: retrying')).toBe(
        'sync Error Qa: retrying',
      );
    });

    it('runs after the identifier rules, so a name equal to a localpart keeps the ID', () => {
      expect(namedRedactor().redact(`${ALICE} is alice`)).toBe(
        '@me:server1 is Person 1',
      );
    });

    it('numbers names by first appearance, the same way for every redactor', () => {
      const lines = [
        'Charlie joined Team Alpha Ops',
        'Bob and Charlie',
        'contact charlie@example.org',
      ];
      const first = namedRedactor();
      const second = namedRedactor();

      const output = lines.map((line) => first.redact(line));

      expect(output).toEqual([
        'Person 1 joined Room 1',
        'Person 2 and Person 1',
        'contact email1@example.invalid',
      ]);
      expect(lines.map((line) => second.redact(line))).toEqual(output);
    });

    it('numbers names learned before the first line is written', () => {
      const redactor = namedRedactor();
      redactor.learn('Bob\nCharlie');

      expect(redactor.redact('Charlie, then Bob')).toBe(
        'Person 2, then Person 1',
      );
    });
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
      ['quoted device lists', '"devices",'.repeat(SIZE / 10)],
      ['long device list', 'devices: [' + 'abcdefgh, '.repeat(SIZE / 10)],
      ['urls', 'https://a.'.repeat(SIZE / 10)],
      ['mxc', 'mxc://a/'.repeat(SIZE / 8)],
      ['userinfo', 'https://' + 'a:'.repeat(SIZE / 2)],
      ['userinfo at signs', 'https://a@'.repeat(SIZE / 10)],
      ['device words', 'device '.repeat(SIZE / 7)],
      ['device ids', 'device abcdefg '.repeat(SIZE / 15)],
      ['unicode labels', 'bücher.'.repeat(SIZE / 7)],
      [
        'sub-hosts of a known name',
        'a.'.repeat(SIZE / 2) + 'matrix.example.org',
      ],
      ['ipv6 users', '@a:[::1'.repeat(SIZE / 7)],
    ];

    it.each([
      ['emails', 'a@b.'.repeat(SIZE / 4)],
      ['long local parts', 'a'.repeat(SIZE - 6) + '@b.cc1'],
      ['dotted domain', 'a@' + 'b.'.repeat(SIZE / 2)],
      ['plus runs', '+'.repeat(SIZE) + '@x.org'],
    ])('redacts %s in under 500 ms', (_name, input) => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      const start = performance.now();
      redactor.redact(input);
      expect(performance.now() - start).toBeLessThan(500);
    });

    describe('with thousands of known names', () => {
      // Nested names ("aaab", "aaaab", ...) are the worst case for a naive scan: every
      // position of a run of "a" starts a long partial match.
      const nested = Array.from(
        { length: 2_000 },
        (_, n) => `${'a'.repeat(n + 3)}b`,
      );
      const words = Array.from(
        { length: 5_000 },
        (_, n) => `Person ${n.toString(36)} Example`,
      );
      const knownNames = {
        roomNames: nested,
        roomTopics: words.slice(0, 1_000),
        displayNames: words,
      };
      const named: readonly (readonly [string, string])[] = [
        ['a run of one letter', 'a'.repeat(SIZE)],
        ['near misses', 'aaaaab'.repeat(SIZE / 6)],
        ['real names', words.slice(0, 3_000).join(' ').slice(0, SIZE)],
        ['spaces', ' '.repeat(SIZE)],
      ];

      it('builds its matcher in under 500 ms', () => {
        const start = performance.now();
        createLogRedactor({ ...CORPUS_CONTEXT, knownNames }).redact('x');
        expect(performance.now() - start).toBeLessThan(500);
      });

      it.each(named)('redacts %s in under 500 ms', (_name, input) => {
        const redactor = createLogRedactor({ ...CORPUS_CONTEXT, knownNames });
        redactor.redact('warm-up');
        const start = performance.now();
        redactor.redact(input);
        expect(performance.now() - start).toBeLessThan(500);
      });
    });

    it.each(inputs)('redacts %s in under 500 ms', (_name, input) => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      const start = performance.now();
      redactor.redact(input);
      expect(performance.now() - start).toBeLessThan(500);
    });
  });
});
