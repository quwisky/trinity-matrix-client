import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk';
import { describe, expect, it } from 'vitest';
import {
  buildPollView,
  isPollStart,
  pollEndContent,
  pollResponseContent,
  pollStartContent,
} from './poll';

const POLL_ID = '$poll';

function startEvent(question: string, options: string[]): MatrixEvent {
  return {
    getId: () => POLL_ID,
    getType: () => 'm.poll.start',
    getTs: () => 0,
    getContent: () => ({
      'm.poll.start': {
        question: { 'm.text': question },
        kind: 'm.poll.disclosed',
        max_selections: 1,
        answers: options.map((text, i) => ({ id: `a${i}`, 'm.text': text })),
      },
    }),
  } as unknown as MatrixEvent;
}

function response(
  sender: string,
  answer: string,
  ts: number,
  redacted = false,
): MatrixEvent {
  return {
    getSender: () => sender,
    getTs: () => ts,
    isRedacted: () => redacted,
    getContent: () => ({ 'm.poll.response': { answers: [answer] } }),
  } as unknown as MatrixEvent;
}

function endEvent(ts: number): MatrixEvent {
  return {
    getSender: () => '@me:hs',
    getTs: () => ts,
    isRedacted: () => false,
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
    const start = content['m.poll.start'];
    expect(start['kind']).toBe('m.poll.disclosed');
    expect(start['max_selections']).toBe(1);
    expect(start['answers']).toEqual([
      { id: 'a0', 'm.text': 'Apple', body: 'Apple' },
      { id: 'a1', 'm.text': 'Pear', body: 'Pear' },
    ]);
    expect(content['m.text']).toContain('Best fruit?');
  });

  it('builds a response referencing the poll', () => {
    expect(pollResponseContent('$p', 'a1')).toEqual({
      'm.poll.response': { answers: ['a1'] },
      'm.relates_to': { rel_type: 'm.reference', event_id: '$p' },
    });
  });

  it('builds an end event referencing the poll', () => {
    const content = pollEndContent('$p') as Record<string, unknown>;
    expect(content['m.poll.end']).toEqual({});
    expect(content['m.relates_to']).toEqual({
      rel_type: 'm.reference',
      event_id: '$p',
    });
  });
});
