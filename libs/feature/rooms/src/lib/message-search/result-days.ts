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

/** Formats a month, with its year when asked, in the reader's language. */
export type MonthLabel = (ts: number, withYear: boolean) => string;

/** "Today", "Yesterday", "Last week" for the six days before, then the month. */
export function resultDayLabel(
  ts: number,
  now: number,
  month: MonthLabel,
): string {
  const today = startOfLocalDay(now);
  const days = daysBefore(ts, today);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Last week';
  return month(ts, new Date(ts).getFullYear() !== new Date(now).getFullYear());
}

/**
 * One group per day label, newest first. Sorted here because server search orders by rank,
 * which can split one day's hits around another's.
 */
export function groupResultsByDay<T extends { readonly ts: number }>(
  hits: readonly T[],
  now: number,
  month: MonthLabel,
): ResultGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const hit of [...hits].sort((a, b) => b.ts - a.ts)) {
    const label = resultDayLabel(hit.ts, now, month);
    const group = groups.get(label);
    if (group) {
      group.push(hit);
    } else {
      groups.set(label, [hit]);
    }
  }
  return [...groups].map(([label, hits]) => ({ label, hits }));
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
