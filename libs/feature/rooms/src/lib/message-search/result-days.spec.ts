import { describe, expect, it } from 'vitest';
import {
  groupResultsByDay,
  resultDayLabel,
  resultTimeStyle,
} from './result-days';

const at = (y: number, m: number, d: number, h = 12) =>
  new Date(y, m, d, h).getTime();
const month = (ts: number, withYear: boolean) =>
  new Intl.DateTimeFormat('en', {
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(ts);

describe('search result days', () => {
  const now = at(2026, 10, 8, 9);

  it('names today, yesterday, the week before and then the month', () => {
    expect(resultDayLabel(at(2026, 10, 8, 1), now, month)).toBe('Today');
    expect(resultDayLabel(at(2026, 10, 7, 23), now, month)).toBe('Yesterday');
    expect(resultDayLabel(at(2026, 10, 2), now, month)).toBe('Last week');
    expect(resultDayLabel(at(2026, 10, 1), now, month)).toBe('November');
    expect(resultDayLabel(at(2025, 3, 1), now, month)).toBe('April 2025');
  });

  it('counts calendar days across a daylight-saving change, not 24-hour steps', () => {
    // 1 November 2026 is the US fall-back day; locally it may be 25 hours long.
    const after = at(2026, 10, 2, 0);
    expect(resultDayLabel(at(2026, 10, 1, 1), after, month)).toBe('Yesterday');
  });

  it('gives each label one group, newest first, when hits arrive out of order', () => {
    // Server search orders by rank, so one day's hits can come apart.
    const groups = groupResultsByDay(
      [
        { id: 'a', ts: at(2026, 10, 8, 7) },
        { id: 'b', ts: at(2026, 10, 4) },
        { id: 'c', ts: at(2026, 10, 8, 8) },
      ],
      now,
      month,
    );
    expect(groups.map((g) => [g.label, g.hits.map((h) => h.id)])).toEqual([
      ['Today', ['c', 'a']],
      ['Last week', ['b']],
    ]);
  });

  it('groups consecutive hits that share a label', () => {
    const groups = groupResultsByDay(
      [
        { id: 'a', ts: at(2026, 10, 8, 8) },
        { id: 'b', ts: at(2026, 10, 8, 7) },
        { id: 'c', ts: at(2026, 10, 4) },
      ],
      now,
      month,
    );
    expect(groups.map((g) => [g.label, g.hits.map((h) => h.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Last week', ['c']],
    ]);
  });

  it('shows a clock for today and yesterday, a weekday for the week before', () => {
    expect(resultTimeStyle(at(2026, 10, 8, 1), now)).toBe('time');
    expect(resultTimeStyle(at(2026, 10, 7), now)).toBe('time');
    expect(resultTimeStyle(at(2026, 10, 4), now)).toBe('weekday');
    expect(resultTimeStyle(at(2026, 9, 1), now)).toBe('date');
  });
});
