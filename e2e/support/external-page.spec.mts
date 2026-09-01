import { describe, expect, it } from 'vitest';
import { findTriggeredExternalPage } from './external-page.mts';

interface Candidate {
  href: string;
  url(): string;
}

const candidate = (href: string): Candidate => ({
  href,
  url() {
    return this.href;
  },
});

describe('external page selection', () => {
  it('selects a page created by the trigger', () => {
    const stale = candidate('https://provider.test/previous');
    const created = candidate('about:blank');
    const before = new Map([[stale, stale.url()]]);

    expect(findTriggeredExternalPage(before, [stale, created])).toBe(created);
  });

  it('selects an existing page navigated by the trigger', () => {
    const reused = candidate('https://provider.test/previous');
    const before = new Map([[reused, reused.url()]]);

    reused.href = 'https://provider.test/next?state=fresh';

    expect(findTriggeredExternalPage(before, [reused])).toBe(reused);
  });

  it('does not select an untouched stale page', () => {
    const stale = candidate('https://provider.test/previous');
    const before = new Map([[stale, stale.url()]]);

    expect(findTriggeredExternalPage(before, [stale])).toBeUndefined();
  });
});
