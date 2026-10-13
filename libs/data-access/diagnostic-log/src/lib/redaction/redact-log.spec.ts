import { describe, expect, it } from 'vitest';
import type { DiagnosticNameGroup } from '../report-facts';
import { runToEnd } from '../report/run-in-slices';
import { MAX_DISPLAY_NAMES_PER_GROUP, MAX_NAMES } from './known-names';
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

  describe('device IDs after a user ID', () => {
    // The crypto store is named `trinity-crypto:<user ID>:<device ID>`, and the SDK logs that
    // name each time it opens a store. A device ID that starts with digits must not be read
    // as the user's server port.
    const SELF = '@bugreport-run:localhost';
    const context = (deviceIds: readonly string[]) => ({
      selfUserIds: [SELF],
      selfDeviceIds: deviceIds,
      homeserverUrls: ['http://localhost:8008'],
    });
    const storeLine = (userId: string, deviceId: string): string =>
      `IndexedDbCryptoStore: opening main store trinity-crypto:${userId}:${deviceId}::matrix-sdk-crypto`;
    /** Every three-character run of an ID: none may survive, whatever replaced it. */
    const fragments = (id: string): string[] =>
      Array.from({ length: id.length - 2 }, (_, start) =>
        id.slice(start, start + 3),
      );

    it('redacts the whole digit-led device ID in a crypto store name', () => {
      const deviceId = '1GncS3LIxD';
      const redactor = createLogRedactor(context([deviceId]));

      const redacted = redactor.redact(storeLine(SELF, deviceId));

      expect(redacted).toBe(
        'IndexedDbCryptoStore: opening main store trinity-crypto:@me:server1:DEVICE1::matrix-sdk-crypto',
      );
      expect(redacted).not.toContain('GncS3LIxD');
    });

    it.each([
      '1GncS3LIxD',
      '2bcDEF4ghi',
      '9ZyXwVuTsR',
      '0aB3dE9xYz',
      '1234567890',
    ])('redacts all of %s, known or not', (deviceId) => {
      const expected =
        'IndexedDbCryptoStore: opening main store trinity-crypto:@me:server1:DEVICE1::matrix-sdk-crypto';

      for (const deviceIds of [[deviceId], []]) {
        const redacted = createLogRedactor(context(deviceIds)).redact(
          storeLine(SELF, deviceId),
        );
        expect(redacted).toBe(expected);
        for (const fragment of fragments(deviceId)) {
          expect(redacted).not.toContain(fragment);
        }
      }
    });

    it('redacts a digit-led device ID after another user', () => {
      expect(
        createLogRedactor(context([])).redact(
          storeLine('@bob:other.net', '7GncS3LIxD'),
        ),
      ).toBe(
        'IndexedDbCryptoStore: opening main store trinity-crypto:@user1:server2:DEVICE1::matrix-sdk-crypto',
      );
    });

    it('still reads a real port as part of the server', () => {
      const redactor = createLogRedactor(context([]));

      expect(redactor.redact('@user:host:8448 joined')).toBe(
        '@user1:server2 joined',
      );
      expect(redactor.redact('invited @user:host:8448.')).toBe(
        'invited @user1:server2.',
      );
      expect(redactor.redact(storeLine('@user:host:8448', 'ABCDEFGHIJ'))).toBe(
        'IndexedDbCryptoStore: opening main store trinity-crypto:@user1:server2:DEVICE1::matrix-sdk-crypto',
      );
      expect(redactor.redact('!abc:host:8448 and #room:host:8448')).toBe(
        '!room1:server2 and #alias1:server2',
      );
      expect(redactor.redact('$abc123:host:8448 sent')).toBe('$event1 sent');
      expect(redactor.redact('mxc://host:8448/AbCdEfGhIj')).toBe(
        'mxc://server2/media1',
      );
      expect(redactor.redact('https://host:8448 answered')).toBe(
        'https://server2 answered',
      );
      expect(redactor.redact('from @user:host:8448')).toBe(
        'from @user1:server2',
      );
    });

    it('keeps a URL port that runs into a word apart from the host', () => {
      const deviceId = '1GncS3LIxD';
      const redactor = createLogRedactor(context([deviceId]));

      expect(redactor.redact(`https://localhost:${deviceId}/x`)).toBe(
        'https://server1:DEVICE1/x',
      );
      expect(redactor.redact('https://host:8448abc/x')).toBe(
        'https://server2:8448abc/x',
      );
    });

    it('removes a short all-digit device ID even when it reads as a port', () => {
      for (const deviceId of ['1', '42', '12345']) {
        const redacted = createLogRedactor(context([deviceId])).redact(
          storeLine(SELF, deviceId),
        );

        expect(redacted).toBe(
          'IndexedDbCryptoStore: opening main store trinity-crypto:@me:server1::matrix-sdk-crypto',
        );
      }
    });

    it('gives every mention of a known digit-led device ID the same placeholder', () => {
      const deviceId = '1GncS3LIxD';
      const redactor = createLogRedactor(context([deviceId]));

      expect(redactor.redact(storeLine(SELF, deviceId))).toContain(
        ':@me:server1:DEVICE1::',
      );
      expect(redactor.redact(`session ${deviceId} started`)).toBe(
        'session DEVICE1 started',
      );
      expect(redactor.redact(`device ${deviceId} verified by ${SELF}`)).toBe(
        'device DEVICE1 verified by @me:server1',
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

    it('keeps an address placeholder intact after a device keyword', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);

      expect(
        redactor.redact('devices: alice@example.org, mxc://x.org/abc'),
      ).toBe('devices: email1@example.invalid, mxc://server3/media1');
    });

    it('keeps package versions and addresses without a top-level domain', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);

      expect(redactor.redact('rxjs@7.8.1 root@localhost')).toBe(
        'rxjs@7.8.1 root@localhost',
      );
    });
  });

  describe('known names', () => {
    const NAMES: DiagnosticNameGroup = {
      roomNames: ['Team Alpha Ops', 'Alpha', 'sync', 'Qa', 'Error'],
      roomTopics: ['Where the alpha team plans releases'],
      displayNames: ['Alice Liddell', 'Bob', 'alice', 'Charlie'],
    };

    /** A redactor that has learned `log`, then the names, as the bundle builder does. */
    function namedRedactor(
      log: readonly string[],
      groups: readonly DiagnosticNameGroup[] = [NAMES],
    ) {
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      for (const line of log) {
        redactor.learn(line);
      }
      runToEnd(redactor.learnNames(groups));
      return redactor;
    }

    function redactLog(
      log: readonly string[],
      groups: readonly DiagnosticNameGroup[] = [NAMES],
    ): string[] {
      const redactor = namedRedactor(log, groups);
      return log.map((line) => redactor.redact(line));
    }

    const rooms = (...roomNames: string[]): DiagnosticNameGroup => ({
      roomNames,
      roomTopics: [],
      displayNames: [],
    });
    const people = (...displayNames: string[]): DiagnosticNameGroup => ({
      roomNames: [],
      roomTopics: [],
      displayNames,
    });

    it('replaces room names, topics and display names with stable placeholders', () => {
      expect(
        redactLog([
          'Room "Alpha" topic "Where the alpha team plans releases" member Alice Liddell',
          'Alice Liddell left Alpha; Bob stayed',
        ]),
      ).toEqual([
        'Room "Room 1" topic "Topic 1" member Person 1',
        'Person 1 left Room 1; Person 2 stayed',
      ]);
    });

    it('prefers the longest name at a position', () => {
      expect(redactLog(['in Team Alpha Ops and in Alpha'])).toEqual([
        'in Room 1 and in Room 2',
      ]);
    });

    it('takes the leftmost of overlapping names', () => {
      expect(
        redactLog(
          ['Night Shift Lead; Shift Lead'],
          [rooms('Night Shift'), people('Shift Lead')],
        ),
      ).toEqual(['Room 1 Lead; Person 1']);
    });

    it('skips short names and names that are log vocabulary', () => {
      expect(redactLog(['sync Error Qa: retrying'])).toEqual([
        'sync Error Qa: retrying',
      ]);
    });

    it('runs after the identifier rules, so a name equal to a localpart keeps the ID', () => {
      expect(redactLog([`${ALICE} is alice`])).toEqual([
        '@me:server1 is Person 1',
      ]);
    });

    it('numbers names by first appearance, the same way for every redactor', () => {
      const log = [
        'Charlie joined Team Alpha Ops',
        'Bob and Charlie',
        'contact charlie@example.org',
      ];

      const output = redactLog(log);

      expect(output).toEqual([
        'Person 1 joined Room 1',
        'Person 2 and Person 1',
        'contact email1@example.invalid',
      ]);
      expect(redactLog(log)).toEqual(output);
    });

    it('registers only the names that occur in the learned log', () => {
      const redactor = namedRedactor(['Alice Liddell was here']);

      expect(redactor.redact('Bob and Alice Liddell')).toBe('Bob and Person 1');
    });

    it('does not take a name that occurs only inside a Matrix ID', () => {
      const redactor = namedRedactor([`${ALICE} joined`], [people('alice')]);

      expect(redactor.redact('alice')).toBe('alice');
    });

    it('takes every room name and topic before any display name', () => {
      const members = Array.from(
        { length: MAX_NAMES },
        (_, n) => `Member ${n}`,
      );
      const groups = Array.from(
        { length: MAX_NAMES / MAX_DISPLAY_NAMES_PER_GROUP },
        (_, group) =>
          people(
            ...members.slice(
              group * MAX_DISPLAY_NAMES_PER_GROUP,
              (group + 1) * MAX_DISPLAY_NAMES_PER_GROUP,
            ),
          ),
      );
      const log = [members.join(', '), 'opened Late Room'];

      const redacted = redactLog(log, [...groups, rooms('Late Room')]);

      expect(redacted[1]).toBe('opened Room 1');
    });

    it('reports whether every name it could have taken was taken', () => {
      const names = Array.from(
        { length: MAX_DISPLAY_NAMES_PER_GROUP + 1 },
        (_, n) => `Member ${n}`,
      );
      const capped = createLogRedactor(CORPUS_CONTEXT);
      capped.learn(names.join(', '));
      const whole = createLogRedactor(CORPUS_CONTEXT);
      whole.learn(names.join(', '));

      expect(runToEnd(capped.learnNames([people(...names)]))).toEqual({
        complete: false,
      });
      // Exactly the cap, then names already taken: nothing is left out.
      expect(
        runToEnd(
          whole.learnNames([people(...names.slice(1), names[1], names[2])]),
        ),
      ).toEqual({ complete: true });
    });

    it('keeps the names read before a source failed, and says the reading is incomplete', () => {
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      redactor.learn('Garden Club with Alice Liddell');
      function* failing() {
        yield { ...rooms('Garden Club'), displayNames: ['Alice Liddell'] };
        throw new Error('client stopped');
      }

      expect(runToEnd(redactor.learnNames(failing()))).toEqual({
        complete: false,
      });
      expect(redactor.redact('Garden Club with Alice Liddell')).toBe(
        'Room 1 with Person 1',
      );
    });

    it('pauses while it reads many names', () => {
      const names = Array.from({ length: 2_000 }, (_, n) => `Member ${n}`);
      const redactor = createLogRedactor(CORPUS_CONTEXT);
      redactor.learn(names.join(', '));
      const steps = redactor.learnNames(
        [0, 1, 2, 3].map((group) =>
          people(...names.slice(group * 500, group * 500 + 500)),
        ),
      );
      let pauses = 0;
      while (!steps.next().done) {
        pauses += 1;
      }

      expect(pauses).toBeGreaterThan(10);
      expect(redactor.redact('Member 1999 left')).toBe('Person 1 left');
    });

    it('takes at most a capped number of display names from one room', () => {
      const names = Array.from(
        { length: MAX_DISPLAY_NAMES_PER_GROUP + 50 },
        (_, n) => `Member ${n}`,
      );
      const line = names.join(', ');

      const [redacted] = redactLog([line], [people(...names)]);

      expect(redacted.match(/Person \d+/g)).toHaveLength(
        MAX_DISPLAY_NAMES_PER_GROUP,
      );
    });

    describe('names that contain identifiers', () => {
      it.each([
        ['Ops at example.org', 'joined Ops at example.org today'],
        ['matrix.example.org Admins', 'matrix.example.org Admins changed'],
        [`Chat with ${BOB}`, `opened Chat with ${BOB} now`],
        ['Device ABCDEFGHIJ room', 'Device ABCDEFGHIJ room is quiet'],
        [`Phone ${OWN_DEVICE} Club`, `Phone ${OWN_DEVICE} Club rang`],
      ])('replaces %s whole', (name, line) => {
        const [redacted] = redactLog([line], [rooms(name)]);

        expect(redacted).toMatch(/^\w* ?Room 1/);
        for (const word of name.split(/[\s@:.]+/)) {
          if (word.length > 2) {
            expect(redacted).not.toContain(word);
          }
        }
      });
    });

    describe('long topics', () => {
      it('replaces a topic longer than one chunk whole', () => {
        const topic = `Long topic ${'with many words '.repeat(60)}and a tail end`;

        expect(
          redactLog(
            [`topic: ${topic}.`],
            [{ ...people(), roomTopics: [topic] }],
          ),
        ).toEqual(['topic: Topic 1.']);
      });

      it('never splits a character that takes two code units', () => {
        const topic = `${'x'.repeat(511)}🌱${'y'.repeat(600)}`;

        const [redacted] = redactLog(
          [`[${topic}]`],
          [{ ...people(), roomTopics: [topic] }],
        );

        expect(redacted).toBe('[Topic 1]');
      });

      it('replaces a line quoted alone from a multi-line topic', () => {
        const topic = 'Planning for spring\nBring your notes along';

        expect(
          redactLog(
            ['b: Bring your notes along'],
            [{ ...people(), roomTopics: [topic] }],
          ),
        ).toEqual(['b: Topic 1']);
      });

      it.each([20, 100, 513, 700, 1_100])(
        'replaces a topic logged cut at %i characters',
        (length) => {
          const topic = `Long topic ${'with many words '.repeat(80)}and a tail end`;
          const log = [`whole: ${topic}.`, `cut: ${topic.slice(0, length)}…`];

          expect(
            redactLog(log, [{ ...people(), roomTopics: [topic] }]),
          ).toEqual(['whole: Topic 1.', 'cut: Topic 1…']);
        },
      );

      it.each([
        [
          'Failed to decrypt? Verify this session first',
          'Failed to decrypt event 42',
        ],
        [
          'Starting the synchronisation of all rooms',
          'Starting the synchroniser now',
        ],
        [
          'Failed to decrypt? Verify this session first',
          'Failed to decrypt: OlmError',
        ],
        [
          'Failed to decrypt? Verify this session first',
          'Failed to decrypt, retrying',
        ],
      ])(
        'leaves a line that only begins like the topic %j alone',
        (topic, line) => {
          expect(
            redactLog(
              [`full: ${topic}`, line],
              [{ ...people(), roomTopics: [topic] }],
            ),
          ).toEqual(['full: Topic 1', line]);
        },
      );

      it('still replaces a name inside a line it declined as the topic', () => {
        const topic = 'Meeting with Alice about the budget';

        expect(
          redactLog(
            [`full: ${topic}`, 'Meeting with Alice Liddell today'],
            [{ ...people('Alice Liddell'), roomTopics: [topic] }],
          ),
        ).toEqual(['full: Topic 1', 'Meeting with Person 1 today']);
      });

      it.each([
        [
          'a quote',
          'topic: "Starting the synchronisation"',
          'topic: "Topic 1"',
        ],
        ['a bracket', '[Starting the synchronisation]', '[Topic 1]'],
        ['an ellipsis', 'Starting the synchronisation…', 'Topic 1…'],
        [
          'the end of the line',
          'was: Starting the synchronisation',
          'was: Topic 1',
        ],
      ])('replaces a topic cut before %s', (_mark, line, expected) => {
        const topic = 'Starting the synchronisation of all rooms';

        expect(
          redactLog([line], [{ ...people(), roomTopics: [topic] }]),
        ).toEqual([expected]);
      });

      it('replaces a topic that the capture cut short', () => {
        const topic = 'Starting the synchronisation of all rooms';

        expect(
          redactLog(
            [`${topic.slice(0, 30)}… [11 characters truncated]`],
            [{ ...people(), roomTopics: [topic] }],
          ),
        ).toEqual(['Topic 1… [11 characters truncated]']);
      });

      it('maps every line of a multi-line topic to one placeholder', () => {
        const topic = 'Planning for spring\nBring your notes along';

        expect(
          redactLog(
            [
              'a: Planning for spring',
              'b: Bring your notes along',
              `c: ${topic}`,
            ],
            [{ ...people(), roomTopics: [topic] }],
          ),
        ).toEqual(['a: Topic 1', 'b: Topic 1', 'c: Topic 1']);
      });
    });

    describe('word boundaries', () => {
      it('matches a name only as whole words', () => {
        expect(
          redactLog(
            ['DevTools Timeline brother; Dev met Tim'],
            [rooms('Dev'), people('Tim', 'other')],
          ),
        ).toEqual(['DevTools Timeline brother; Room 1 met Person 1']);
      });

      it('falls back to a shorter name when the longer one ends inside a word', () => {
        expect(
          redactLog(
            ['Alpha Better', 'Alpha Bet.'],
            [rooms('Alpha', 'Alpha Bet')],
          ),
        ).toEqual(['Room 1 Better', 'Room 2.']);
      });

      it('matches names in scripts written without spaces inside text', () => {
        expect(redactLog(['进入开发团队了'], [rooms('开发团队')])).toEqual([
          '进入Room 1了',
        ]);
      });

      it('never matches inside a placeholder already written', () => {
        expect(
          redactLog(
            [`${ALICE} wrote to a@b.org; erver and example agreed`],
            [people('erver', 'example', 'invalid')],
          ),
        ).toEqual([
          '@me:server1 wrote to email1@example.invalid; Person 1 and Person 2 agreed',
        ]);
      });
    });

    describe('escaped and normalised forms', () => {
      it('replaces a name escaped inside JSON', () => {
        expect(
          redactLog(['{"name":"Café \\"Noir\\""}'], [rooms('Café "Noir"')]),
        ).toEqual(['{"name":"Room 1"}']);
      });

      it('replaces a name escaped as JSON \\u escapes', () => {
        expect(
          redactLog(['{"name":"Caf\\u00e9 Noir"}'], [rooms('Café Noir')]),
        ).toEqual(['{"name":"Room 1"}']);
      });

      it('replaces a URL-encoded name next to a stray percent sign', () => {
        expect(
          redactLog(['GET /s?q=Caf%C3%A9%20Noir&p=100%'], [rooms('Café Noir')]),
        ).toEqual(['GET /s?q=Room 1&p=100%']);
      });

      it('replaces a name encoded in a URL', () => {
        expect(
          redactLog(['GET /search?q=Team%20Bravo&x=1'], [rooms('Team Bravo')]),
        ).toEqual(['GET /search?q=Room 1&x=1']);
      });

      it('replaces composed and decomposed spellings alike', () => {
        const composed = 'Zoë Night';
        const decomposed = composed.normalize('NFD');

        expect(
          redactLog([`${composed} and ${decomposed}`], [people(decomposed)]),
        ).toEqual(['Person 1 and Person 1']);
      });
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
      ['ports run into IDs', '@a:b:12345a'.repeat(SIZE / 11)],
      ['digits after a server', '@a:b:' + '1'.repeat(SIZE)],
      ['url ports run into words', 'https://a:1a'.repeat(SIZE / 12)],
      ['labels before a failed port', '@a:' + 'b.'.repeat(SIZE / 2) + 'c:1a '],
      [
        'repeated labels before a failed port',
        ('@a:' + 'b.'.repeat(30) + 'c:1a ').repeat(SIZE / 68),
      ],
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
      // Nested names of single-letter words ("a a a", "a a a a", ...) give every position of
      // "a a a ..." a long chain of shorter names to fall back through.
      const nested = Array.from({ length: 300 }, (_, n) =>
        Array.from({ length: n + 3 }, () => 'a').join(' '),
      );
      const words = Array.from(
        { length: 5_000 },
        (_, n) => `Person ${n.toString(36)} Example`,
      );
      const groups: DiagnosticNameGroup[] = [
        {
          roomNames: nested,
          roomTopics: words.slice(0, 1_000),
          displayNames: [],
        },
        ...Array.from({ length: 10 }, (_, n) => ({
          roomNames: [],
          roomTopics: [],
          displayNames: words.slice(n * 500, n * 500 + 500),
        })),
      ];
      const named: readonly (readonly [string, string])[] = [
        ['single-letter words', 'a '.repeat(SIZE / 2)],
        ['a run of one letter', 'a'.repeat(SIZE)],
        ['near misses', 'aaaaab '.repeat(SIZE / 7)],
        ['real names', words.slice(0, 3_000).join(' ').slice(0, SIZE)],
        ['spaces', ' '.repeat(SIZE)],
      ];

      it.each(named)('learns names for %s in under 500 ms', (_name, input) => {
        const redactor = createLogRedactor(CORPUS_CONTEXT);
        redactor.learn(input);
        const start = performance.now();
        runToEnd(redactor.learnNames(groups));
        expect(performance.now() - start).toBeLessThan(500);
      });

      it.each(named)('redacts %s in under 500 ms', (_name, input) => {
        const redactor = createLogRedactor(CORPUS_CONTEXT);
        redactor.learn(input);
        runToEnd(redactor.learnNames(groups));
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
