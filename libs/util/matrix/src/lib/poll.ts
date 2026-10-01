import {
  M_POLL_END,
  M_POLL_KIND_DISCLOSED,
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
  /** Number of voters (a multi-select voter counts once). */
  readonly totalVotes: number;
  /** How many answers one voter may choose, at least 1. */
  readonly maxSelections: number;
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

/** The raw answer ids of a poll response event (empty for a blank or malformed vote). */
function responseAnswers(event: MatrixEvent): string[] {
  const content = event.getContent();
  const sub = (content[M_POLL_RESPONSE.name] ??
    content[M_POLL_RESPONSE.altName]) as { answers?: unknown } | undefined;
  const answers = sub?.answers;
  return Array.isArray(answers) ? answers.map(String) : [];
}

/**
 * A poll's `max_selections` as a whole number in `[1, answerCount]`; anything else
 * (absent, non-numeric, below 1) means single-select, as matrix-js-sdk treats it.
 */
function maxSelectionsOf(raw: unknown, answerCount: number): number {
  return Number.isInteger(raw) && (raw as number) > 0
    ? Math.min(raw as number, Math.max(answerCount, 1))
    : 1;
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
    [M_POLL_START.name]: {
      question: { [M_TEXT.name]: question, body: question },
      kind: M_POLL_KIND_DISCLOSED.name,
      max_selections: maxSelections,
      answers: options.map((text, index) => ({
        id: `a${index}`,
        [M_TEXT.name]: text,
        body: text,
      })),
    },
    [M_TEXT.name]: [
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
    [M_POLL_RESPONSE.name]: { answers: [...answerIds] },
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  };
}

/** Content for a poll end closing `pollId` (unstable namespace). */
export function pollEndContent(pollId: string): Record<string, unknown> {
  return {
    [M_POLL_END.name]: {},
    [M_TEXT.name]: 'The poll has ended.',
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  };
}

/**
 * Project a poll-start event into a {@link PollView}: read its question/answers and
 * tally each voter's latest response cast before any end event. As in matrix-js-sdk, a
 * response naming any unknown answer id is spoiled, and a valid one is de-duplicated
 * and truncated to `max_selections`; a spoiled or empty latest response withdraws the
 * voter's earlier vote. Reads the reference relations the
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
  const maxSelections = maxSelectionsOf(
    subtype?.['max_selections'],
    answers.length,
  );

  const endTs = referenceRelations(room, pollId, END_TYPES)
    .filter((e) => !e.isRedacted())
    .reduce((min, e) => Math.min(min, e.getTs()), Number.POSITIVE_INFINITY);
  const ended = endTs !== Number.POSITIVE_INFINITY;

  // Each voter's latest response, ignoring post-close votes.
  const latest = new Map<string, { ts: number; answers: string[] }>();
  for (const event of referenceRelations(room, pollId, RESPONSE_TYPES)) {
    if (event.isRedacted() || (ended && event.getTs() > endTs)) {
      continue;
    }
    const sender = event.getSender() ?? '';
    const prev = latest.get(sender);
    if (!prev || event.getTs() > prev.ts) {
      latest.set(sender, {
        ts: event.getTs(),
        answers: responseAnswers(event),
      });
    }
  }

  const counts = new Map<string, number>();
  let voters = 0;
  let mine = new Set<string>();
  for (const [sender, { answers: raw }] of latest) {
    if (raw.length === 0 || raw.some((id) => !optionIds.has(id))) {
      continue; // blank or spoiled vote
    }
    const chosen = new Set([...new Set(raw)].slice(0, maxSelections));
    voters++;
    for (const id of chosen) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (sender === client.getUserId()) {
      mine = chosen;
    }
  }

  const options: PollOption[] = answers.map((answer) => {
    const id = String(answer['id'] ?? '');
    return {
      id,
      text: extensibleText(answer),
      votes: counts.get(id) ?? 0,
      chosen: mine.has(id),
    };
  });

  return {
    id: pollId,
    question,
    options,
    totalVotes: voters,
    maxSelections,
    ended,
  };
}

/** Fingerprint of a poll's responses + end state, for the timeline's re-projection cache. */
export function pollSignature(room: Room, startEvent: MatrixEvent): string {
  const pollId = startEvent.getId() ?? '';
  const responses = referenceRelations(room, pollId, RESPONSE_TYPES)
    .filter((e) => !e.isRedacted())
    .map((e) => `${e.getSender()}:${responseAnswers(e).join(',')}:${e.getTs()}`)
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
