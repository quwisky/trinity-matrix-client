import {
  M_POLL_END,
  M_POLL_RESPONSE,
  M_POLL_START,
  M_TEXT,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';

/**
 * Cap on poll options we project/render. MSC3381 limits a poll to 20 answers; a
 * malicious `m.poll.start` could otherwise carry an unbounded array (one rendered
 * row each), so we bound it defensively on the receive side.
 */
const MAX_POLL_ANSWERS = 20;

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
  readonly totalVotes: number;
  readonly ended: boolean;
}

/** Both namespaces (unstable `.name`, stable `.altName`) of an extensible type. */
const RESPONSE_TYPES = [M_POLL_RESPONSE.name, M_POLL_RESPONSE.altName];
const END_TYPES = [M_POLL_END.name, M_POLL_END.altName];

/** Whether an event starts a poll (either the stable or unstable type). */
export function isPollStart(event: MatrixEvent): boolean {
  return M_POLL_START.matches(event.getType());
}

/** Read extensible text (`m.text` / unstable / `body`) from a content object. */
function extensibleText(obj: Record<string, unknown> | undefined): string {
  if (!obj) {
    return '';
  }
  return (
    (obj[M_TEXT.name] as string) ??
    (obj[M_TEXT.altName] as string) ??
    (obj['body'] as string) ??
    ''
  );
}

/** The `m.poll.start` subtype from a start event's content (either namespace). */
function startSubtype(
  content: Record<string, unknown>,
): Record<string, unknown> | null {
  return (
    (content[M_POLL_START.name] as Record<string, unknown>) ??
    (content[M_POLL_START.altName] as Record<string, unknown>) ??
    null
  );
}

/** The first chosen answer id of a poll response event, or null for a blank vote. */
function responseAnswer(event: MatrixEvent): string | null {
  const content = event.getContent();
  const sub = (content[M_POLL_RESPONSE.name] ??
    content[M_POLL_RESPONSE.altName]) as { answers?: unknown[] } | undefined;
  const answers = sub?.answers;
  return Array.isArray(answers) && answers.length > 0
    ? String(answers[0])
    : null;
}

/** All child events of `pollId` for the given reference sub-types (stable + unstable). */
function referenceRelations(
  room: Room,
  pollId: string,
  types: readonly string[],
): MatrixEvent[] {
  const out: MatrixEvent[] = [];
  for (const type of types) {
    const relations = room.relations?.getChildEventsForEvent(
      pollId,
      RelationType.Reference,
      type,
    );
    if (relations) {
      out.push(...relations.getRelations());
    }
  }
  return out;
}

/**
 * Content for an `m.poll.start` (single-select, disclosed — results visible). Written
 * with the stable spec keys plus a plain-text fallback for clients that can't render polls.
 */
export function pollStartContent(
  question: string,
  options: readonly string[],
): Record<string, unknown> {
  return {
    'm.poll.start': {
      question: { 'm.text': question, body: question },
      kind: 'm.poll.disclosed',
      max_selections: 1,
      answers: options.map((text, index) => ({
        id: `a${index}`,
        'm.text': text,
        body: text,
      })),
    },
    'm.text': [
      question,
      ...options.map((option, index) => `${index + 1}. ${option}`),
    ].join('\n'),
  };
}

/** Content for an `m.poll.response` casting `answerId` on `pollId`. */
export function pollResponseContent(
  pollId: string,
  answerId: string,
): Record<string, unknown> {
  return {
    'm.poll.response': { answers: [answerId] },
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  };
}

/** Content for an `m.poll.end` closing `pollId`. */
export function pollEndContent(pollId: string): Record<string, unknown> {
  return {
    'm.poll.end': {},
    'm.text': 'The poll has ended.',
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  };
}

