import type { SystemLineCategory } from '@trinity/data-access/timeline';
import type { MessageRow } from '../message-row/message-row.component';

type CountedCategory = SystemLineCategory | 'other';

const NOUNS: Readonly<Record<CountedCategory, readonly [string, string]>> = {
  membership: ['membership change', 'membership changes'],
  profile: ['profile change', 'profile changes'],
  room: ['room change', 'room changes'],
  other: ['change', 'changes'],
};
const ORDER: readonly CountedCategory[] = [
  'membership',
  'profile',
  'room',
  'other',
];

/** "Alice and 2 others · 3 membership changes, 1 room change". */
export function summarizeSystemRun(events: readonly MessageRow[]): string {
  const names = [...new Set(events.map((event) => event.senderName))];
  const actors =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]} and ${names.length - 1} others`;
  const counts = new Map<CountedCategory, number>();
  for (const event of events) {
    const category = event.systemCategory ?? 'other';
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const parts = ORDER.filter((category) => counts.has(category)).map(
    (category) => {
      const count = counts.get(category) ?? 0;
      const [one, many] = NOUNS[category];
      return `${count} ${count === 1 ? one : many}`;
    },
  );
  return `${actors} · ${parts.join(', ')}`;
}

function sameEvents(
  a: readonly MessageRow[],
  b: readonly MessageRow[],
): boolean {
  return a.length === b.length && a.every((event, index) => event === b[index]);
}

/**
 * Fold each run of 2+ adjacent system lines into one row. A day separator or the first
 * unread event starts a new run, so a group never hides either. The group is keyed by its
 * LAST event: back-pagination prepends to a run's start, so the id (and with it the
 * measured height, scroll anchor and expanded state) survives loading older history.
 */
export function groupSystemRuns(
  rows: readonly MessageRow[],
  firstUnreadId: string | null,
  previous: ReadonlyMap<string, MessageRow>,
): { rows: MessageRow[]; runOf: ReadonlyMap<string, string> } {
  const result: MessageRow[] = [];
  const runOf = new Map<string, string>();
  let run: MessageRow[] = [];

  const flush = () => {
    if (run.length === 1) {
      result.push(run[0]);
    } else if (run.length > 1) {
      const id = `group:${run[run.length - 1].id}`;
      const cached = previous.get(id);
      const grouped =
        cached?.systemRun && sameEvents(cached.systemRun.events, run)
          ? cached
          : groupRow(id, run);
      for (const event of run) runOf.set(event.id, id);
      result.push(grouped);
    }
    run = [];
  };

  for (const row of rows) {
    const startsRun = row.daySeparator != null || row.id === firstUnreadId;
    if (row.kind !== 'event' || startsRun) flush();
    if (row.kind === 'event') run.push(row);
    else result.push(row);
  }
  flush();
  return { rows: result, runOf };
}

function groupRow(id: string, events: readonly MessageRow[]): MessageRow {
  const summary = summarizeSystemRun(events);
  return {
    ...events[0],
    id,
    body: summary,
    summary,
    showHeader: true,
    daySeparator: events[0].daySeparator,
    systemRun: { events, summary },
  };
}
