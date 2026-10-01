import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
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
    getType: () => 'm.poll.start',
    getTs: () => 0,
    getContent: () => ({
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
    getContent: () => ({ 'm.poll.response': { answers } }),
  } as unknown as MatrixEvent;
}

function endEvent(ts: number, redacted = false): MatrixEvent {
  return {
    getSender: () => '@me:hs',
    getTs: () => ts,
    isRedacted: () => redacted,
    getContent: () => ({ 'm.poll.end': {} }),
  } as unknown as MatrixEvent;
}

/** A room whose reference relations serve the given responses / end events by type. */
function room(responses: MatrixEvent[], ends: MatrixEvent[] = []): Room {
  return {
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
    );
    expect(view.totalVotes).toBe(1);
    expect(view.options[1].votes).toBe(1);
  });

  it('marks the poll ended and ignores votes cast after it closed', () => {
    const view = buildPollView(
      client,
      room(
        [response('@a:hs', 'a0', 10), response('@b:hs', 'a1', 30)], // second is post-close
        [endEvent(20)],
      ),
      startEvent('Q', ['Apple', 'Pear']),
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
      getContent: () => ({
        'm.poll.start': { question: { 'm.text': 'Q' }, answers: 5 },
      }),
    } as unknown as MatrixEvent;

    const view = buildPollView(client, room([]), hostile);
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
    );
    expect(view.options.map((o) => o.votes)).toEqual([1, 1, 0]);
  });

  it('spoils a response naming any unknown answer id', () => {
    const view = buildPollView(
      client,
      room([response('@a:hs', ['a0', 'nope'], 10)]),
      startEvent('Q', ['A', 'B'], 2),
    );
    expect(view.totalVotes).toBe(0);
    expect(view.options.map((o) => o.votes)).toEqual([0, 0]);
  });

  it('treats an empty latest response as withdrawing the vote', () => {
    const view = buildPollView(
      client,
      room([response('@a:hs', ['a0'], 10), response('@a:hs', [], 20)]),
      startEvent('Q', ['A', 'B'], 2),
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
    );
    expect(view.maxSelections).toBe(expected);
  });

  it('caps the projected options at the MSC3381 limit (20)', () => {
    const many = Array.from({ length: 100 }, (_, i) => `opt${i}`);
    const view = buildPollView(client, room([]), startEvent('Q', many));
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
      getContent: () => pollStartContent('Lunch?', ['Pizza', 'Sushi']),
    } as unknown as MatrixEvent;
    const vote = {
      getSender: () => '@me:hs',
      getTs: () => 1,
      isRedacted: () => false,
      getContent: () => pollResponseContent(POLL_ID, ['a1']),
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
    const view = buildPollView(client, unstableRoom, start);
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
      expect(buildPollView(client, closed, start).ended).toBe(true);
      expect(buildPollView(client, reopened, start).ended).toBe(false);

      // …so the cache key must too, or the row never re-projects.
      expect(pollSignature(reopened, start)).not.toBe(
        pollSignature(closed, start),
      );
    });

    it('changes when an earlier end event shifts which votes count', () => {
      const responses = [response('@a:hs', 'a0', 10)];
      const late = room(responses, [endEvent(20)]); // vote at 10 counts
      const early = room(responses, [endEvent(5)]); // vote at 10 is post-close

      expect(buildPollView(client, late, start).totalVotes).not.toBe(
        buildPollView(client, early, start).totalVotes,
      );
      expect(pollSignature(early, start)).not.toBe(pollSignature(late, start));
    });

    it('changes when a voter changes a non-first selection', () => {
      const before = room([response('@a:hs', ['a0', 'a1'], 10)]);
      const after = room([response('@a:hs', ['a0'], 10)]);
      expect(pollSignature(after, start)).not.toBe(
        pollSignature(before, start),
      );
    });
  });
});
