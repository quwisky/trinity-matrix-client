/** One answer of a poll, with its live tally and whether the local user chose it. */
export interface PollOption {
  readonly id: string;
  readonly text: string;
  readonly votes: number;
  readonly chosen: boolean;
}

/** A projected poll (MSC3381): question, options with tallies, and whether it's closed. */
export interface PollView {
  readonly id: string;
  readonly question: string;
  readonly options: readonly PollOption[];
  /** Number of voters (a multi-select voter counts once). */
  readonly totalVotes: number;
  /** How many answers one voter may choose, at least 1. */
  readonly maxSelections: number;
  readonly ended: boolean;
}

/**
 * Content for a disclosed poll start (results visible) letting each voter choose up to
 * `maxSelections` answers, plus a plain-text fallback for clients that can't render
 * polls. Written in the unstable MSC3381/MSC1767 namespace (the `.name` of each value):
 * FluffyChat parses only those keys, and Element sends them too; we read both.
 */
export function pollStartContent(
  question: string,
  options: readonly string[],
  maxSelections = 1,
): Record<string, unknown> {
  return {
    ['org.matrix.msc3381.poll.start']: {
      question: { ['org.matrix.msc1767.text']: question, body: question },
      kind: 'org.matrix.msc3381.poll.disclosed',
      max_selections: maxSelections,
      answers: options.map((text, index) => ({
        id: `a${index}`,
        ['org.matrix.msc1767.text']: text,
        body: text,
      })),
    },
    ['org.matrix.msc1767.text']: [
      question,
      ...options.map((option, index) => `${index + 1}. ${option}`),
    ].join('\n'),
  };
}

/**
 * Content for a poll response choosing `answerIds` on `pollId` (unstable namespace).
 * An empty list withdraws the vote.
 */
export function pollResponseContent(
  pollId: string,
  answerIds: readonly string[],
): Record<string, unknown> {
  return {
    ['org.matrix.msc3381.poll.response']: { answers: [...answerIds] },
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  };
}

/** Content for a poll end closing `pollId` (unstable namespace). */
export function pollEndContent(pollId: string): Record<string, unknown> {
  return {
    ['org.matrix.msc3381.poll.end']: {},
    ['org.matrix.msc1767.text']: 'The poll has ended.',
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  };
}