/**
 * Project a poll-start event into a {@link PollView}: read its question/answers and
 * tally the valid responses (each voter's latest, single-select, cast before any end
 * event). Votes for unknown answer ids are ignored. Reads the reference relations the
 * same way reactions do, so it re-tallies live as responses arrive.
 */
export function buildPollView(
  client: MatrixClient,
  room: Room,
  startEvent: MatrixEvent,
): PollView {
  const pollId = startEvent.getId() ?? '';
  const subtype = startSubtype(startEvent.getContent());
  const question = extensibleText(
    subtype?.['question'] as Record<string, unknown> | undefined,
  );
  // `answers` is attacker-controlled event content: it must be an array (a scalar
  // would throw on `.map` and, since the timeline projection isn't individually
  // guarded, crash the whole room), and it's capped so a huge array can't drive
  // unbounded rendering.
  const rawAnswers = subtype?.['answers'];
  const answers = (
    Array.isArray(rawAnswers) ? rawAnswers.slice(0, MAX_POLL_ANSWERS) : []
  ) as Array<Record<string, unknown>>;
  const optionIds = new Set(
    answers.map((a) =>
      String((a && typeof a === 'object' ? a['id'] : undefined) ?? ''),
    ),
  );

  const endTs = referenceRelations(room, pollId, END_TYPES)
    .filter((e) => !e.isRedacted())
    .reduce((min, e) => Math.min(min, e.getTs()), Number.POSITIVE_INFINITY);
  const ended = endTs !== Number.POSITIVE_INFINITY;

  // Each voter's latest valid response (single-select), ignoring post-close votes.
  const latest = new Map<string, { ts: number; answer: string }>();
  for (const event of referenceRelations(room, pollId, RESPONSE_TYPES)) {
    if (event.isRedacted() || (ended && event.getTs() > endTs)) {
      continue;
    }
    const answer = responseAnswer(event);
    if (!answer || !optionIds.has(answer)) {
      continue; // blank or spoiled vote
    }
    const sender = event.getSender() ?? '';
    const prev = latest.get(sender);
    if (!prev || event.getTs() > prev.ts) {
      latest.set(sender, { ts: event.getTs(), answer });
    }
  }

  const counts = new Map<string, number>();
  for (const { answer } of latest.values()) {
    counts.set(answer, (counts.get(answer) ?? 0) + 1);
  }
  const myAnswer = latest.get(client.getUserId() ?? '')?.answer;

  const options: PollOption[] = answers.map((answer) => {
    const id = String(answer['id'] ?? '');
    return {
      id,
      text: extensibleText(answer),
      votes: counts.get(id) ?? 0,
      chosen: id === myAnswer,
    };
  });

  return { id: pollId, question, options, totalVotes: latest.size, ended };
}

/** Fingerprint of a poll's responses + end state, for the timeline's re-projection cache. */
export function pollSignature(room: Room, startEvent: MatrixEvent): string {
  const pollId = startEvent.getId() ?? '';
  const responses = referenceRelations(room, pollId, RESPONSE_TYPES)
    .filter((e) => !e.isRedacted())
    .map((e) => `${e.getSender()}:${responseAnswer(e)}:${e.getTs()}`)
    .sort();
  // Mirror buildPollView's end handling EXACTLY: it ignores redacted end events and
  // counts only votes cast before the earliest surviving one. A signature that merely
  // asked "does any end event exist" would not move when a bogus end is redacted (the
  // poll reopens and post-close votes start counting again) or when an earlier end
  // arrives out of order (which changes the tally) — so the row would keep rendering
  // closed with stale counts until some unrelated change happened to bump the revision.
  const endTs = referenceRelations(room, pollId, END_TYPES)
    .filter((event) => !event.isRedacted())
    .reduce(
      (min, event) => Math.min(min, event.getTs()),
      Number.POSITIVE_INFINITY,
    );
  const ended = endTs === Number.POSITIVE_INFINITY ? '' : `ended:${endTs}`;
  return [...responses, ended].join('|');
}
