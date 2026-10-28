import { describe, expect, it } from 'vitest';
import { pollEndContent, pollResponseContent, pollStartContent } from './poll';

describe('poll content', () => {
  it('pollStartContent writes the unstable MSC3381 start with a text fallback', () => {
    expect(pollStartContent('Lunch?', ['Pizza', 'Soup'], 2)).toEqual({
      'org.matrix.msc3381.poll.start': {
        question: { 'org.matrix.msc1767.text': 'Lunch?', body: 'Lunch?' },
        kind: 'org.matrix.msc3381.poll.disclosed',
        max_selections: 2,
        answers: [
          { id: 'a0', 'org.matrix.msc1767.text': 'Pizza', body: 'Pizza' },
          { id: 'a1', 'org.matrix.msc1767.text': 'Soup', body: 'Soup' },
        ],
      },
      'org.matrix.msc1767.text': 'Lunch?\n1. Pizza\n2. Soup',
    });
  });

  it('pollStartContent defaults to one selection', () => {
    expect(
      pollStartContent('Q', ['A'])['org.matrix.msc3381.poll.start'],
    ).toMatchObject({ max_selections: 1 });
  });

  it('pollResponseContent references the poll with the chosen answers', () => {
    expect(pollResponseContent('$poll', ['a1'])).toEqual({
      'org.matrix.msc3381.poll.response': { answers: ['a1'] },
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
    });
  });

  it('pollEndContent references the poll with a text fallback', () => {
    expect(pollEndContent('$poll')).toEqual({
      'org.matrix.msc3381.poll.end': {},
      'org.matrix.msc1767.text': 'The poll has ended.',
      'm.relates_to': { rel_type: 'm.reference', event_id: '$poll' },
    });
  });
});
