import { describe, expect, it } from 'vitest';
import { latestGuard } from './latest-guard';

describe('latestGuard', () => {
  it('drops a result whose work was superseded', async () => {
    const latest = latestGuard();
    const applied: string[] = [];
    const run = async (value: string, delay: number) => {
      const token = latest.next();
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (latest.isCurrent(token)) applied.push(value);
    };
    await Promise.all([run('old', 20), run('new', 5)]);
    expect(applied).toEqual(['new']);
  });

  it('keeps the newest of several overlapping calls current', () => {
    const latest = latestGuard();
    const a = latest.next();
    const b = latest.next();
    const c = latest.next();
    expect([a, b, c].map((t) => latest.isCurrent(t))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('makes every outstanding token stale on invalidate', () => {
    const latest = latestGuard();
    const token = latest.next();
    latest.invalidate();
    expect(latest.isCurrent(token)).toBe(false);
  });

  it('never revives a token issued before invalidate', () => {
    const latest = latestGuard();
    const before = latest.next();
    latest.invalidate();
    const after = latest.next();
    expect(latest.isCurrent(before)).toBe(false);
    expect(latest.isCurrent(after)).toBe(true);
  });
});
