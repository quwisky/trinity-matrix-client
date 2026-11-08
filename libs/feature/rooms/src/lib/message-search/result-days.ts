import { startOfLocalDay } from '@trinity/util/matrix';

/** Results from one stretch of time, newest first. */
export interface ResultGroup<T> {
  readonly label: string;
  readonly hits: readonly T[];
}

/** Days of local calendar before `today`: 0 today, 1 yesterday. Day starts, not 24h steps. */
function daysBefore(ts: number, today: number): number {
  let day = startOfLocalDay(ts);
  let count = 0;
  while (day < today && count < 8) {
    day = startOfLocalDay(day + 36 * 3_600_000);
    count++;
  }
  return count;
}

/** "Today", "Yesterday", "Last week" for the six days before, then the month. */
export function resultDayLabel(ts: number, now: number): string {
  const today = startOfLocalDay(now);
  const days = daysBefore(ts, today);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Last week';
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, {
    month: 'long',
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: 'numeric' }),
  });
}

/** Runs of consecutive hits that share a day label; the hits arrive newest first. */
export function groupResultsByDay<T extends { readonly ts: number }>(
  hits: readonly T[],
  now: number,
): ResultGroup<T>[] {
  const groups: { label: string; hits: T[] }[] = [];
  for (const hit of hits) {
    const label = resultDayLabel(hit.ts, now);
    const last = groups.at(-1);
    if (last?.label === label) {
      last.hits.push(hit);
    } else {
      groups.push({ label, hits: [hit] });
    }
  }
  return groups;
}

/** Whether a result's time reads as a clock (today, yesterday) or a weekday (the week before). */
export function resultTimeStyle(
  ts: number,
  now: number,
): 'time' | 'weekday' | 'date' {
  const days = daysBefore(ts, startOfLocalDay(now));
  if (days <= 1) return 'time';
  return days < 7 ? 'weekday' : 'date';
}
