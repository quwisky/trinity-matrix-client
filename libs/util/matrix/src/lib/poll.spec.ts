import {
  MatrixEvent as SdkEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import {
  buildPollView,
  isPollStart,
  pollEndContent,
  pollResponseContent,
  pollSignature,
  pollStartContent,
} from './poll';

const POLL_ID = '$poll';

function startEvent(
  question: string,
  options: string[],
  maxSelections: unknown = 1,
): MatrixEvent {
  return {
    getId: () => POLL_ID,
    getSender: () => '@me:hs',
    getType: () => 'm.poll.start',
    getTs: () => 0,
    isRedacted: () => false,
    replacingEvent: () => null,
    getOriginalContent: () => ({
      'm.poll.start': {
        question: { 'm.text': question },
        kind: 'm.poll.disclosed',
        max_selections: maxSelections,
        answers: options.map((text, i) => ({ id: `a${i}`, 'm.text': text })),
      },
    }),
  } as unknown as MatrixEvent;
}

function response(
  sender: string,
  answer: string | string[],
  ts: number,
  redacted = false,
): MatrixEvent {
  const answers = Array.isArray(answer) ? answer : [answer];
  return {
    getSender: () => sender,
    getTs: () => ts,
    isRedacted: () => redacted,
    replacingEvent: () => null,
    getOriginalContent: () => ({ 'm.poll.response': { answers } }),
  } as unknown as MatrixEvent;
}

function endEvent(
  ts: number,
  redacted = false,
  sender = '@me:hs',
): MatrixEvent {
  return {
    getId: () => `$end-${sender}-${ts}`,
    getSender: () => sender,
    getTs: () => ts,
    isRedacted: () => redacted,
    getContent: () => ({ 'm.poll.end': {} }),
  } as unknown as MatrixEvent;
}

/** A room whose reference relations serve the given responses / end events by type. */
function room(
  responses: MatrixEvent[],
  ends: MatrixEvent[] = [],
  moderators: string[] = [],
  { unstableEnds = [] as MatrixEvent[], hasState = true } = {},
): Room {
  return {
    getLiveTimeline: () => ({
      getState: () =>
        hasState
          ? {
              maySendRedactionForEvent: (_event: MatrixEvent, user: string) =>
                moderators.includes(user),
            }
          : undefined,
    }),
    relations: {
      getChildEventsForEvent: (
        _id: string,
        relType: string,
        evType: string,
      ) => {
        if (relType !== 'm.reference') {
          return undefined;
        }
        const list =
          evType === 'm.poll.response'
            ? responses
            : evType === 'm.poll.end'
              ? ends
              : evType === 'org.matrix.msc3381.poll.end'
                ? unstableEnds
                : [];
        return list.length ? { getRelations: () => list } : undefined;
      },
    },
  } as unknown as Room;
}

const client = { getUserId: () => '@me:hs' } as unknown as MatrixClient;

describe('isPollStart', () => {
  it('recognises a poll-start event', () => {
    expect(isPollStart(startEvent('Q', ['A', 'B']))).toBe(true);
    expect(
      isPollStart({ getType: () => 'm.room.message' } as MatrixEvent),
    ).toBe(false);
  });
});

describe('buildPollView', () => {
  it('reads the question and answers', () => {
    const view = buildPollView(
      client,
      room([]),
      startEvent('Best fruit?', ['Apple', 'Pear']),
      false,
    );
    expect(view.question).toBe('Best fruit?');
    expect(view.options.map((o) => o.text)).toEqual(['Apple', 'Pear']);
    expect(view.totalVotes).toBe(0);
    expect(view.ended).toBe(false);
  });

  it('tallies votes, marks the local user’s choice, and counts total voters', () => {
    const view = buildPollView(
      client,
      room([
        response('@a:hs', 'a0', 10),
        response('@b:hs', 'a0', 11),
        response('@me:hs', 'a1', 12),
      ]),
      startEvent('Q', ['Apple', 'Pear']),
      false,
    );

    expect(view.options[0].votes).toBe(2);
    expect(view.options[1].votes).toBe(1);
    expect(view.options[1].chosen).toBe(true); // the local user picked a1
    expect(view.options[0].chosen).toBe(false);
    expect(view.totalVotes).toBe(3);
  });

  it('keeps only each voter’s latest response', () => {
    const view = buildPollView(
      client,
      room([response('@a:hs', 'a0', 10), response('@a:hs', 'a1', 20)]),
      startEvent('Q', ['Apple', 'Pear']),
      false,
    );
    expect(view.options[0].votes).toBe(0);
    expect(view.options[1].votes).toBe(1);
    expect(view.totalVotes).toBe(1);
  });

  it('ignores redacted and spoiled (unknown-answer) votes', () => {
    const view = buildPollView(
      client,
      room([
        response('@a:hs', 'a0', 10, true), // redacted
        response('@b:hs', 'nope', 11), // unknown answer id
        response('@c:hs', 'a1', 12), // valid
      ]),
      startEvent('Q', ['Apple', 'Pear']),
      false,
    );
    expect(view.totalVotes).toBe(1);
    expect(view.options[1].votes).toBe(1);
  });

  describe('who may end a poll', () => {
    const votes = [response('@a:hs', 'a0', 10)];
    const view = (r: Room) =>
      buildPollView(client, r, startEvent('Q', ['A', 'B']), false);

    it('ignores an end with no sender', () => {
      const anonymous = {
        ...endEvent(5),
        getSender: () => undefined,
      } as unknown as MatrixEvent;
      expect(view(room(votes, [anonymous])).ended).toBe(false);
    });

    it('with no live room state, counts only the poll sender', () => {
      const noState = { hasState: false };
      expect(
        view(room(votes, [endEvent(5, false, '@mod:hs')], ['@mod:hs'], noState))
          .ended,
      ).toBe(false);
      expect(view(room(votes, [endEvent(5)], [], noState)).ended).toBe(true);
    });

    it('judges ends of both namespaces together', () => {
      const bogusStable = endEvent(5, false, '@x:hs');
      const validUnstable = endEvent(20);
      const mixed = view(
        room(votes, [bogusStable], [], { unstableEnds: [validUnstable] }),
      );
      expect(mixed.ended).toBe(true);
      expect(mixed.totalVotes).toBe(1);
    });

    it('closes at the earliest valid end when they arrive out of order', () => {
      const out = view(room(votes, [endEvent(30), endEvent(5)]));
      expect(out.totalVotes).toBe(0);
    });

    it('ignores an end from another member without redaction power', () => {
      const view = buildPollView(
        client,
        room(votes, [endEvent(5, false, '@x:hs')]),
        startEvent('Q', ['A', 'B']),
        false,
      );
      expect(view.ended).toBe(false);
      expect(view.totalVotes).toBe(1);
    });

    it('accepts an end from the poll sender', () => {
      const view = buildPollView(
        client,
        room(votes, [endEvent(5)]),
        startEvent('Q', ['A', 'B']),
        false,
      );
      expect(view.ended).toBe(true);
      expect(view.totalVotes).toBe(0);
    });

    it('accepts an end from a member who may redact the poll', () => {
      const view = buildPollView(
        client,
        room(votes, [endEvent(5, false, '@mod:hs')], ['@mod:hs']),
        startEvent('Q', ['A', 'B']),
        false,
      );
      expect(view.ended).toBe(true);
    });

    it('closes at the valid end when an unauthorised one came first', () => {
      const view = buildPollView(
        client,
        room(votes, [endEvent(5, false, '@x:hs'), endEvent(20)]),
        startEvent('Q', ['A', 'B']),
        false,
      );
      expect(view.ended).toBe(true);
      expect(view.totalVotes).toBe(1);
    });
  });

  it('marks the poll ended and ignores votes cast after it closed', () => {
    const view = buildPollView(
      client,
      room(
        [response('@a:hs', 'a0', 10), response('@b:hs', 'a1', 30)], // second is post-close
        [endEvent(20)],
      ),
      startEvent('Q', ['Apple', 'Pear']),
      false,
    );
    expect(view.ended).toBe(true);
    expect(view.totalVotes).toBe(1);
    expect(view.options[0].votes).toBe(1);
    expect(view.options[1].votes).toBe(0);
  });

  it('does not throw when a hostile poll has a non-array `answers`', () => {
    // Attacker sends {"m.poll.start":{"answers":5}}: without a guard `.map` throws
    // and (via the timeline projection) takes down the whole room.
    const hostile = {
      getId: () => POLL_ID,
      getType: () => 'm.poll.start',
      getTs: () => 0,
      isRedacted: () => false,
      replacingEvent: () => null,
      getOriginalContent: () => ({
        'm.poll.start': { question: { 'm.text': 'Q' }, answers: 5 },
      }),
    } as unknown as MatrixEvent;

    const view = buildPollView(client, room([]), hostile, false);
    expect(view.options).toEqual([]);
    expect(view.question).toBe('Q');
  });

  it('counts every answer of a multi-select response', () => {
    const view = buildPollView(
      client,
      room([
        response('@me:hs', ['a0', 'a2'], 10),
        response('@b:hs', ['a0'], 11),
      ]),
      startEvent('Q', ['A', 'B', 'C'], 2),
      false,
    );
    expect(view.maxSelections).toBe(2);
    expect(view.options.map((o) => o.votes)).toEqual([2, 0, 1]);
    expect(view.options.map((o) => o.chosen)).toEqual([true, false, true]);
    expect(view.totalVotes).toBe(2); // voters, not selections
  });

  it('truncates a response to max_selections and ignores duplicate ids', () => {
    const view = buildPollView(
      client,
      room([response('@a:hs', ['a0', 'a0', 'a1', 'a2'], 10)]),
      startEvent('Q', ['A', 'B', 'C'], 2),
      false,
    );
    expect(view.options.map((o) => o.votes)).toEqual([1, 1, 0]);
  });

  it('spoils a response naming any unknown answer id', () => {
    const view = buildPollView(
      client,
      room([response('@a:hs', ['a0', 'nope'], 10)]),
      startEvent('Q', ['A', 'B'], 2),
      false,
    );
    expect(view.totalVotes).toBe(0);
    expect(view.options.map((o) => o.votes)).toEqual([0, 0]);
  });

  it('treats an empty latest response as withdrawing the vote', () => {
    const view = buildPollView(
      client,
      room([response('@a:hs', ['a0'], 10), response('@a:hs', [], 20)]),
      startEvent('Q', ['A', 'B'], 2),
      false,
    );
    expect(view.totalVotes).toBe(0);
    expect(view.options[0].votes).toBe(0);
  });

  it.each([
    [undefined, 1],
    ['3', 1],
    [0, 1],
    [-2, 1],
    [1.5, 1],
    [99, 3],
  ])('normalises max_selections %s to %s', (raw, expected) => {
    const view = buildPollView(
      client,
      room([]),
      startEvent('Q', ['A', 'B', 'C'], raw),
      false,
    );
    expect(view.maxSelections).toBe(expected);
  });

  it('caps the projected options at the MSC3381 limit (20)', () => {
    const many = Array.from({ length: 100 }, (_, i) => `opt${i}`);
    const view = buildPollView(client, room([]), startEvent('Q', many), false);
    expect(view.options).toHaveLength(20);
  });
});

describe('poll content builders', () => {
  it('builds a single-select disclosed poll start', () => {
    const content = pollStartContent('Best fruit?', [
      'Apple',
      'Pear',
    ]) as Record<string, Record<string, unknown>>;
    // Unstable namespace: FluffyChat (matrix-dart-sdk) only parses MSC3381/MSC1767 keys.
    const start = content['org.matrix.msc3381.poll.start'];
    expect(start['kind']).toBe('org.matrix.msc3381.poll.disclosed');
    expect(start['max_selections']).toBe(1);
    expect(start['question']).toEqual({
      'org.matrix.msc1767.text': 'Best fruit?',
      body: 'Best fruit?',
    });
    expect(start['answers']).toEqual([
      { id: 'a0', 'org.matrix.msc1767.text': 'Apple', body: 'Apple' },
      { id: 'a1', 'org.matrix.msc1767.text': 'Pear', body: 'Pear' },
    ]);
    expect(content['org.matrix.msc1767.text']).toContain('Best fruit?');
  });

  it('writes a user-defined max_selections', () => {
    const content = pollStartContent('Q', ['A', 'B', 'C'], 2) as Record<
      string,
      Record<string, unknown>
    >;
    expect(content['org.matrix.msc3381.poll.start']['max_selections']).toBe(2);
  });

  it('projects a poll it built itself, tallying a vote it built itself', () => {
    const start = {
      getId: () => POLL_ID,
      getType: () => 'org.matrix.msc3381.poll.start',
      isRedacted: () => false,
      replacingEvent: () => null,
      getOriginalContent: () => pollStartContent('Lunch?', ['Pizza', 'Sushi']),
    } as unknown as MatrixEvent;
    const vote = {
      getSender: () => '@me:hs',
      getTs: () => 1,
      isRedacted: () => false,
      replacingEvent: () => null,
      getOriginalContent: () => pollResponseContent(POLL_ID, ['a1']),
    } as unknown as MatrixEvent;
    const unstableRoom = {
      relations: {
        getChildEventsForEvent: (_id: string, _rel: string, type: string) =>
          type === 'org.matrix.msc3381.poll.response'
            ? { getRelations: () => [vote] }
            : undefined,
      },
    } as unknown as Room;

    expect(isPollStart(start)).toBe(true);
    const view = buildPollView(client, unstableRoom, start, false);
    expect(view.question).toBe('Lunch?');
    expect(view.maxSelections).toBe(1);
    expect(view.options).toEqual([
      { id: 'a0', text: 'Pizza', votes: 0, chosen: false },
      { id: 'a1', text: 'Sushi', votes: 1, chosen: true },
    ]);
  });

  it('builds a response referencing the poll', () => {
    // Unstable namespace: FluffyChat (matrix-dart-sdk) and Element only read MSC3381 keys.
    expect(pollResponseContent('$p', ['a1', 'a2'])).toEqual({
      'org.matrix.msc3381.poll.response': { answers: ['a1', 'a2'] },
      'm.relates_to': { rel_type: 'm.reference', event_id: '$p' },
    });
  });

  it('builds an end event referencing the poll', () => {
    const content = pollEndContent('$p') as Record<string, unknown>;
    expect(content['org.matrix.msc3381.poll.end']).toEqual({});
    expect(content['m.relates_to']).toEqual({
      rel_type: 'm.reference',
      event_id: '$p',
    });
  });

  // pollSignature is the re-projection cache key (timeline.service keys a poll row on
  // it). If it disagrees with buildPollView about what "ended" means, the view stops
  // re-projecting while the underlying data has actually changed — the poll renders
  // closed, with tallies that buildPollView would now count differently.
  describe('pollSignature agrees with buildPollView', () => {
    const start = startEvent('Lunch?', ['Pizza', 'Sushi']);

    it('changes when the end event is redacted (poll reopens)', () => {
      const responses = [response('@a:hs', 'a0', 10)];
      const closed = room(responses, [endEvent(5)]);
      const reopened = room(responses, [endEvent(5, true)]); // moderator redacted it

      // buildPollView already disagrees across these two rooms…
      expect(buildPollView(client, closed, start, false).ended).toBe(true);
      expect(buildPollView(client, reopened, start, false).ended).toBe(false);

      // …so the cache key must too, or the row never re-projects.
      expect(pollSignature(reopened, start, false)).not.toBe(
        pollSignature(closed, start, false),
      );
    });

    it('changes when an earlier end event shifts which votes count', () => {
      const responses = [response('@a:hs', 'a0', 10)];
      const late = room(responses, [endEvent(20)]); // vote at 10 counts
      const early = room(responses, [endEvent(5)]); // vote at 10 is post-close

      expect(buildPollView(client, late, start, false).totalVotes).not.toBe(
        buildPollView(client, early, start, false).totalVotes,
      );
      expect(pollSignature(early, start, false)).not.toBe(
        pollSignature(late, start, false),
      );
    });

    it('ignores an unauthorised end but moves for a valid one', () => {
      const responses = [response('@a:hs', 'a0', 10)];
      const open = room(responses);
      const withBogus = room(responses, [endEvent(5, false, '@x:hs')]);
      const withValid = room(responses, [endEvent(5)]);

      expect(pollSignature(withBogus, start, false)).toBe(
        pollSignature(open, start, false),
      );
      expect(pollSignature(withValid, start, false)).not.toBe(
        pollSignature(open, start, false),
      );
    });

    it('moves when the moderator who ended the poll loses redaction power', () => {
      const ends = [endEvent(5, false, '@mod:hs')];
      expect(pollSignature(room([], ends, ['@mod:hs']), start, false)).not.toBe(
        pollSignature(room([], ends), start, false),
      );
    });

    it('changes when a voter changes a non-first selection', () => {
      const before = room([response('@a:hs', ['a0', 'a1'], 10)]);
      const after = room([response('@a:hs', ['a0'], 10)]);
      expect(pollSignature(after, start, false)).not.toBe(
        pollSignature(before, start, false),
      );
    });
  });
});

describe('buildPollView in an encrypted room', () => {
  /** `event` as it reads once sent: encrypted or not, `status` null unless still sending. */
  const sent = (
    event: MatrixEvent,
    encrypted: boolean,
    status: string | null = null,
  ): MatrixEvent =>
    Object.assign(event, {
      isEncrypted: () => encrypted,
      isState: () => false,
      replacingEvent: () => null,
      status,
    });

  it('counts no vote that arrived unencrypted, and still counts the own vote being sent', () => {
    const view = buildPollView(
      client,
      room([
        sent(response('@a:hs', 'a0', 1), true),
        sent(response('@b:hs', 'a1', 2), false),
        sent(response('@c:hs', 'a1', 3), false),
        sent(response('@me:hs', 'a0', 4), false, 'sending'),
      ]),
      startEvent('Q', ['A', 'B']),
      true,
    );

    expect(view.totalVotes).toBe(2);
    expect(view.options.map((o) => o.votes)).toEqual([2, 0]);
  });

  it('keeps the poll open after an end event that arrived unencrypted', () => {
    const view = buildPollView(
      client,
      room(
        [sent(response('@a:hs', 'a0', 5), true)],
        [sent(endEvent(1), false)],
      ),
      startEvent('Q', ['A', 'B']),
      true,
    );

    expect(view.ended).toBe(false);
    expect(view.totalVotes).toBe(1);
  });

  it('moves the signature on an encrypted end after an unencrypted one, and not on the unencrypted one', () => {
    const start = startEvent('Q', ['A', 'B']);
    const vote = sent(response('@a:hs', 'a0', 5), true);
    const clearEnd = Object.assign(sent(endEvent(1), false), {
      getId: () => '$clear',
    });
    const realEnd = Object.assign(sent(endEvent(9), true), {
      getId: () => '$real',
    });

    const open = pollSignature(room([vote]), start, true);
    const clear = pollSignature(room([vote], [clearEnd]), start, true);
    const closed = pollSignature(
      room([vote], [clearEnd, realEnd]),
      start,
      true,
    );

    expect(clear).toBe(open);
    expect(closed).not.toBe(clear);
    expect(
      buildPollView(client, room([vote], [clearEnd, realEnd]), start, true)
        .ended,
    ).toBe(true);
  });

  it('ends the poll only on an end that is both encrypted and from someone who may end it', () => {
    const start = startEvent('Q', ['A', 'B']);
    const ended = (end: MatrixEvent): boolean =>
      buildPollView(client, room([], [end], ['@mod:hs']), start, true).ended;

    expect(ended(sent(endEvent(1, false, '@x:hs'), true))).toBe(false);
    expect(ended(sent(endEvent(1, false, '@mod:hs'), false))).toBe(false);
    expect(ended(sent(endEvent(1), false))).toBe(false);
    expect(ended(sent(endEvent(1, false, '@mod:hs'), true))).toBe(true);
    expect(ended(sent(endEvent(1), true))).toBe(true);
  });

  it('counts unencrypted votes and end events in a room that is not encrypted', () => {
    const view = buildPollView(
      client,
      room(
        [sent(response('@b:hs', 'a1', 0), false)],
        [sent(endEvent(1), false)],
      ),
      startEvent('Q', ['A', 'B']),
      false,
    );

    expect(view.ended).toBe(true);
    expect(view.totalVotes).toBe(1);
  });
});

describe('an edited poll', () => {
  const START = 'org.matrix.msc3381.poll.start';
  const RESPONSE = 'org.matrix.msc3381.poll.response';
  const pollContent = (question: string, answers: string[]) => ({
    [START]: {
      question: { 'org.matrix.msc1767.text': question },
      kind: 'org.matrix.msc3381.poll.disclosed',
      max_selections: 1,
      answers: answers.map((text, i) => ({
        id: `a${i}`,
        'org.matrix.msc1767.text': text,
      })),
    },
  });
  const sdkEvent = (
    id: string,
    sender: string,
    type: string,
    content: Record<string, unknown>,
    ts = 1,
  ) =>
    new SdkEvent({
      event_id: id,
      room_id: '!r:hs',
      sender,
      type,
      origin_server_ts: ts,
      content,
    });
  const editOf = (
    target: string,
    sender: string,
    type: string,
    newContent: Record<string, unknown>,
  ) =>
    sdkEvent(`${target}~${sender}`, sender, type, {
      'm.new_content': newContent,
      'm.relates_to': { rel_type: 'm.replace', event_id: target },
    });
  const start = () =>
    sdkEvent(POLL_ID, '@alice:hs', START, pollContent('Lunch?', ['Yes', 'No']));
  const roomWith = (responses: MatrixEvent[]) =>
    ({
      relations: {
        getChildEventsForEvent: (_id: string, relType: string, type: string) =>
          relType === 'm.reference' && type === RESPONSE && responses.length
            ? { getRelations: () => responses }
            : undefined,
      },
    }) as unknown as Room;

  it("shows the poll as its sender wrote it over someone else's edit", () => {
    const poll = start();
    poll.makeReplaced(
      editOf(POLL_ID, '@mallory:hs', START, pollContent('Forged?', ['Maybe'])),
    );

    const view = buildPollView(client, roomWith([]), poll, false);

    expect(view.question).toBe('Lunch?');
    expect(view.options.map((o) => o.text)).toEqual(['Yes', 'No']);
  });

  it("applies its sender's own edit", () => {
    const poll = start();
    poll.makeReplaced(
      editOf(POLL_ID, '@alice:hs', START, pollContent('Dinner?', ['Sure'])),
    );

    const view = buildPollView(client, roomWith([]), poll, false);

    expect(view.question).toBe('Dinner?');
    expect(view.options.map((o) => o.text)).toEqual(['Sure']);
  });

  it("counts a vote as its voter cast it, not as someone else's edit says", () => {
    const vote = sdkEvent(
      '$vote',
      '@bob:hs',
      RESPONSE,
      {
        [RESPONSE]: { answers: ['a0'] },
        'm.relates_to': { rel_type: 'm.reference', event_id: POLL_ID },
      },
      5,
    );
    vote.makeReplaced(
      editOf('$vote', '@mallory:hs', RESPONSE, {
        [RESPONSE]: { answers: ['a1'] },
      }),
    );
    const responses = roomWith([vote]);

    const view = buildPollView(client, responses, start(), false);

    expect(view.options.map((o) => o.votes)).toEqual([1, 0]);
    expect(pollSignature(responses, start(), false)).toContain(':a0:');
  });
});
